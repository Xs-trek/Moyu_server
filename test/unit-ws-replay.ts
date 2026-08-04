// §6: reliable WebSocket seq + ack. Covers the per-session bounded event ring buffer,
// afterSeq reconnect replay, pending-approval retention (never lost to ring overflow), last
// terminal-turn retention, the WS-layer backpressure CLOSE (replaces the old silent-drop), and
// per-connection ACK tracking (duplicate/stale/out-of-order acks are no-ops).
// Offline: mock adapter (0 quota, 0 network); real WS server+client for connection-level cases.
// Run: npx tsx test/unit-ws-replay.ts
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import { SessionManager } from '../src/session/manager';
import { AdapterManager } from '../src/adapters/manager';
import {
  attachWs,
  send as wsSend,
  AckTracker,
  NetNotifier,
  MAX_BUFFERED_BYTES,
  CLOSE_BACKPRESSURE,
} from '../src/api/ws';
import { findFreePort } from '../src/gateway/ports';
import type {
  Adapter,
  AdapterEvent,
  AuthProfile,
  SessionHandle,
  SessionOpts,
} from '../src/adapters/types';
import type { ServerContext } from '../src/context';
import type { WsEventEnvelope } from '../src/session/manager';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ FAIL: ${name}`);
  }
}

// ---------- mock adapter with per-session emit handle ----------
class MockHandle implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef: string;
  private cbs = new Set<(e: AdapterEvent) => void>();
  constructor(opts: SessionOpts) {
    this.sessionId = opts.sessionId;
    this.cliSessionRef = opts.cliSessionRef ?? opts.sessionId;
    handles.set(this.sessionId, this);
  }
  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.cbs.add(cb);
    return () => {
      this.cbs.delete(cb);
    };
  }
  emit(e: AdapterEvent): void {
    for (const cb of this.cbs) cb(e);
  }
  async send(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async history(): Promise<never[]> {
    return [];
  }
  async resolveApproval(): Promise<void> {}
  async dispose(): Promise<void> {
    this.cbs.clear();
    handles.delete(this.sessionId);
  }
}
const handles = new Map<string, MockHandle>();
function emitTo(sid: string, e: AdapterEvent): void {
  handles.get(sid)?.emit(e);
}
const adapter: Adapter = {
  kind: 'claude',
  displayName: 'mock',
  capabilities: {
    streaming: { text: true, thinking: false, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: false,
    approval: { transport: 'native', semantics: 'native', policies: [] },
    configuration: { model: false, effortLevels: [], sandboxModes: [], reviewers: [] },
  },
  async isAvailable() {
    return true;
  },
  async detect() {
    return { adapter: 'claude', mode: 'none', hasCredentials: false } as AuthProfile;
  },
  async startSession(opts: SessionOpts) {
    return new MockHandle(opts);
  },
};

// ---------- Part A: manager ring buffer + afterSeq replay (offline) ----------
{
  const adapters = new AdapterManager();
  adapters.register(adapter);
  const mgr = new SessionManager(adapters);
  const sid = await mgr.create('claude', {});

  emitTo(sid, { type: 'turn.started' }); // seq 1
  emitTo(sid, { type: 'text.done', text: 'hi' }); // seq 2
  emitTo(sid, { type: 'tool.start', toolCallId: 't1', tool: 'Bash', input: {} }); // seq 3

  // afterSeq=0 -> replay all three, sorted by seq.
  let r = mgr.subscribe(sid, () => {}, 0).replay;
  check('A: afterSeq=0 replays all 3', r.length === 3 && r[0].seq === 1 && r[2].seq === 3);
  // afterSeq=2 -> only seq 3.
  r = mgr.subscribe(sid, () => {}, 2).replay;
  check('A: afterSeq=2 replays only seq>2', r.length === 1 && r[0].seq === 3);
  // afterSeq=99 (past all) -> empty.
  r = mgr.subscribe(sid, () => {}, 99).replay;
  check('A: afterSeq past end -> empty replay', r.length === 0);

  // Pending approval retention: emit an approval.request, then overflow the 256-event ring.
  emitTo(sid, {
    type: 'approval.request',
    approvalId: 'a1',
    kind: 'command',
    summary: 'echo hi',
    choices: ['allow', 'allow_session', 'deny', 'cancel'],
  }); // seq 4
  for (let i = 0; i < 300; i++) {
    emitTo(sid, { type: 'tool.start', toolCallId: 'flood' + i, tool: 'Bash', input: {} });
  } // seq 5..304 -> ring overflows, drops oldest (incl. seq 4 from the ring)
  r = mgr.subscribe(sid, () => {}, 0).replay;
  check(
    'A: pending approval replayed despite ring overflow (never lost)',
    r.some((e) => e.event.type === 'approval.request' && e.event.approvalId === 'a1'),
  );
  // Replay is sorted by seq; the approval (seq 4) precedes the retained ring tail.
  const apSeq = r.find((e) => e.event.type === 'approval.request')!.seq;
  check('A: replay sorted by seq (approval seq < ring tail)', apSeq < r[r.length - 1].seq);

  // approval.resolved removes it from pending -> no longer replayed once ring has dropped it.
  emitTo(sid, { type: 'approval.resolved', approvalId: 'a1', decision: 'allow' });
  r = mgr.subscribe(sid, () => {}, 0).replay;
  check(
    'A: resolved approval removed from pending replay',
    !r.some((e) => e.event.type === 'approval.request' && e.event.approvalId === 'a1'),
  );

  // Last terminal turn retention: emit turn.completed, overflow ring, replay keeps it.
  emitTo(sid, { type: 'turn.completed' }); // some seq
  for (let i = 0; i < 300; i++) {
    emitTo(sid, { type: 'tool.start', toolCallId: 'flood2' + i, tool: 'Bash', input: {} });
  }
  r = mgr.subscribe(sid, () => {}, 0).replay;
  check(
    'A: last terminal turn replayed despite ring overflow (never lost)',
    r.some((e) => e.event.type === 'turn.completed'),
  );

  // Live delivery: a subscriber receives events emitted AFTER subscribe.
  const live: WsEventEnvelope[] = [];
  mgr.subscribe(sid, (env) => live.push(env), 0);
  emitTo(sid, { type: 'text.done', text: 'live event' });
  check('A: live event delivered to subscriber', live.some((e) => e.event.type === 'text.done'));

  await mgr.dispose(sid);
}

// ---------- Part B: AckTracker (duplicate / stale / out-of-order ACK) ----------
{
  const a = new AckTracker();
  a.ack(5);
  check('B: ack advances to 5', a.seq === 5);
  a.ack(5);
  check('B: duplicate ack is a no-op', a.seq === 5);
  a.ack(3);
  check('B: stale (lower) ack is a no-op', a.seq === 5);
  a.ack(undefined);
  check('B: undefined ack is a no-op', a.seq === 5);
  a.ack(7);
  check('B: higher ack advances', a.seq === 7);
  a.reset(10);
  check('B: reset re-seeds', a.seq === 10);
  a.ack(2);
  check('B: stale after reset is a no-op', a.seq === 10);
  a.reset();
  check('B: reset() defaults to 0', a.seq === 0);
}

// ---------- Part C: send() backpressure = close, never silent drop (slow client) ----------
{
  let sent = 0;
  let closed: number | null = null;
  const overMock = {
    readyState: WebSocket.OPEN,
    bufferedAmount: MAX_BUFFERED_BYTES + 1,
    send: () => {
      sent++;
    },
    close: (code: number) => {
      closed = code;
    },
  } as unknown as WebSocket;
  wsSend(overMock, { type: 'event', seq: 1 });
  check('C: backpressure -> no send (no silent drop into the void)', sent === 0);
  check('C: backpressure -> close with CLOSE_BACKPRESSURE', closed === CLOSE_BACKPRESSURE);

  let sent2 = 0;
  let closed2: number | null = null;
  const underMock = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: () => {
      sent2++;
    },
    close: (code: number) => {
      closed2 = code;
    },
  } as unknown as WebSocket;
  wsSend(underMock, { type: 'event', seq: 2 });
  check('C: under threshold -> send', sent2 === 1);
  check('C: under threshold -> no close', closed2 === null);

  // Not-open -> no send, no close (graceful no-op, not a silent drop).
  let sent3 = 0;
  const closedMock = { readyState: WebSocket.CLOSED, bufferedAmount: 0, send: () => sent3++, close: () => {} } as unknown as WebSocket;
  wsSend(closedMock, { type: 'event', seq: 3 });
  check('C: not-open -> no send', sent3 === 0);
}

// ---------- Part D: real WS server reconnect replay + approval replay ----------
async function partD(): Promise<void> {
  const adapters = new AdapterManager();
  adapters.register(adapter);
  const mgr = new SessionManager(adapters);
  const port = await findFreePort(19100, 19199, '127.0.0.1');
  const ctx = { config: { token: 't' }, sessions: mgr, netNotifier: new NetNotifier() } as unknown as ServerContext;
  const httpServer: Server = createServer();
  attachWs(ctx, httpServer);
  await new Promise<void>((r) => httpServer.listen(port, '127.0.0.1', r));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function openWs(): Promise<{ ws: WebSocket; events: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?token=t`);
      const events: any[] = [];
      ws.on('message', (raw) => {
        try {
          events.push(JSON.parse(raw.toString()));
        } catch {
          /* ignore */
        }
      });
      ws.on('open', () => resolve({ ws, events }));
      ws.on('error', reject);
    });
  }
  function waitFor(events: any[], pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const f = events.find(pred);
        if (f) return resolve(f);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(tick, 15);
      };
      tick();
    });
  }

  try {
    // --- D1: reconnect replay with afterSeq ---
    const sid = await mgr.create('claude', {});
    emitTo(sid, { type: 'turn.started' }); // seq 1
    emitTo(sid, { type: 'text.done', text: 'first' }); // seq 2
    emitTo(sid, { type: 'tool.start', toolCallId: 't1', tool: 'Bash', input: {} }); // seq 3

    const c1 = await openWs();
    c1.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid, afterSeq: 0 }));
    await waitFor(c1.events, (e) => e.type === 'ack' && e.ackType === 'subscribed');
    await waitFor(c1.events, (e) => e.type === 'event' && e.seq === 3); // replay delivered 1,2,3
    // Client acks up to seq 2 (seq 3 left unacked).
    c1.ws.send(JSON.stringify({ type: 'ack', seq: 2 }));
    await sleep(30);
    c1.ws.close();

    // Server emits more while client is disconnected: seq 4, 5.
    emitTo(sid, { type: 'text.done', text: 'second' }); // seq 4
    emitTo(sid, { type: 'turn.completed' }); // seq 5

    // Reconnect with afterSeq=2 (the acked seq). Replay must be seq 3,4,5 (not 1,2).
    const c2 = await openWs();
    c2.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid, afterSeq: 2 }));
    await waitFor(c2.events, (e) => e.type === 'ack' && e.ackType === 'subscribed');
    await waitFor(c2.events, (e) => e.type === 'event' && e.seq === 5);
    const replaySeqs = c2.events.filter((e) => e.type === 'event').map((e) => e.seq).sort((a, b) => a - b);
    check('D1: reconnect replays unacked tail (3,4,5)', JSON.stringify(replaySeqs) === JSON.stringify([3, 4, 5]));
    check('D1: reconnect does NOT re-send acked prefix (1,2)', !replaySeqs.includes(1) && !replaySeqs.includes(2));
    c2.ws.close();

    // --- D2: pending approval replayed on a fresh subscribe (ring overflow) ---
    const sid2 = await mgr.create('claude', {});
    emitTo(sid2, {
      type: 'approval.request',
      approvalId: 'apD2',
      kind: 'command',
      summary: 'rm -rf',
      choices: ['allow', 'allow_session', 'deny', 'cancel'],
    }); // seq 1
    for (let i = 0; i < 300; i++) {
      emitTo(sid2, { type: 'tool.start', toolCallId: 'f' + i, tool: 'Bash', input: {} });
    } // overflow ring -> approval dropped from ring, retained in pendingApprovals
    const c3 = await openWs();
    c3.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid2, afterSeq: 0 }));
    const ap = await waitFor(c3.events, (e) => e.type === 'event' && e.event?.type === 'approval.request');
    check('D2: pending approval replayed on subscribe after ring overflow', !!ap && ap.event.approvalId === 'apD2');
    c3.ws.close();

    // --- D3: duplicate ACK does not regress / lose events ---
    // Subscribe fresh, receive seq 1, ack it twice + a stale ack, then reconnect with that
    // acked seq -> replay must be empty for the acked prefix (no re-send, no loss).
    const sid3 = await mgr.create('claude', {});
    emitTo(sid3, { type: 'turn.started' }); // seq 1
    const c4 = await openWs();
    c4.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid3, afterSeq: 0 }));
    await waitFor(c4.events, (e) => e.type === 'event' && e.seq === 1);
    c4.ws.send(JSON.stringify({ type: 'ack', seq: 1 })); // ack
    c4.ws.send(JSON.stringify({ type: 'ack', seq: 1 })); // duplicate
    c4.ws.send(JSON.stringify({ type: 'ack', seq: 0 })); // stale
    await sleep(30);
    c4.ws.close();
    // Reconnect with afterSeq=1 -> replay empty (seq 1 already acked, nothing newer).
    const c5 = await openWs();
    c5.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid3, afterSeq: 1 }));
    await waitFor(c5.events, (e) => e.type === 'ack' && e.ackType === 'subscribed');
    await sleep(120);
    const reSeqs = c5.events.filter((e) => e.type === 'event').map((e) => e.seq);
    check('D3: after duplicate/stale acks, reconnect replay is empty (no re-send, no loss)', reSeqs.length === 0);
    c5.ws.close();

    await mgr.disposeAll();
  } finally {
    httpServer.close();
  }
}
await partD();

console.log(`\n${fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED'} (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
