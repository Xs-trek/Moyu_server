// WebSocket /api/v1/ws. Subscribe to a session, stream events (I10), receive
// input/approval/interrupt. A Bearer header is verified at upgrade (S1).
import type { Server } from 'node:http';
import type { ServerContext } from '../context';
import { WebSocketServer, WebSocket } from 'ws';
import { extractBearer, verifyToken } from '../gateway/auth';
import { log } from '../util/logger';
import type { ApprovalDecision } from '../adapters/types';
import type { NetStatus } from '../net/types';
import { toClientFailure } from './failure';

// Resource bounds (review P2 + §6): cap inbound frame size; on send backpressure, CLOSE the
// connection with an explicit code (never silently drop) so the client reconnects and replays
// unacked events from the per-session ring buffer; reject oversized input text.
export const MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB per WS frame
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // 4MB send-buffer backpressure cap
export const MAX_INPUT_TEXT_CHARS = 256 * 1024; // 256KB user input text cap (shared with REST /input, N6)
// §6: application close code forcing the client to reconnect + replay (not a standard WS code).
export const CLOSE_BACKPRESSURE = 4011;

export interface NetSnapshot {
  net: NetStatus;
  overlay: unknown;
}
export interface NetChangeNotification {
  type: 'net_change';
  seq: number;
  snapshot: NetSnapshot;
}

export class NetNotifier {
  private seq = 0;
  private latest: NetChangeNotification | null = null;
  private wss: WebSocketServer | null = null;

  attach(wss: WebSocketServer): void {
    this.wss = wss;
  }

  async broadcast(snapshot: NetSnapshot): Promise<void> {
    this.seq += 1;
    const msg: NetChangeNotification = { type: 'net_change', seq: this.seq, snapshot };
    this.latest = msg;
    if (!this.wss) return;
    for (const ws of this.wss.clients) {
      send(ws, msg);
    }
    log.debug('net_change broadcast', { seq: this.seq, clients: this.wss.clients.size });
  }

  current(): NetChangeNotification | null {
    return this.latest;
  }
}

export function attachWs(ctx: ServerContext, server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  ctx.netNotifier.attach(wss);

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/v1/ws')) {
      socket.destroy();
      return;
    }
    const token = extractBearer(req);
    if (!verifyToken(token, ctx.config.token ?? '')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => handleConnection(ctx, ws));
  return wss;
}

/** §6: send one framed message, OR force-reconnect on send backpressure (never silent drop).
 *  Exported so the backpressure-close contract (no silent drop, explicit close code) is unit-tested. */
export function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  // §6: replace the old silent-drop. On send backpressure (slow client can't drain), CLOSE
  // the connection with an explicit code so the client reconnects and replays unacked events
  // from the per-session ring buffer. Silent drops lost approval.request/turn.completed.
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    forceReconnect(ws, 'backpressure');
    return;
  }
  ws.send(JSON.stringify(obj));
}

/** §6: close the connection with an application code that tells the client to reconnect and
 *  replay from its last acked seq. Idempotent. */
function forceReconnect(ws: WebSocket, reason: string): void {
  log.warn('ws force reconnect (client must replay)', { reason });
  try {
    ws.close(CLOSE_BACKPRESSURE, reason);
  } catch {
    // best-effort
  }
}

interface ClientMessage {
  type: 'subscribe' | 'input' | 'approval' | 'interrupt' | 'pty_input' | 'pty_resize' | 'ack' | 'ping';
  sessionId?: string;
  text?: string;
  approvalId?: string;
  decision?: ApprovalDecision;
  seq?: number;
  /** §6: client's last acked seq, sent on (re)subscribe so the server replays unacked events. */
  afterSeq?: number;
  data?: string;
  cols?: number;
  rows?: number;
  clientTs?: number;
}

function isClientMessage(value: unknown): value is ClientMessage {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string';
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (value === 'allow' || value === 'allow_session' || value === 'deny' || value === 'cancel') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outer = value as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !Object.prototype.hasOwnProperty.call(outer, 'allowWithModification')) return false;
  const modification = outer.allowWithModification;
  if (!modification || typeof modification !== 'object' || Array.isArray(modification)) return false;
  const mod = modification as Record<string, unknown>;
  if (Object.keys(mod).length !== 1 || !Object.prototype.hasOwnProperty.call(mod, 'answers')) return false;
  const answers = mod.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  const entries = Object.entries(answers as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) return false;
  let totalChars = 0;
  for (const [question, answer] of entries) {
    if (!question || question.length > 2_000) return false;
    totalChars += question.length;
    if (typeof answer === 'string') {
      if (!answer || answer.length > 2_000) return false;
      totalChars += answer.length;
    } else if (Array.isArray(answer)) {
      if (answer.length < 1 || answer.length > 20) return false;
      for (const selected of answer) {
        if (typeof selected !== 'string' || !selected || selected.length > 2_000) return false;
        totalChars += selected.length;
      }
    } else {
      return false;
    }
    if (totalChars > 16_000) return false;
  }
  return true;
}

function badMessage(ws: WebSocket, summary: string): void {
  send(ws, { type: 'error', code: 'bad_message', retryable: false, summary });
}

/**
 * §6: per-connection monotonic-max ack tracker. Processes the client's ack.seq: advances to the
 * max seq acked so far; duplicate, stale, and out-of-order acks are no-ops (the max never
 * regresses). On (re)subscribe it is re-seeded from the client's afterSeq. Exported so the
 * duplicate/stale/out-of-order ACK contract is unit-tested directly.
 */
export class AckTracker {
  private max = 0;
  ack(seq: number | undefined): void {
    if (typeof seq === 'number' && seq > this.max) this.max = seq;
  }
  /** Re-seed on (re)subscribe from the client's last acked seq. */
  reset(to = 0): void {
    this.max = to;
  }
  get seq(): number {
    return this.max;
  }
}

function handleConnection(ctx: ServerContext, ws: WebSocket): void {
  let unsubscribe: (() => void) | null = null;
  // §6: per-connection max acked seq. Seeded from the client's afterSeq on (re)subscribe;
  // advanced as the client acks. On a force-reconnect the client re-subscribes with this seq.
  const ack = new AckTracker();
  // §10: on (re)connect, push the latest net snapshot so a reconnecting client re-fetches the
  // current network state without waiting for the next change. Dedup by seq on the client.
  const latest = ctx.netNotifier.current();
  if (latest) send(ws, latest);

  ws.on('message', async (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', code: 'bad_json' });
      return;
    }
    if (!isClientMessage(parsed)) {
      badMessage(ws, 'message must be an object with a type');
      return;
    }
    const msg = parsed;
    try {
      switch (msg.type) {
        case 'subscribe': {
          if (typeof msg.sessionId !== 'string' || !msg.sessionId ||
              (msg.afterSeq !== undefined && !isNonNegativeInt(msg.afterSeq))) {
            badMessage(ws, 'subscribe requires sessionId and a non-negative integer afterSeq');
            break;
          }
          if (unsubscribe) unsubscribe();
          // §6: resume from the client's last acked seq. The manager returns the replay tail
          // (unacked events + pending approvals + last terminal turn); we send it FIRST,
          // synchronously, so order is preserved before any live event arrives on a later tick.
          const afterSeq = msg.afterSeq ?? 0;
          ack.reset(afterSeq);
          const { replay, unsub } = ctx.sessions.subscribe(
            msg.sessionId,
            (env) => send(ws, env),
            afterSeq,
          );
          unsubscribe = unsub;
          const replayStatus = ctx.sessions.replayStatus(msg.sessionId, afterSeq);
          for (const env of replay) send(ws, env);
          send(ws, {
            type: 'ack',
            ackType: 'subscribed',
            sessionId: msg.sessionId,
            replay: { requestedAfterSeq: afterSeq, ...replayStatus },
          });
          break;
        }
        case 'input': {
          if (typeof msg.sessionId !== 'string' || !msg.sessionId || typeof msg.text !== 'string' || !msg.text) {
            badMessage(ws, 'input requires sessionId and non-empty text');
            break;
          }
          if (msg.text.length > MAX_INPUT_TEXT_CHARS) {
            send(ws, { type: 'error', code: 'input_too_large', retryable: false, summary: `text exceeds ${MAX_INPUT_TEXT_CHARS} chars` });
            break;
          }
          await ctx.sessions.send(msg.sessionId, { text: msg.text });
          break;
        }
        case 'approval': {
          // [L] SECURITY CAVEAT: any authenticated WS client can resolve ANY session's approval
          // (no subscription/ownership check; same for input/interrupt). In a multi-phone setup
          // (multiple paired clients) one phone can decide another's approvals. Single-phone
          // default is unaffected. Per-connection subscription gating is an access-control change
          // left to an explicit decision (out of scope under the no-extend-security-model constraint).
          if (typeof msg.sessionId !== 'string' || !msg.sessionId ||
              typeof msg.approvalId !== 'string' || !msg.approvalId ||
              !isApprovalDecision(msg.decision)) {
            badMessage(ws, 'approval requires sessionId, approvalId and a valid decision');
            break;
          }
          await ctx.sessions.resolveApproval(msg.sessionId, msg.approvalId, msg.decision);
          break;
        }
        case 'interrupt': {
          if (typeof msg.sessionId !== 'string' || !msg.sessionId) {
            badMessage(ws, 'interrupt requires sessionId');
            break;
          }
          await ctx.sessions.interrupt(msg.sessionId);
          break;
        }
        case 'ack':
          // §6: process the client's ack of an event seq. AckTracker records the monotonic max;
          // duplicate / out-of-order / stale acks are no-ops. On a later force-reconnect the
          // client re-subscribes with this seq as afterSeq.
          if (!isNonNegativeInt(msg.seq)) {
            badMessage(ws, 'ack requires a non-negative integer seq');
            break;
          }
          ack.ack(msg.seq);
          break;
        case 'ping':
          if (msg.clientTs !== undefined && (typeof msg.clientTs !== 'number' || !Number.isFinite(msg.clientTs))) {
            badMessage(ws, 'ping clientTs must be a finite number');
            break;
          }
          send(ws, { type: 'pong', clientTs: msg.clientTs, serverTs: Date.now() });
          break;
        case 'pty_input':
        case 'pty_resize':
          // A4 PTY not yet wired
          send(ws, { type: 'error', code: 'pty_not_available' });
          break;
        default:
          send(ws, { type: 'error', code: 'unknown_message' });
      }
    } catch (e) {
      const failure = toClientFailure(e);
      send(ws, { type: 'error', code: failure.code, retryable: failure.retryable, category: failure.category, summary: failure.summary });
    }
  });

  ws.on('close', () => {
    if (unsubscribe) unsubscribe();
  });
  ws.on('error', (e) => log.warn('ws error', { err: String(e) }));
}
