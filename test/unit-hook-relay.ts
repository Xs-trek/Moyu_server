import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util/spawn';

const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let pass = 0;
let fail = 0;

function check(name: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ FAIL: ' + name);
  }
}

async function main(): Promise<void> {
  let mode: 'allow' | 'http-error' = 'allow';
  let requestBody = '';
  let authorization = '';
  let session = '';
  const server = createServer((req, res) => {
    authorization = String(req.headers.authorization ?? '');
    session = String(req.headers['x-moyu-session'] ?? '');
    requestBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      requestBody += chunk;
    });
    req.on('end', () => {
      if (mode === 'http-error') {
        res.writeHead(503);
        res.end('unavailable');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'echo ok' },
        },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo ok' },
  });
  const descriptorDir = mkdtempSync(join(tmpdir(), 'moyu-relay-test-'));
  const descriptor = join(descriptorDir, 'relay.json');
  writeFileSync(descriptor, JSON.stringify({
    port,
    timeoutMs: 2_000,
    secret: 'relay-test-secret-0123456789abcdef',
    sessionId: 'relay-test-session',
  }), { mode: 0o600 });

  try {
    const allowed = await run(process.execPath, [TSX, ENTRY, 'hook-relay', descriptor], {
      stdin: input,
      timeout: 8_000,
    });
    check('valid gateway response exits 0', allowed.code === 0);
    check('valid gateway response is relayed on stdout', JSON.parse(allowed.stdout).hookSpecificOutput.updatedInput.command === 'echo ok');
    check('relay sends bearer and session identity', authorization === 'Bearer relay-test-secret-0123456789abcdef' && session === 'relay-test-session');
    check('relay forwards the original hook body', requestBody === input);

    mode = 'http-error';
    const denied = await run(process.execPath, [TSX, ENTRY, 'hook-relay', descriptor], {
      stdin: input,
      timeout: 8_000,
    });
    check('gateway non-2xx exits 2', denied.code === 2);
    check('gateway failure writes a blocking stderr reason', denied.stderr.startsWith('blocked:'));
    check('gateway failure emits no allow JSON', denied.stdout === '');

    const invalid = await run(process.execPath, [TSX, ENTRY, 'hook-relay', join(descriptorDir, 'missing.json')], {
      stdin: input,
      timeout: 8_000,
    });
    check('invalid relay identity fails closed with exit 2', invalid.code === 2);
  } finally {
    rmSync(descriptorDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
  if (fail) process.exitCode = 1;
}

void main();
