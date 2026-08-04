// Smoke test: claude adapter end-to-end via the real gateway.
// 1) /server/info  2) simple turn (no tool)  3) approval turn (Bash) + resume.
// Run: npx tsx test/smoke-claude.ts
import { loadConfig } from '../src/config/loader';
import { findFreePort } from '../src/gateway/ports';
import { startServer } from '../src/gateway/server';
import { AdapterManager } from '../src/adapters/manager';
import { SessionManager } from '../src/session/manager';
import { HookRegistry } from '../src/api/hooks';
import { PairingService } from '../src/net/pairing';
import { createClaudeAdapter } from '../src/adapters/claude/adapter';
import { AccountService } from '../src/accounts/service';
import { EasyTierController } from '../src/net/easytier';
import { NetNotifier } from '../src/api/ws';
import type { ServerContext } from '../src/context';
import { WebSocket } from 'ws';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Deferred<T = void> {
  resolve!: (v: T) => void;
  reject!: (e: unknown) => void;
  promise: Promise<T>;
  constructor() {
    this.promise = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = await findFreePort(config.gateway.portMin, config.gateway.portMax, config.gateway.bindHost);
  const adapters = new AdapterManager();
  const hooks = new HookRegistry();
  const sessions = new SessionManager(adapters);
  const pairing = new PairingService(() => config, port);
  adapters.register(createClaudeAdapter({ port, approvalTimeoutSec: config.approvalTimeoutSec, hooks, adapterConfig: config.adapters.claude }));
  const ctx: ServerContext = {
    config,
    adapters,
    sessions,
    hooks,
    port,
    startedAt: new Date().toISOString(),
    net: { async getStatus() { return { status: 'stub' }; } },
    overlay: new EasyTierController(config.network),
    accounts: new AccountService(),
    pairing,
    netNotifier: new NetNotifier(),
    requestShutdown: () => {},
  };
  await startServer(ctx);
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const token = config.token ?? '';
  const H = { authorization: `Bearer ${token}` };

  console.log('\n=== 1. /server/info ===');
  const info = await (await fetch(`${base}/api/v1/server/info`, { headers: H })).json();
  console.log(JSON.stringify(info, null, 2).slice(0, 600));

  console.log('\n=== 2. create session ===');
  const created = (await (
    await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'claude' }),
    })
  ).json()) as { sessionId: string };
  const sessionId = created.sessionId;
  console.log('sessionId:', sessionId);

  const ws = new WebSocket(`${wsBase}/api/v1/ws?token=${token}`);
  await new Promise<void>((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));

  const eventTypes: string[] = [];
  let approvalId: string | null = null;
  let turnDeferred = new Deferred<void>();

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'event') {
      eventTypes.push(m.event.type);
      const ev = m.event;
      if (ev.type === 'approval.request') {
        approvalId = ev.approvalId;
        console.log('  >> approval.request:', ev.tool, '|', ev.summary);
      } else if (ev.type === 'tool.start') {
        console.log('  >> tool.start:', ev.tool, JSON.stringify(ev.input).slice(0, 140));
      } else if (ev.type === 'tool.output') {
        console.log('  >> tool.output:', String(ev.text ?? '').slice(0, 140));
      } else if (ev.type === 'text.delta' && ev.text) {
        process.stdout.write(ev.text);
      } else if (ev.type === 'turn.completed') {
        console.log('\n  >> turn.completed', JSON.stringify(ev.usage ?? {}));
        turnDeferred.resolve();
      } else if (ev.type === 'turn.failed') {
        console.log('\n  >> turn.failed:', ev.category, ev.summary);
        turnDeferred.resolve();
      }
    }
  });

  const waitTurn = (ms: number) => Promise.race([turnDeferred.promise, sleep(ms).then(() => { throw new Error('turn timeout'); })]);

  // --- simple turn ---
  console.log('\n=== 3. simple turn (expect PONG) ===');
  ws.send(JSON.stringify({ type: 'input', sessionId, text: 'Reply with exactly the word: PONG' }));
  try { await waitTurn(60000); } catch (e) { console.log('  !!', String(e)); }
  console.log('events:', eventTypes.splice(0).join(','));
  const hist = await (await fetch(`${base}/api/v1/sessions/${sessionId}/messages`, { headers: H })).json();
  console.log('history roles:', (hist as { role: string }[]).map((m) => m.role).join(','));

  // --- approval turn (Bash) ---
  console.log('\n=== 4. approval turn (Bash echo hello; resume) ===');
  turnDeferred = new Deferred<void>();
  approvalId = null;
  ws.send(
    JSON.stringify({
      type: 'input',
      sessionId,
      text: 'Use the Bash tool to run: echo hello  -- then tell me the output in one short sentence.',
    }),
  );
  const approvalDeadline = Date.now() + 60000;
  while (!approvalId && Date.now() < approvalDeadline) await sleep(200);
  if (approvalId) {
    console.log('  -> sending allow for', approvalId);
    ws.send(JSON.stringify({ type: 'approval', sessionId, approvalId, decision: 'allow' }));
  } else {
    console.log('  !! no approval.request received (turn may not use a tool, or resume failed)');
  }
  try { await waitTurn(60000); } catch (e) { console.log('  !!', String(e)); }
  console.log('events:', eventTypes.splice(0).join(','));

  ws.close();
  console.log('\nSMOKE DONE');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e);
  process.exit(1);
});
