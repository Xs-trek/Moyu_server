// §10 I7 network change notification tests: NetNotifier (monotonic seq, latest retention,
// broadcast to attached clients, no-clients/before-attach safe) + EasyTierController
// onStateChange fires on state transitions (start->not-configured, stop->stopped).
import { WebSocket } from 'ws';
import { NetNotifier } from '../src/api/ws';
import { EasyTierController, type OverlayState } from '../src/net/easytier';
import type { NetworkConfig } from '../src/config/schema';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ' ' + detail : ''}`); }
}

function mockWs(): { ws: any; sent: any[] } {
  const sent: any[] = [];
  return {
    ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string) => sent.push(d), close: () => {} },
    sent,
  };
}

const netCfg = (overrides: Partial<NetworkConfig> = {}): NetworkConfig => ({
  publicNode: '',
  privateMode: true,
  networkSecret: 'sec',
  networkName: 't',
  ...overrides,
} as NetworkConfig);

async function main(): Promise<void> {
  // --- A. current() null before first broadcast ---
  const n = new NetNotifier();
  ok('A: current() null before first broadcast', n.current() === null);

  // --- B. broadcast before attach: latest retained, no throw, seq starts at 1 ---
  await n.broadcast({ net: { probed: false }, overlay: { status: 'stopped' } });
  const cur1 = n.current()!;
  ok('B: latest retained after pre-attach broadcast', cur1 !== null);
  ok('B: seq starts at 1', cur1.seq === 1, `(seq=${cur1.seq})`);
  ok('B: snapshot carried', cur1.snapshot.net.probed === false && cur1.snapshot.overlay.status === 'stopped');

  // --- C. attach + broadcast reaches all open clients, seq monotonic ---
  const a = mockWs();
  const b = mockWs();
  n.attach({ clients: new Set([a.ws, b.ws]) } as any);
  await n.broadcast({ net: { probed: true }, overlay: { status: 'running' } });
  ok('C: client A received message', a.sent.length === 1, `(sent=${a.sent.length})`);
  ok('C: client B received message', b.sent.length === 1);
  const msgA = JSON.parse(a.sent[0]);
  ok('C: message type net_change', msgA.type === 'net_change');
  ok('C: seq monotonic (2)', msgA.seq === 2, `(seq=${msgA.seq})`);
  ok('C: snapshot matches', msgA.snapshot.overlay.status === 'running');
  ok('C: latest updated', n.current()!.seq === 2);

  // --- D. non-open client skipped (readyState != OPEN); latest still retained ---
  const c = mockWs();
  c.ws.readyState = WebSocket.CLOSING;
  const n2 = new NetNotifier();
  n2.attach({ clients: new Set([c.ws]) } as any);
  await n2.broadcast({ net: {}, overlay: { status: 'stopped' } });
  ok('D: non-open client skipped (no send)', c.sent.length === 0, `(sent=${c.sent.length})`);
  ok('D: latest still retained', n2.current() !== null);

  // --- E. EasyTierController onStateChange: start()->not-configured, stop()->stopped ---
  const ctrl = new EasyTierController(netCfg({ publicNode: '' }));
  const captured: OverlayState[] = [];
  ctrl.onStateChange((s) => captured.push({ ...s }));
  // Constructor state ('stopped') was set BEFORE the listener was registered, so the first
  // captured transition is the start() -> not-configured change.
  await ctrl.start();
  const ncState = captured.find((s) => s.status === 'not-configured');
  ok('E: start() -> onStateChange fired not-configured', !!ncState, `(states=${captured.map((s) => s.status).join(',')})`);
  ok('E: not-configured has error', typeof ncState?.error === 'string' && ncState!.error.length > 0);
  ok('E: first captured is not-configured (not constructor stopped)', captured[0]?.status === 'not-configured');
  await ctrl.stop();
  const stoppedState = captured.find((s) => s.status === 'stopped');
  ok('E: stop() -> onStateChange fired stopped', !!stoppedState, `(states=${captured.map((s) => s.status).join(',')})`);

  // --- F. Full wiring: overlay onStateChange -> listener -> NetNotifier.broadcast -> WS client.
  // Uses publicNode:'' so start() resolves to not-configured WITHOUT spawning easytier-core
  // (a real binary exists in bin/win-x64; spawning a live overlay has no place in a unit test).
  // The listener replicates server.ts: await net snapshot, then broadcast to all clients.
  const ctrl2 = new EasyTierController(netCfg({ publicNode: '' }));
  const notifier = new NetNotifier();
  const client = mockWs();
  notifier.attach({ clients: new Set([client.ws]) } as any);
  ctrl2.onStateChange(async (overlay) => {
    try {
      const net = { probed: false, source: 'stand-in' } as Record<string, unknown>;
      await notifier.broadcast({ net, overlay });
    } catch {
      /* listener must not throw into the setter */
    }
  });
  await ctrl2.start(); // -> not-configured (no publicNode, no spawn)
  // The listener is async (awaits the net snapshot); let it drain.
  await new Promise((r) => setTimeout(r, 50));
  ok('F: mock client received net_change', client.sent.length >= 1, `(sent=${client.sent.length})`);
  if (client.sent.length >= 1) {
    const m = JSON.parse(client.sent[0]);
    ok('F: net_change type', m.type === 'net_change');
    ok('F: overlay.status not-configured', m.snapshot.overlay.status === 'not-configured', `(status=${m.snapshot.overlay.status})`);
    ok('F: net snapshot carried', m.snapshot.net.source === 'stand-in');
  }

  console.log(`\nNET-NOTIFY: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
