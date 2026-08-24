// Offline contract test for the official OpenCode 1.18.x Server API bridge.
// No provider request or real OpenCode process is used.
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { DEFAULT_ADAPTER_CONFIG, type AdapterConfig } from '../src/config/schema';
import { OpenCodeClient, normalizeLoopbackServerUrl, type OpenCodeGlobalEvent, type OpenCodeMessageRecord, type OpenCodeSessionInfo } from '../src/adapters/opencode/client';
import { createOpencodeAdapter } from '../src/adapters/opencode/adapter';
import { OpenCodeServerRuntime, supportedOpenCodeVersion } from '../src/adapters/opencode/runtime';
import { OpenCodeSession } from '../src/adapters/opencode/session';
import type { AdapterEvent, SessionHandle } from '../src/adapters/types';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++;
    console.log(`PASS - ${name}`);
  } else {
    fail++;
    console.error(`FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out waiting for OpenCode mock state');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let value = '';
  for await (const chunk of req) value += String(chunk);
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

class MockOpenCodeServer {
  private server: Server;
  private streams = new Set<ServerResponse>();
  private nextSession = 1;
  readonly sessions = new Map<string, OpenCodeSessionInfo>();
  readonly messages = new Map<string, OpenCodeMessageRecord[]>();
  readonly promptBodies: Record<string, unknown>[] = [];
  readonly permissionReplies: Array<{ sessionId: string; permissionId: string; response: unknown }> = [];
  readonly aborts: string[] = [];
  readonly authHeaders: Array<string | undefined> = [];
  eventConnections = 0;
  oversizedHealth = false;
  wrongEventContentType = false;
  readonly expectedAuthorization = `Basic ${Buffer.from('tester:secret').toString('base64')}`;

  constructor() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('mock server did not bind TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  addMessage(sessionId: string, record: OpenCodeMessageRecord): void {
    const records = this.messages.get(sessionId) ?? [];
    records.push(record);
    this.messages.set(sessionId, records);
  }

  broadcast(sessionId: string, type: string, properties: Record<string, unknown>): void {
    const directory = this.sessions.get(sessionId)?.directory ?? homedir();
    const event: OpenCodeGlobalEvent = { directory, payload: { type, properties } };
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) stream.write(frame);
  }

  closeEventStreams(): void {
    for (const stream of this.streams) stream.end();
    this.streams.clear();
  }

  get activeEventStreams(): number { return this.streams.size; }

  async close(): Promise<void> {
    this.closeEventStreams();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private json(res: ServerResponse, value: unknown, status = 200): void {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== this.expectedAuthorization) {
      this.json(res, { error: 'unauthorized' }, 401);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/global/health') {
      if (this.oversizedHealth) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': 64 * 1024 * 1024 + 1 });
        res.end('{}');
      } else this.json(res, { healthy: true, version: '1.18.19' });
      return;
    }
    if (method === 'GET' && url.pathname === '/global/event') {
      this.eventConnections++;
      res.writeHead(200, {
        'content-type': this.wrongEventContentType ? 'application/json' : 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      if (this.wrongEventContentType) {
        res.end('{}');
      } else {
        this.streams.add(res);
        res.on('close', () => this.streams.delete(res));
      }
      return;
    }
    if (method === 'GET' && url.pathname === '/project') {
      this.json(res, []);
      return;
    }
    if (method === 'GET' && url.pathname === '/path') {
      this.json(res, { directory: homedir(), worktree: homedir() });
      return;
    }
    if (url.pathname === '/session' && method === 'GET') {
      const directory = url.searchParams.get('directory');
      this.json(res, [...this.sessions.values()].filter((item) => !directory || item.directory === directory));
      return;
    }
    if (url.pathname === '/session' && method === 'POST') {
      const body = await readJson(req);
      const id = `ses_${this.nextSession++}`;
      const now = Date.now();
      const session: OpenCodeSessionInfo = {
        id,
        directory: url.searchParams.get('directory') ?? homedir(),
        title: typeof body.title === 'string' ? body.title : '',
        version: '1.18.19',
        time: { created: now, updated: now },
      };
      this.sessions.set(id, session);
      this.messages.set(id, []);
      this.json(res, session);
      return;
    }
    const match = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort|permissions)\/??([^/]+)?)?$/.exec(url.pathname);
    if (!match) {
      this.json(res, { error: 'not found' }, 404);
      return;
    }
    const sessionId = decodeURIComponent(match[1]!);
    const action = match[2];
    const tail = match[3] ? decodeURIComponent(match[3]) : undefined;
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.json(res, { error: 'not found' }, 404);
      return;
    }
    if (!action && method === 'GET') {
      this.json(res, session);
      return;
    }
    if (action === 'message' && method === 'GET') {
      this.json(res, this.messages.get(sessionId) ?? []);
      return;
    }
    if (action === 'prompt_async' && method === 'POST') {
      const body = await readJson(req);
      this.promptBodies.push(body);
      const text = ((body.parts as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
      this.addMessage(sessionId, {
        info: { id: `msg_user_${this.promptBodies.length}`, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
        parts: [{ id: `part_user_${this.promptBodies.length}`, sessionID: sessionId, messageID: `msg_user_${this.promptBodies.length}`, type: 'text', text }],
      });
      res.writeHead(204);
      res.end();
      return;
    }
    if (action === 'abort' && method === 'POST') {
      this.aborts.push(sessionId);
      this.json(res, true);
      return;
    }
    if (action === 'permissions' && tail && method === 'POST') {
      const body = await readJson(req);
      this.permissionReplies.push({ sessionId, permissionId: tail, response: body.response });
      this.json(res, true);
      return;
    }
    this.json(res, { error: 'not found' }, 404);
  }
}

function attachConfig(serverUrl: string): AdapterConfig {
  return { ...DEFAULT_ADAPTER_CONFIG, serverMode: 'attach', serverUrl, serverUsername: 'tester' };
}

function collect(handle: SessionHandle): AdapterEvent[] {
  const events: AdapterEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return events;
}

class FakeChild extends EventEmitter {
  stderr = new PassThrough();
  stdout = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit('close', 0));
    return true;
  }
}

async function main(): Promise<void> {
  check('OpenCode 1.17.9 compatibility floor accepted', supportedOpenCodeVersion('1.17.9'));
  check('OpenCode 1.18.x compatibility accepted', supportedOpenCodeVersion('opencode 1.18.19'));
  check('OpenCode before 1.17.9 rejected', !supportedOpenCodeVersion('1.17.8'));
  check('unrecorded OpenCode 1.19 contract rejected', !supportedOpenCodeVersion('1.19.0'));
  check('loopback accepts IPv4 loopback', normalizeLoopbackServerUrl('http://127.9.8.7:4096') === 'http://127.9.8.7:4096');
  check('loopback accepts IPv6 loopback', normalizeLoopbackServerUrl('http://[::1]:4096') === 'http://[::1]:4096');
  for (const value of ['https://127.0.0.1:4096', 'http://192.168.1.2:4096', 'http://127.0.0.1:4096/path', 'http://user:pass@127.0.0.1:4096']) {
    let rejected = false;
    try { normalizeLoopbackServerUrl(value); } catch { rejected = true; }
    check(`loopback rejects ${value}`, rejected);
  }

  const mock = new MockOpenCodeServer();
  const serverUrl = await mock.start();
  try {
    const direct = new OpenCodeClient(serverUrl, 'tester', 'secret');
    check('official health fixture is readable', (await direct.health()).version === '1.18.19');
    mock.oversizedHealth = true;
    let oversizedRejected = false;
    try { await direct.health(); } catch (error) { oversizedRejected = /size limit/.test(String(error)); }
    mock.oversizedHealth = false;
    check('declared oversized REST body fails before buffering', oversizedRejected);

    const wrongSse = new AbortController();
    mock.wrongEventContentType = true;
    let wrongSseRejected = false;
    try { await direct.globalEvents(wrongSse.signal, () => {}); } catch { wrongSseRejected = true; }
    mock.wrongEventContentType = false;
    check('non-SSE content type fails closed', wrongSseRejected);

    const adapter = createOpencodeAdapter({
      approvalTimeoutSec: 30,
      adapterConfig: attachConfig(serverUrl),
      username: 'tester',
      password: 'secret',
    });
    check('attach mode becomes available through Server API', await adapter.isAvailable());
    check('OpenCode 1.18.19 compatibility accepted', (await adapter.compatibility()).state === 'compatible');
    await waitFor(() => mock.activeEventStreams === 1 ? true : undefined);

    const first = await adapter.startSession({ sessionId: 'moyu-1', cwd: homedir(), title: 'first', model: 'anthropic/claude-sonnet-4-5' });
    const second = await adapter.startSession({ sessionId: 'moyu-2', cwd: homedir(), title: 'second' });
    const firstEvents = collect(first);
    const secondEvents = collect(second);
    check('two sessions share one global SSE connection', mock.activeEventStreams === 1 && mock.sessions.size === 2);

    await first.send({ text: 'hello', deviceId: 'must-not-cross' } as { text: string });
    const prompt = mock.promptBodies.at(-1) as Record<string, unknown>;
    check('prompt contains only official parts/model fields', Object.keys(prompt).sort().join(',') === 'model,parts');
    check('prompt model uses provider/model mapping', JSON.stringify(prompt.model) === JSON.stringify({ providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }));
    check('frontend metadata is absent from official prompt body', !JSON.stringify(prompt).includes('must-not-cross'));

    const firstId = first.resumeRef!;
    const assistantInfo = {
      id: 'msg_assistant_1', sessionID: firstId, role: 'assistant' as const,
      time: { created: Date.now(), completed: Date.now() }, providerID: 'anthropic', modelID: 'claude-sonnet-4-5',
      tokens: { input: 12, output: 4, cache: { read: 3, write: 1 } }, cost: 0.01,
    };
    const assistantPart = { id: 'part_assistant_1', sessionID: firstId, messageID: assistantInfo.id, type: 'text', text: 'world' };
    mock.addMessage(firstId, { info: assistantInfo, parts: [assistantPart] });
    mock.broadcast(firstId, 'session.status', { sessionID: firstId, status: { type: 'busy' } });
    mock.broadcast(firstId, 'message.updated', { info: assistantInfo });
    mock.broadcast(firstId, 'message.part.updated', { part: assistantPart, delta: 'world' });
    mock.broadcast(firstId, 'session.status', { sessionID: firstId, status: { type: 'idle' } });
    const completed = await waitFor(() => firstEvents.find((event) => event.type === 'turn.completed'));
    check('SSE maps streaming and canonical upsert events', firstEvents.some((event) => event.type === 'text.delta') && firstEvents.some((event) => event.type === 'message.upsert'));
    check('completion maps usage and runtime model', completed.type === 'turn.completed' && completed.usage?.inputTokens === 12 && completed.model === 'anthropic/claude-sonnet-4-5');

    mock.broadcast(firstId, 'permission.updated', {
      id: 'perm_1', sessionID: firstId, messageID: assistantInfo.id, type: 'bash', title: 'Run command', metadata: { command: 'echo ok' }, time: { created: Date.now() },
    });
    await waitFor(() => firstEvents.find((event) => event.type === 'approval.request'));
    await first.resolveApproval('perm_1', 'allow_session');
    check('approval maps allow_session to official always response', mock.permissionReplies.at(-1)?.response === 'always');

    const externalInfo = { id: 'msg_external', sessionID: firstId, role: 'assistant' as const, time: { created: Date.now() }, providerID: 'openai', modelID: 'gpt-5' };
    const externalPart = { id: 'part_external', sessionID: firstId, messageID: externalInfo.id, type: 'text', text: 'external update' };
    mock.addMessage(firstId, { info: externalInfo, parts: [externalPart] });
    const connectionsBefore = mock.eventConnections;
    mock.closeEventStreams();
    await waitFor(() => mock.eventConnections > connectionsBefore ? true : undefined);
    await waitFor(() => firstEvents.find((event) => event.type === 'message.upsert' && event.message.sourceId === 'opencode:msg_external'));
    check('SSE reconnect reconciles external-client messages', true);

    const history = await adapter.history.list(10, 0);
    const record = await adapter.history.read(firstId);
    check('official history lists shared-server sessions', history.items.some((item) => item.resumeRef === firstId));
    check('official history read returns normalized messages', !!record && record.messages.some((message) => message.sourceId === 'opencode:msg_external'));
    const sessionCount = mock.sessions.size;
    const resumed = await adapter.startSession({ sessionId: 'moyu-resume', resumeRef: firstId, cwd: homedir() });
    check('opaque resumeRef binds existing session without creating another', resumed.resumeRef === firstId && mock.sessions.size === sessionCount);
    await resumed.dispose();

    mock.broadcast(second.resumeRef!, 'session.status', { sessionID: second.resumeRef!, status: { type: 'busy' } });
    await waitFor(() => secondEvents.find((event) => event.type === 'turn.started'));
    await second.interrupt();
    check('interrupt uses official abort route', mock.aborts.at(-1) === second.resumeRef);
    check('interrupt emits a bounded failure', secondEvents.some((event) => event.type === 'turn.failed'));

    await first.dispose();
    check('session dispose does not stop shared attach server', mock.activeEventStreams === 1 && (await direct.health()).healthy);
    await second.dispose();
    await adapter.dispose();
    await waitFor(() => mock.activeEventStreams === 0 ? true : undefined);
    check('attach adapter dispose closes only Moyu SSE', (await direct.health()).healthy);
    check('Basic Auth is sent on every OpenCode request', mock.authHeaders.every((value) => value === mock.expectedAuthorization));

    const fakeChild = new FakeChild();
    let spawnCount = 0;
    let spawnArgs: readonly string[] = [];
    const managed = new OpenCodeServerRuntime({
      adapterConfig: { ...DEFAULT_ADAPTER_CONFIG, serverMode: 'managed', serverUrl, serverUsername: 'tester', bin: 'opencode-test.exe' },
      username: 'tester',
      password: 'secret',
    }, {
      resolveBinary: () => 'opencode-test.exe',
      probeVersion: async () => ({ ok: true, version: '1.18.19' }),
      spawn: ((_: string, args: readonly string[]) => {
        spawnCount++;
        spawnArgs = args;
        return fakeChild as unknown as ChildProcess;
      }) as never,
    });
    await managed.ensureReady();
    check('managed mode starts exactly one serve process on loopback', spawnCount === 1 && spawnArgs.join(' ').includes('serve --hostname 127.0.0.1'));
    const managedSession = new OpenCodeSession(managed, { sessionId: 'managed-session', cwd: homedir(), approvalTimeoutSec: 30 });
    await managedSession.init();
    await managedSession.dispose();
    check('managed session dispose does not terminate shared child', fakeChild.killedSignals.length === 0);
    await managed.dispose();
    check('managed runtime dispose terminates its owned child once', fakeChild.killedSignals.length === 1 && fakeChild.killedSignals[0] === 'SIGTERM');
  } finally {
    await mock.close();
  }

  console.log(`\nOPENCODE SERVER: ${pass} pass, ${fail} fail`);
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
