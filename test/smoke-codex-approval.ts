// Smoke test: codex approval round-trip + text.done persistence, against real
// codex 0.146.0 on the VM. #1: codex runs in `codex exec --json` mode; approvals
// route through a PreToolUse COMMAND hook (localhost relay -> gateway -> phone), NOT the
// app-server requestApproval RPC. Under approvalPolicy=untrusted the hook fires
// before WRITE commands (touch); `echo` is read-only and may auto-run.
// Validates:
//   turn 1 (pure text "PONG") -> text.done persistence (safety-net flush).
//   turn 2 (`touch .rd-approval-a.tmp` -> allow) -> toCodexHook(allow) + executes.
//   turn 3 (`touch .rd-approval-b.tmp` -> deny)  -> toCodexHook(deny) + NO execution.
// VM-SMOKE (#1): hook `-c` injection [A], hook firing under exec [B], JSONL shape [C],
//   resume form [D], config key names [F].
// Run on VM: PATH="$HOME/.local/npm-global/bin:$PATH" npx tsx test/smoke-codex-approval.ts
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config/loader';
import { findFreePort } from '../src/gateway/ports';
import { startServer } from '../src/gateway/server';
import { AdapterManager } from '../src/adapters/manager';
import { SessionManager } from '../src/session/manager';
import { HookRegistry } from '../src/api/hooks';
import { createCodexAdapter } from '../src/adapters/codex/adapter';
import { AccountService } from '../src/accounts/service';
import { EasyTierController } from '../src/net/easytier';
import { PairingService } from '../src/net/pairing';
import { NetNotifier } from '../src/api/ws';
import type { ServerContext } from '../src/context';
import { WebSocket } from 'ws';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  // Defaults (untrusted + workspace-write) force approval for WRITE commands.
  config.adapters.codex.approvalPolicy = 'untrusted';
  config.adapters.codex.sandbox = 'workspace-write';

  const port = await findFreePort(config.gateway.portMin, config.gateway.portMax, config.gateway.bindHost);
  const adapters = new AdapterManager();
  const hooks = new HookRegistry();
  const sessions = new SessionManager(adapters);
  adapters.register(createCodexAdapter({ port, hooks, approvalTimeoutSec: config.approvalTimeoutSec, adapterConfig: config.adapters.codex }));
  const pairing = new PairingService(() => config, port);
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

  console.log('=== create codex session (sandbox=workspace-write, approvalPolicy=untrusted) ===');
  const created = (await (
    await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'codex' }),
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
  let textDoneText: string | null = null;
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
      } else if (ev.type === 'text.done') {
        textDoneText = (textDoneText ?? '') + ev.text;
        console.log('  >> text.done:', String(ev.text).slice(0, 120));
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

  const waitTurn = (ms: number) =>
    Promise.race([turnDeferred.promise, sleep(ms).then(() => { throw new Error('turn timeout'); })]);
  const waitForApproval = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (!approvalId && Date.now() < deadline) await sleep(200);
    return approvalId;
  };

  // Turn 1: pure text -> validates text.done persistence (safety-net at turn/completed).
  console.log('\n=== turn 1: pure text (expect PONG; validates text.done) ===');
  textDoneText = null;
  ws.send(JSON.stringify({ type: 'input', sessionId, text: 'Reply with exactly the word: PONG' }));
  try { await waitTurn(90000); } catch (e) { console.log('  !!', String(e)); }
  console.log('events:', eventTypes.splice(0).join(','));
  console.log('text.done captured:', JSON.stringify(textDoneText));
  const hist1 = await (await fetch(`${base}/api/v1/sessions/${sessionId}/messages`, { headers: H })).json();
  console.log('history roles:', (hist1 as { role: string }[]).map((m) => m.role).join(','));

  // Turn 2: command -> allow (validates toCodexHook allow + tool round-trip).
  console.log('\n=== turn 2: echo hello -> allow (validates allow) ===');
  turnDeferred = new Deferred<void>();
  approvalId = null;
  textDoneText = null;
  ws.send(
    JSON.stringify({
      type: 'input',
      sessionId,
      text: 'Run exactly this shell command: touch .rd-approval-a.tmp  (then confirm it ran).',
    }),
  );
  const aid2 = await waitForApproval(90000);
  if (aid2) {
    console.log('  -> sending allow for', aid2);
    ws.send(JSON.stringify({ type: 'approval', sessionId, approvalId: aid2, decision: 'allow' }));
  } else {
    console.log('  !! no approval.request received (read-only did not force approval)');
  }
  try { await waitTurn(90000); } catch (e) { console.log('  !!', String(e)); }
  console.log('events:', eventTypes.splice(0).join(','));

  // Turn 3: command -> deny (validates toCodexHook deny + no execution).
  console.log('\n=== turn 3: echo world -> deny (validates deny) ===');
  turnDeferred = new Deferred<void>();
  approvalId = null;
  textDoneText = null;
  ws.send(JSON.stringify({ type: 'input', sessionId, text: 'Run exactly this shell command: touch .rd-approval-b.tmp' }));
  const aid3 = await waitForApproval(90000);
  if (aid3) {
    console.log('  -> sending deny for', aid3);
    ws.send(JSON.stringify({ type: 'approval', sessionId, approvalId: aid3, decision: 'deny' }));
  } else {
    console.log('  !! no approval.request received');
  }
  try { await waitTurn(90000); } catch (e) { console.log('  !!', String(e)); }
  console.log('events:', eventTypes.splice(0).join(','));

  ws.close();
  // Cleanup test artifacts (only a.tmp should exist; b.tmp was denied -> not created).
  try {
    rmSync('.rd-approval-a.tmp', { force: true });
    rmSync('.rd-approval-b.tmp', { force: true });
    console.log('cleaned up .rd-approval-{a,b}.tmp');
  } catch (e) { console.log('cleanup note:', String(e)); }
  console.log('\nSMOKE APPROVAL DONE');
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke error', e);
  process.exit(1);
});
