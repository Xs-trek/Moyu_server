// Real local OpenCode Server compatibility smoke. It uses an isolated temporary OpenCode state,
// never sends a model prompt, and always disposes the Moyu-owned server child.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_ADAPTER_CONFIG } from '../src/config/schema';
import { OpenCodeServerRuntime } from '../src/adapters/opencode/runtime';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to allocate smoke port');
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function main(): Promise<void> {
  const value = process.argv[2];
  if (!value) throw new Error('usage: tsx test/smoke-opencode-real.ts <opencode executable>');
  const bin = resolve(value);
  const root = mkdtempSync(join(tmpdir(), 'moyu-opencode-smoke-'));
  const previous = {
    config: process.env.XDG_CONFIG_HOME,
    data: process.env.XDG_DATA_HOME,
    state: process.env.XDG_STATE_HOME,
    cache: process.env.XDG_CACHE_HOME,
  };
  process.env.XDG_CONFIG_HOME = join(root, 'config');
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.XDG_STATE_HOME = join(root, 'state');
  process.env.XDG_CACHE_HOME = join(root, 'cache');
  const port = await freePort();
  const runtime = new OpenCodeServerRuntime({
    adapterConfig: {
      ...DEFAULT_ADAPTER_CONFIG,
      serverMode: 'managed',
      serverUrl: `http://127.0.0.1:${port}`,
      serverUsername: 'opencode',
      serverPassword: 'moyu-real-smoke-local-only',
      bin,
    },
  });
  try {
    const client = await runtime.ensureReady();
    const health = await client.health();
    const streamAbort = new AbortController();
    const streamOpened = new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('OpenCode global SSE did not open')), 3_000);
      void client.globalEvents(streamAbort.signal, () => {}, () => {
        clearTimeout(timer);
        done();
      }).catch((error) => {
        clearTimeout(timer);
        if (!streamAbort.signal.aborted) fail(error);
      });
    });
    await streamOpened;
    streamAbort.abort();
    const session = await client.createSession(root, 'Moyu v0.0.4 compatibility smoke');
    const fetched = await client.getSession(session.id, root);
    const messages = await client.listMessages(session.id, root);
    const aborted = await client.abort(session.id, root);
    if (!health.healthy || fetched.id !== session.id || !Array.isArray(messages) || aborted !== true) {
      throw new Error('required OpenCode Server surface returned an unexpected shape');
    }
    console.log(`REAL OPENCODE SERVER: PASS (${health.version}; health/session/message/abort/SSE ready)`);
  } finally {
    await runtime.dispose();
    for (const [key, value] of Object.entries(previous)) {
      const name = `XDG_${key.toUpperCase()}_HOME`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // root is an exact mkdtemp result and cannot alias the workspace or user home.
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
