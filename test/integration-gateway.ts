// OFFLINE gateway integration test (v0.0.2 simulation).
// Spins up the REAL gateway (startServer) with MOCK adapters (no real CLI, 0 quota,
// 0 network) and exercises the full REST + WS surface + approval bridge end-to-end.
// Validates: REST routes, WS protocol, event->message persistence, approval flow
// (allow/deny/interrupt), multi-subscribe, auth, config sanitization, hook fail-closed.
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findFreePort } from '../src/gateway/ports';
import { startServer } from '../src/gateway/server';
import { AdapterManager } from '../src/adapters/manager';
import { SessionManager } from '../src/session/manager';
import { HookRegistry } from '../src/api/hooks';
import { PairingService } from '../src/net/pairing';
import { AccountService } from '../src/accounts/service';
import { EasyTierController } from '../src/net/easytier';
import { NetNotifier } from '../src/api/ws';
import type { AppConfig } from '../src/config/schema';
import type { ServerContext } from '../src/context';
import type {
  Adapter,
  AdapterEvent,
  ApprovalDecision,
  AuthProfile,
  ReasoningEffort,
  SessionHandle,
  SessionOpts,
} from '../src/adapters/types';
import { createInboundPolicy, type NetStatus } from '../src/net/types';
import { ArtifactStore } from '../src/artifacts/store';

// ---------- mock adapter ----------
class MockSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef?: string;
  readonly model?: string;
  effort?: ReasoningEffort;
  private cbs = new Set<(e: AdapterEvent) => void>();
  private resolvers = new Map<string, (d: ApprovalDecision) => void>();
  private interrupted = false;
  constructor(opts: SessionOpts) {
    this.sessionId = opts.sessionId;
    this.cliSessionRef = opts.cliSessionRef;
    this.model = opts.model;
    this.effort = opts.effort;
  }
  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.cbs.add(cb);
    return () => { this.cbs.delete(cb); };
  }
  private emit(e: AdapterEvent): void {
    for (const cb of this.cbs) cb(e);
  }
  async send(): Promise<void> {
    void this.runTurn();
  }
  private async runTurn(): Promise<void> {
    if (this.interrupted) return;
    this.emit({ type: 'turn.started' });
    this.emit({ type: 'text.delta', text: 'Hello ' });
    this.emit({ type: 'text.delta', text: 'from mock' });
    this.emit({ type: 'text.done', text: 'Hello from mock' });
    this.emit({ type: 'tool.start', toolCallId: 'tc1', tool: 'Bash', input: { command: 'echo hello' } });
    const approvalId = randomUUID();
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.resolvers.set(approvalId, resolve);
      this.emit({
        type: 'approval.request',
        approvalId,
        kind: 'command',
        tool: 'Bash',
        input: { command: 'echo hello' },
        summary: 'echo hello',
        choices: ['allow', 'allow_session', 'deny', 'cancel'],
      });
    });
    if (this.interrupted) {
      this.emit({ type: 'turn.failed', category: 'unknown', summary: 'interrupted' });
      return;
    }
    this.emit({ type: 'approval.resolved', approvalId, decision });
    const denied = decision === 'deny' || decision === 'cancel';
    if (!denied) this.emit({ type: 'tool.output', toolCallId: 'tc1', text: 'hello\n' });
    this.emit({ type: 'tool.done', toolCallId: 'tc1', isError: denied });
    this.emit({ type: 'turn.completed', usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001 });
  }
  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const r = this.resolvers.get(approvalId);
    if (r) { this.resolvers.delete(approvalId); r(decision); }
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
    for (const r of this.resolvers.values()) r('cancel');
    this.resolvers.clear();
  }
  async history(): Promise<never[]> { return []; }
  async setEffort(effort?: ReasoningEffort): Promise<void> { this.effort = effort; }
  async dispose(): Promise<void> { this.cbs.clear(); }
}

class MockAdapter implements Adapter {
  readonly kind: 'claude' | 'codex';
  readonly displayName: string;
  readonly capabilities: Adapter['capabilities'];
  constructor(kind: 'claude' | 'codex', displayName: string) {
    this.kind = kind;
    this.displayName = displayName;
    this.capabilities = {
      streaming: { text: true, thinking: true, tools: true },
      resume: true,
      interrupt: true,
      accountProfiles: true,
      approval: {
        transport: 'command-hook',
        semantics: 'remote-every-tool-or-never',
        policies: ['untrusted', 'never'],
      },
      configuration: {
        effortLevels: ['low', 'medium', 'high'],
        permissionModes: ['plan', 'auto', 'acceptEdits'],
        model: true,
        modelSelection: 'freeform',
        sandboxModes: kind === 'codex' ? ['workspace-write'] : [],
        reviewers: kind === 'codex' ? ['user'] : [],
      },
    };
  }
  async isAvailable(): Promise<boolean> { return true; }
  async detect(): Promise<AuthProfile> {
    return { adapter: this.kind, mode: 'authToken+BaseUrl', hasCredentials: true, baseUrlPresent: true };
  }
  async startSession(opts: SessionOpts): Promise<SessionHandle> { return new MockSessionHandle(opts); }
}

// ---------- test harness ----------
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ' ' + detail : ''}`); }
}

async function api(port: number, token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  return { status: res.status, body: json, text };
}

interface WsCollector { ws: WebSocket; events: any[]; }
function openWs(port: number, token: string): Promise<WsCollector> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const events: any[] = [];
    ws.on('open', () => resolve({ ws, events }));
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    ws.on('error', (e) => reject(e));
  });
}
function waitFor(events: any[], pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const f = events.find(pred);
      if (f) return resolve(f);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout: ' + pred.toString()));
      setTimeout(tick, 15);
    };
    tick();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const token = 'test-token-fixed';
  const controlToken = 'pc-only-control-fixed';
  const nativeRoot = mkdtempSync(join(tmpdir(), 'moyu-native-integration-'));
  const claudeConfigDir = join(nativeRoot, 'claude');
  const codexConfigDir = join(nativeRoot, 'codex');
  const nativeClaudeId = '44444444-4444-4444-8444-444444444444';
  const nativeClaudeOlderId = '55555555-5555-4555-8555-555555555555';
  const nativeClaudeProject = join(claudeConfigDir, 'projects', 'D--native');
  mkdirSync(nativeClaudeProject, { recursive: true });
  mkdirSync(codexConfigDir, { recursive: true });
  writeFileSync(join(claudeConfigDir, 'settings.json'), JSON.stringify({
    model: 'opus',
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-integration' },
  }));
  writeFileSync(join(codexConfigDir, 'config.toml'), 'model = "gpt-integration"\n');
  writeFileSync(join(nativeClaudeProject, `${nativeClaudeId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-08-09T01:00:00.000Z', cwd: process.cwd(), message: { role: 'user', content: 'native hello' } }),
    '{bad json',
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-09T01:00:01.000Z', cwd: process.cwd(), message: { id: 'native-a1', role: 'assistant', model: 'glm-integration', content: [{ type: 'text', text: 'native reply' }] } }),
    JSON.stringify({ type: 'ai-title', sessionId: nativeClaudeId, aiTitle: 'Native integration session' }),
  ].join('\n') + '\n');
  writeFileSync(join(nativeClaudeProject, `${nativeClaudeOlderId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-08-08T01:00:00.000Z', cwd: process.cwd(), message: { role: 'user', content: 'older native hello' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-08T01:00:01.000Z', cwd: process.cwd(), message: { id: 'native-a2', role: 'assistant', model: 'glm-integration', content: [{ type: 'text', text: 'older native reply' }] } }),
  ].join('\n') + '\n');
  const config: AppConfig = {
    gateway: { portMin: 19000, portMax: 19099, bindHost: '127.0.0.1' },
    network: { publicNode: 'tcp://test.example:11010', privateMode: true, networkSecret: 'sec', networkName: 'rd-test' },
    defaultAdapter: 'claude',
    approvalTimeoutSec: 120,
    logLevel: 'warn',
    ptyAddon: { enabled: false },
    adapters: {
      claude: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', configDir: claudeConfigDir },
      codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', configDir: codexConfigDir },
    },
    token,
    controlToken,
  } as AppConfig;

  const port = await findFreePort(19000, 19099, '127.0.0.1');
  const adapters = new AdapterManager();
  adapters.register(new MockAdapter('claude', 'claude (mock)'));
  adapters.register(new MockAdapter('codex', 'codex (mock)'));
  const artifacts = new ArtifactStore();
  const sessions = new SessionManager(adapters, artifacts);
  const hooks = new HookRegistry();
  const accounts = new AccountService();
  const mockNetStatus: NetStatus = {
    profile: { ipv6GuaAvailable: false, inboundFirewallDefault: 'unknown', natType: 'unknown', clash: null },
    publicNode: null,
    verdict: { publicNode: null, overall: 'unknown', rationale: ['mock'] },
    inboundPolicy: createInboundPolicy('127.0.0.1', '10.1.1.10/32'),
    checkedAt: new Date().toISOString(),
  };
  const net = { getStatus: async () => mockNetStatus, refresh: async () => mockNetStatus };
  const overlay = new EasyTierController(config.network);
  const pairing = new PairingService(() => config, port);
  const shutdownRequests: string[] = [];

  const ctx: ServerContext = {
    config, adapters, sessions, artifacts, hooks, port,
    startedAt: new Date().toISOString(), net, overlay, accounts, pairing,
    netNotifier: new NetNotifier(),
    requestShutdown: (reason) => { shutdownRequests.push(reason); },
  };
  const server: Server = await startServer(ctx);

  try {
    ok('gateway has explicit bounded HTTP timeouts', server.headersTimeout === 15_000 &&
      server.requestTimeout === 120_000 && server.keepAliveTimeout === 5_000 && server.maxHeadersCount === 100);
    // 1. auth: no token -> 401
    const noTok = await fetch(`http://127.0.0.1:${port}/api/v1/server/info`);
    ok('auth: missing token -> 401', noTok.status === 401, `(got ${noTok.status})`);

    // 2. /server/info
    const info = await api(port, token, 'GET', '/api/v1/server/info');
    ok('GET /server/info -> 200', info.status === 200, `(got ${info.status})`);
    ok('/server/info has adapters', Array.isArray((info.body as any)?.adapters) && (info.body as any).adapters.length === 2);
    ok('/server/info defaultAdapter=claude', (info.body as any)?.defaultAdapter === 'claude');
    ok('/server/info exposes adapter capabilities', (info.body as any)?.adapters?.[0]?.capabilities?.streaming?.tools === true);
    const claudeInfo = (info.body as any)?.adapters?.find((adapter: any) => adapter.kind === 'claude');
    const codexInfo = (info.body as any)?.adapters?.find((adapter: any) => adapter.kind === 'codex');
    ok('/server/info projects local effective/default models without a provider catalog',
      claudeInfo?.effectiveModel === 'glm-integration' && claudeInfo?.cliDefaultModel === 'glm-integration' &&
      claudeInfo?.modelOverride === undefined && claudeInfo?.capabilities?.configuration?.modelSelection === 'freeform');
    ok('/server/info preserves adapter configuration arrays',
      claudeInfo?.capabilities?.configuration?.sandboxModes?.length === 0 &&
      claudeInfo?.capabilities?.configuration?.reviewers?.length === 0 &&
      codexInfo?.capabilities?.configuration?.sandboxModes?.[0] === 'workspace-write' &&
      codexInfo?.capabilities?.configuration?.reviewers?.[0] === 'user');
    const nativeClaudeProfile = (info.body as any)?.accountSwitching?.adapters?.claude?.profiles
      ?.find((profile: any) => profile.sourceKind === 'nativeDefault');
    ok('/server/info account projection carries profile-local model metadata',
      nativeClaudeProfile?.cliDefaultModel === 'glm-integration' && nativeClaudeProfile?.effectiveModel === 'glm-integration');

    // Valid 1x1 PNG with a tEXt chunk that would identify the frontend/device if forwarded.
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAGnRFWHRTb2Z0d2FyZQBBbmRyb2lkIEdQUyBQaG9uZdNNxGUAAAANSURBVHicY/jPwPAfAAUAAf+JmT0dAAAAAElFTkSuQmCC', 'base64');
    const sanitizedImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    const artifactUpload = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts?name=screen.png`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      body: imageBytes,
    });
    const artifactRef = await artifactUpload.json() as any;
    ok('POST /artifacts stores a bounded metadata-sanitized image', artifactUpload.status === 201 &&
      typeof artifactRef?.artifactId === 'string' && artifactRef?.mime === 'image/png' && artifactRef?.size === sanitizedImageBytes.length);
    const artifactDownload = await fetch(`http://127.0.0.1:${port}/api/v1/artifacts/${artifactRef.artifactId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const downloadedBytes = Buffer.from(await artifactDownload.arrayBuffer());
    ok('GET /artifacts returns pixels without frontend metadata', artifactDownload.status === 200 &&
      downloadedBytes.equals(sanitizedImageBytes) && !downloadedBytes.includes(Buffer.from('Android GPS Phone')));

    const nativeBadLimit = await api(port, token, 'GET', '/api/v1/native-sessions?limit=0');
    ok('GET /native-sessions rejects out-of-range limit', nativeBadLimit.status === 400, `(got ${nativeBadLimit.status})`);
    const nativeBadOffset = await api(port, token, 'GET', '/api/v1/native-sessions?offset=-1');
    ok('GET /native-sessions rejects negative offset', nativeBadOffset.status === 400, `(got ${nativeBadOffset.status})`);
    const nativeExcessiveOffset = await api(port, token, 'GET', '/api/v1/native-sessions?offset=4001');
    ok('GET /native-sessions rejects excessive offset', nativeExcessiveOffset.status === 400, `(got ${nativeExcessiveOffset.status})`);
    const nativeList = await api(port, token, 'GET', '/api/v1/native-sessions?limit=10');
    const nativeItem = (nativeList.body as any)?.items?.find((item: any) => item.nativeSessionId === nativeClaudeId);
    ok('GET /native-sessions -> bounded native item', nativeList.status === 200 && nativeItem?.model === 'glm-integration' &&
      (nativeList.body as any)?.hasMore === false && typeof (nativeList.body as any)?.nextOffset === 'number');
    const nativeFirstPage = await api(port, token, 'GET', '/api/v1/native-sessions?limit=1&offset=0');
    const nativeFirstBody = nativeFirstPage.body as any;
    const nativeSecondPage = await api(port, token, 'GET', `/api/v1/native-sessions?limit=1&offset=${nativeFirstBody?.nextOffset}`);
    const nativeSecondBody = nativeSecondPage.body as any;
    const pagedNativeIds = [nativeFirstBody?.items?.[0]?.nativeSessionId, nativeSecondBody?.items?.[0]?.nativeSessionId];
    ok('GET /native-sessions first page exposes continuation', nativeFirstPage.status === 200 &&
      nativeFirstBody?.items?.length === 1 && nativeFirstBody?.hasMore === true && nativeFirstBody?.nextOffset === 1);
    ok('GET /native-sessions nextOffset reaches older distinct item and terminates', nativeSecondPage.status === 200 &&
      nativeSecondBody?.items?.length === 1 && nativeSecondBody?.hasMore === false &&
      new Set(pagedNativeIds).size === 2 && pagedNativeIds.includes(nativeClaudeId) && pagedNativeIds.includes(nativeClaudeOlderId));
    const nativeMessages = await api(port, token, 'GET', `/api/v1/native-sessions/claude/${nativeClaudeId}/messages?after=0&limit=1`);
    ok('GET native messages -> cursor object', nativeMessages.status === 200 &&
      Array.isArray((nativeMessages.body as any)?.items) && (nativeMessages.body as any).items.length === 1 &&
      (nativeMessages.body as any)?.hasMore === true && (nativeMessages.body as any)?.nextAfter === 1);
    const nativeResume = await api(port, token, 'POST', `/api/v1/native-sessions/claude/${nativeClaudeId}/resume`);
    const nativeSid = (nativeResume.body as any)?.sessionId;
    ok('POST native resume -> manager session', nativeResume.status === 201 && typeof nativeSid === 'string' &&
      (nativeResume.body as any)?.session?.cliSessionRef === nativeClaudeId &&
      (nativeResume.body as any)?.session?.model === 'glm-integration');
    const seeded = await api(port, token, 'GET', `/api/v1/sessions/${nativeSid}/messages`);
    ok('resumed manager session is seeded with normalized native messages', seeded.status === 200 &&
      Array.isArray(seeded.body) && (seeded.body as any[]).map((message) => message.text).join(',') === 'native hello,native reply');

    // PC daemon lifecycle requires a second, never-paired control secret. Possession of the
    // phone's normal bearer alone must not permit stopping the backend.
    const exitBearerOnly = await api(port, token, 'POST', '/api/v1/admin/exit');
    ok('POST /admin/exit with phone bearer only -> 403', exitBearerOnly.status === 403, `(got ${exitBearerOnly.status})`);
    const exitWrongControl = await fetch(`http://127.0.0.1:${port}/api/v1/admin/exit`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Moyu-Control': 'wrong' },
    });
    ok('POST /admin/exit with wrong local control -> 403', exitWrongControl.status === 403, `(got ${exitWrongControl.status})`);
    const exitAccepted = await fetch(`http://127.0.0.1:${port}/api/v1/admin/exit`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Moyu-Control': controlToken },
    });
    await sleep(0);
    ok('POST /admin/exit with both secrets -> 202', exitAccepted.status === 202, `(got ${exitAccepted.status})`);
    ok('/admin/exit delegates graceful shutdown once', shutdownRequests.join(',') === 'cli-exit');
    const pairStatusBearerOnly = await api(port, token, 'GET', '/api/v1/pair/status');
    ok('GET /pair/status with phone bearer only -> 403', pairStatusBearerOnly.status === 403, `(got ${pairStatusBearerOnly.status})`);
    const pairStatusLocal = await fetch(`http://127.0.0.1:${port}/api/v1/pair/status`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Moyu-Control': controlToken },
    });
    ok('GET /pair/status with PC control -> 200', pairStatusLocal.status === 200, `(got ${pairStatusLocal.status})`);

    // 3. POST /sessions (claude)
    const create = await api(port, token, 'POST', '/api/v1/sessions', {
      kind: 'claude', title: 'sim', profileId: 'claude:native', model: 'mock-model',
    });
    ok('POST /sessions -> 201', create.status === 201, `(got ${create.status})`);
    const sid = (create.body as any)?.sessionId;
    ok('POST /sessions returns sessionId', typeof sid === 'string');
    ok('POST /sessions returns selected profile/model',
      (create.body as any)?.session?.profileId === 'claude:native' && (create.body as any)?.session?.model === 'mock-model');
    const staleProfileCreate = await api(port, token, 'POST', '/api/v1/sessions', {
      kind: 'claude', profileId: 'claude:env:deleted-private-name',
    });
    ok('POST /sessions stale profile -> stable actionable error without profile disclosure',
      staleProfileCreate.status === 409 && (staleProfileCreate.body as any)?.error === 'profile_unavailable' &&
      !(staleProfileCreate.body as any)?.summary?.includes('deleted-private-name'));

    const effort = await api(port, token, 'POST', `/api/v1/sessions/${sid}/effort`, { effort: 'high' });
    ok('POST /sessions/:id/effort -> 200', effort.status === 200, `(got ${effort.status})`);
    ok('POST /sessions/:id/effort returns applied depth', (effort.body as any)?.session?.effort === 'high');

    // 4. GET /sessions list
    const list = await api(port, token, 'GET', '/api/v1/sessions');
    ok('GET /sessions -> 200 list', list.status === 200 && Array.isArray((list.body as any)));
    ok('GET /sessions contains created', Array.isArray(list.body as any) && (list.body as any).some((s: any) => s.sessionId === sid));
    const snapshot = await api(port, token, 'GET', '/api/v1/sessions/snapshot?limit=10');
    ok('GET /sessions/snapshot -> paged items', snapshot.status === 200 && Array.isArray((snapshot.body as any)?.items));

    // 5. GET /sessions/:id summary
    const one = await api(port, token, 'GET', `/api/v1/sessions/${sid}`);
    ok('GET /sessions/:id -> 200', one.status === 200, `(got ${one.status})`);
    ok('GET /sessions/:id kind=claude', (one.body as any)?.kind === 'claude');

    // 6. WS subscribe -> ack
    const { ws, events } = await openWs(port, token);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
    const ack = await waitFor(events, (e) => e.type === 'ack' && e.ackType === 'subscribed');
    ok('WS subscribe -> ack subscribed', !!ack);

    // 7. REST input is asynchronous: 202 must arrive before approval/turn completion.
    const inputStarted = Date.now();
    const inputAccepted = await api(port, token, 'POST', `/api/v1/sessions/${sid}/input`, {
      text: 'say hi', attachments: [artifactRef.artifactId],
    });
    ok('POST /input -> 202 before turn completion', inputAccepted.status === 202 &&
      typeof (inputAccepted.body as any)?.seq === 'number' && Date.now() - inputStarted < 500);
    const apReq = await waitFor(events, (e) => e.type === 'event' && e.event.type === 'approval.request');
    ok('accepted input -> approval.request emitted', !!apReq);
    ok('approval.request kind=command', apReq.event.kind === 'command');
    ok('approval.request has choices', Array.isArray(apReq.event.choices) && apReq.event.choices.length === 4);

    // assert pre-approval sequence
    const preTypes = events.filter((e) => e.type === 'event').map((e) => e.event.type);
    const preSemanticTypes = preTypes.filter((type) => type !== 'transport.metrics');
    ok('event seq pre-approval: turn.started,text.delta,text.delta,text.done,tool.start,approval.request',
      preSemanticTypes.slice(0, 6).join(',') === 'turn.started,text.delta,text.delta,text.done,tool.start,approval.request',
      `(got ${preSemanticTypes.slice(0, 6).join(',')})`);
    ok('pre-approval includes transport metrics', preTypes.includes('transport.metrics'));

    // 8. WS approval allow -> resolved + tool.output + turn.completed
    ws.send(JSON.stringify({ type: 'approval', sessionId: sid, approvalId: apReq.event.approvalId, decision: 'allow' }));
    const done = await waitFor(events, (e) => e.type === 'event' && e.event.type === 'turn.completed');
    ok('WS approval allow -> turn.completed', !!done);
    ok('turn.completed exposes a finite locally observed duration',
      Number.isFinite(done?.event?.performance?.observedDurationMs)
        && done.event.performance.observedDurationMs >= 0);
    const postTypes = events.filter((e) => e.type === 'event').map((e) => e.event.type)
      .filter((type) => type !== 'transport.metrics').slice(6);
    ok('post-approval seq: approval.resolved,tool.output,tool.done,turn.completed',
      postTypes.slice(0, 4).join(',') === 'approval.resolved,tool.output,tool.done,turn.completed',
      `(got ${postTypes.slice(0, 4).join(',')})`);
    const toolDone = events.find((e) => e.type === 'event' && e.event.type === 'tool.done');
    ok('tool.done isError=false (allow)', toolDone && toolDone.event.isError === false);
    const sync = await api(port, token, 'GET', `/api/v1/sessions/${sid}/sync?after=0&messageAfter=0&limit=2`);
    ok('GET /sessions/:id/sync -> independent event/message cursors', sync.status === 200 &&
      typeof (sync.body as any)?.nextAfterSeq === 'number' && typeof (sync.body as any)?.nextMessageAfterSeq === 'number');
    const metrics = await api(port, token, 'GET', `/api/v1/transport/metrics?sessionId=${sid}`);
    ok('GET /transport/metrics -> measured session fields', metrics.status === 200 &&
      (metrics.body as any)?.phoneBackendRttMs === null && (metrics.body as any)?.session?.sessionId === sid);
    ws.send(JSON.stringify({ type: 'approval', sessionId: sid, approvalId: apReq.event.approvalId, decision: 'allow' }));
    const staleApproval = await waitFor(events, (e) => e.type === 'error' && e.code === 'approval_not_pending');
    ok('duplicate approval -> stable approval_not_pending', !!staleApproval);

    // 9. /messages persistence
    const msgs = await api(port, token, 'GET', `/api/v1/sessions/${sid}/messages`);
    ok('GET /messages -> 200', msgs.status === 200 && Array.isArray(msgs.body));
    const roles = (msgs.body as any[]).map((m) => m.role);
    ok('messages contain user+assistant+tool', roles.includes('user') && roles.includes('assistant') && roles.includes('tool'),
      `(roles=${roles.join(',')})`);
    const sentUser = (msgs.body as any[]).find((message) => message.role === 'user' && message.text === 'say hi');
    ok('accepted user message persists canonical artifact metadata', sentUser?.artifacts?.[0]?.artifactId === artifactRef.artifactId);

    // 10. ping/pong + pty error
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await waitFor(events, (e) => e.type === 'pong');
    ok('WS ping -> pong', !!pong);
    ws.send(JSON.stringify({ type: 'pty_input', data: 'x' }));
    const ptyErr = await waitFor(events, (e) => e.type === 'error' && e.code === 'pty_not_available');
    ok('WS pty_input -> pty_not_available', !!ptyErr);
    ws.send('null');
    const badRoot = await waitFor(events, (e) => e.type === 'error' && e.code === 'bad_message');
    ok('WS scalar/null message -> stable bad_message', !!badRoot);
    ws.send(JSON.stringify({ type: 'approval', sessionId: sid, approvalId: 'x', decision: { allowWithModification: {} } }));
    const badDecision = await waitFor(events, (e) => e.type === 'error' && e.code === 'bad_message' && e !== badRoot);
    ok('WS malformed approval decision rejected at boundary', !!badDecision);

    ws.close();

    // 11. deny path (new session)
    const c2 = await api(port, token, 'POST', '/api/v1/sessions', { kind: 'codex' });
    const sid2 = (c2.body as any).sessionId;
    const w2 = await openWs(port, token);
    w2.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid2 }));
    await waitFor(w2.events, (e) => e.type === 'ack');
    w2.ws.send(JSON.stringify({ type: 'input', sessionId: sid2, text: 'run cmd' }));
    const ap2 = await waitFor(w2.events, (e) => e.type === 'event' && e.event.type === 'approval.request');
    w2.ws.send(JSON.stringify({ type: 'approval', sessionId: sid2, approvalId: ap2.event.approvalId, decision: 'deny' }));
    const done2 = await waitFor(w2.events, (e) => e.type === 'event' && e.event.type === 'turn.completed');
    ok('deny path -> turn.completed', !!done2);
    const td2 = w2.events.find((e) => e.type === 'event' && e.event.type === 'tool.done');
    ok('deny -> tool.done isError=true', td2 && td2.event.isError === true);
    const noOut2 = !w2.events.some((e) => e.type === 'event' && e.event.type === 'tool.output');
    ok('deny -> no tool.output', noOut2);
    w2.ws.close();

    // 12. interrupt path (new session)
    const c3 = await api(port, token, 'POST', '/api/v1/sessions', { kind: 'claude' });
    const sid3 = (c3.body as any).sessionId;
    const w3 = await openWs(port, token);
    w3.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid3 }));
    await waitFor(w3.events, (e) => e.type === 'ack');
    w3.ws.send(JSON.stringify({ type: 'input', sessionId: sid3, text: 'go' }));
    await waitFor(w3.events, (e) => e.type === 'event' && e.event.type === 'approval.request');
    w3.ws.send(JSON.stringify({ type: 'interrupt', sessionId: sid3 }));
    const failed = await waitFor(w3.events, (e) => e.type === 'event' && e.event.type === 'turn.failed');
    ok('interrupt -> turn.failed', !!failed);
    ok('interrupt -> no turn.completed', !w3.events.some((e) => e.type === 'event' && e.event.type === 'turn.completed'));
    w3.ws.close();

    // 13. multi-subscribe (two conns same session)
    const c4 = await api(port, token, 'POST', '/api/v1/sessions', { kind: 'claude' });
    const sid4 = (c4.body as any).sessionId;
    const ma = await openWs(port, token);
    const mb = await openWs(port, token);
    ma.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid4 }));
    mb.ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid4 }));
    await waitFor(ma.events, (e) => e.type === 'ack');
    await waitFor(mb.events, (e) => e.type === 'ack');
    ma.ws.send(JSON.stringify({ type: 'input', sessionId: sid4, text: 'hi' }));
    const apA = await waitFor(ma.events, (e) => e.type === 'event' && e.event.type === 'approval.request');
    ok('multi-subscribe: conn A gets approval.request', !!apA);
    // give conn B a moment to receive the fan-out
    await sleep(150);
    const apB = mb.events.find((e) => e.type === 'event' && e.event.type === 'approval.request');
    ok('multi-subscribe: conn B also gets approval.request (no eviction)', !!apB);
    // both respond -> second resolve is a no-op (already resolved); resolve on A
    ma.ws.send(JSON.stringify({ type: 'approval', sessionId: sid4, approvalId: apA.event.approvalId, decision: 'allow' }));
    await waitFor(ma.events, (e) => e.type === 'event' && e.event.type === 'turn.completed');
    ok('multi-subscribe: turn.completed on A', true);
    ma.ws.close(); mb.ws.close();

    // 14. /config sanitized (no token/secret)
    const cfg = await api(port, token, 'GET', '/api/v1/config');
    ok('GET /config -> 200', cfg.status === 200);
    const cfgBody = JSON.stringify(cfg.body);
    ok('GET /config has no token value', !/test-token-fixed/.test(cfgBody));
    ok('GET /config has no networkSecret value', !/"networkSecret"\s*:\s*"sec"/.test(cfgBody));

    // 15. net routes
    const ns = await api(port, token, 'GET', '/api/v1/net/status');
    ok('GET /net/status -> 200', ns.status === 200, `(got ${ns.status})`);
    ok('GET /net/status exposes inboundPolicy', (ns.body as any)?.inboundPolicy?.mode === 'loopback-via-overlay-map');
    const jp = await api(port, token, 'GET', '/api/v1/net/join-params');
    ok('GET /net/join-params -> 200', jp.status === 200, `(got ${jp.status})`);

    // 15b. §10 I7 net_change broadcast on net refresh (POST /net/status). Broadcasts to ALL
    // authenticated clients (no subscribe needed). Carries monotonic seq + net/overlay snapshot.
    const wn = await openWs(port, token);
    const refresh = await api(port, token, 'POST', '/api/v1/net/status', { mobileV6Available: true });
    ok('POST /net/status -> 200', refresh.status === 200, `(got ${refresh.status})`);
    const nc = await waitFor(wn.events, (e) => e.type === 'net_change');
    ok('net_change received on refresh', !!nc);
    ok('net_change has monotonic seq', typeof nc.seq === 'number' && nc.seq >= 1, `(seq=${nc.seq})`);
    ok('net_change snapshot has net', typeof nc.snapshot?.net === 'object');
    ok('net_change snapshot has overlay', typeof nc.snapshot?.overlay === 'object');
    const seqAfterRefresh = nc.seq;
    wn.ws.close();

    // 15c. §10 reconnect re-fetches latest: a fresh connection is pushed the latest net_change.
    const wn2 = await openWs(port, token);
    const nc2 = await waitFor(wn2.events, (e) => e.type === 'net_change');
    ok('reconnect receives latest net_change', !!nc2);
    ok('reconnect latest seq matches', nc2.seq === seqAfterRefresh, `(seq=${nc2.seq} vs ${seqAfterRefresh})`);
    wn2.ws.close();

    // 15d. §10 overlay state change -> onStateChange -> net_change broadcast. We use
    // action:'stop' (NOT start): a real easytier-core.exe exists in bin/win-x64, so start()
    // would spawn a live overlay (network side effects, no place in a unit test). stop() on
    // the never-started controller still drives the state setter -> onStateChange -> broadcast,
    // exercising the full wiring without spawning.
    const wn3 = await openWs(port, token);
    const ov = await api(port, token, 'POST', '/api/v1/net/overlay', { action: 'stop' });
    ok('POST /net/overlay stop -> 200', ov.status === 200, `(got ${ov.status})`);
    const nc3 = await waitFor(wn3.events, (e) => e.type === 'net_change' && e.seq > seqAfterRefresh);
    ok('overlay stop -> net_change with advanced seq', !!nc3, `(seq=${nc3?.seq} > ${seqAfterRefresh})`);
    ok('overlay net_change carries overlay snapshot', typeof nc3.snapshot?.overlay?.status === 'string',
      `(status=${nc3?.snapshot?.overlay?.status})`);
    wn3.ws.close();

    // 16. /accounts
    const ac = await api(port, token, 'GET', '/api/v1/accounts');
    ok('GET /accounts -> 200', ac.status === 200, `(got ${ac.status})`);

    // 17. /fs/list
    const fs1 = await api(port, token, 'GET', '/api/v1/fs/list?path=.');
    ok('GET /fs/list -> 200', fs1.status === 200, `(got ${fs1.status})`);

    // 17b. §9 I6 /sessions/:id/diff (existing session; cwd = server cwd, a git repo) -> 200 + shape.
    // Non-Git dir resolves to {repo:false} with 200 (distinguishable, NOT 500); missing session -> 404.
    const diffOk = await api(port, token, 'GET', `/api/v1/sessions/${sid}/diff`);
    ok('GET /sessions/:id/diff -> 200', diffOk.status === 200, `(got ${diffOk.status})`);
    const db = diffOk.body as any;
    ok('diff body has repo boolean', typeof db?.repo === 'boolean');
    ok('diff body has cwd string', typeof db?.cwd === 'string');
    ok('diff body has staged/unstaged strings', typeof db?.staged === 'string' && typeof db?.unstaged === 'string');
    ok('diff body has untracked array', Array.isArray(db?.untracked));
    ok('diff body has head string|null', db?.head === null || typeof db?.head === 'string');
    ok('diff body has truncated boolean', typeof db?.truncated === 'boolean');
    const diffMissing = await api(port, token, 'GET', '/api/v1/sessions/nonexistent-session/diff');
    ok('GET /sessions/:id/diff missing session -> 404', diffMissing.status === 404, `(got ${diffMissing.status})`);

    // N2: /input + /interrupt on missing session -> 404 (not 500). send/interrupt throw on
    // missing session; without the get() guard these surface as 500 via server.ts catch.
    const inputMissing = await api(port, token, 'POST', '/api/v1/sessions/nonexistent-session/input', { text: 'hi' });
    ok('POST /input missing session -> 404', inputMissing.status === 404, `(got ${inputMissing.status})`);
    const interruptMissing = await api(port, token, 'POST', '/api/v1/sessions/nonexistent-session/interrupt');
    ok('POST /interrupt missing session -> 404', interruptMissing.status === 404, `(got ${interruptMissing.status})`);

    // N6: REST /input text length cap (symmetric with WS MAX_INPUT_TEXT_CHARS = 256KB).
    const tooLong = 'x'.repeat(256 * 1024 + 1);
    const inputTooLong = await api(port, token, 'POST', `/api/v1/sessions/${sid}/input`, { text: tooLong });
    ok('POST /input oversized text -> 400', inputTooLong.status === 400, `(got ${inputTooLong.status})`);

    // 18. hook fail-closed (localhost, unknown session -> deny)
    const hk = await api(port, token, 'POST', '/hooks/pre-tool-use', { session_id: 'unknown', tool_name: 'Bash', tool_input: {} });
    ok('POST /hooks/pre-tool-use -> 200 (fail-closed)', hk.status === 200, `(got ${hk.status})`);
    ok('hook -> permissionDecision deny', (hk.body as any)?.hookSpecificOutput?.permissionDecision === 'deny');

    // 19. DELETE session
    const del = await api(port, token, 'DELETE', `/api/v1/sessions/${sid}`);
    ok('DELETE /sessions/:id -> 200', del.status === 200, `(got ${del.status})`);
    const listAfter = await api(port, token, 'GET', '/api/v1/sessions');
    ok('session gone after delete', !(listAfter.body as any[]).some((s: any) => s.sessionId === sid));

    console.log(`\nGATEWAY INTEGRATION: ${pass} pass, ${fail} fail`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    await sessions.disposeAll();
    artifacts.dispose();
    server.close();
    rmSync(nativeRoot, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
