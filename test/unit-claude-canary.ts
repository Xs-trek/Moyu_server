import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookRegistry } from '../src/api/hooks';
import { ClaudeSession } from '../src/adapters/claude/session';
import type { AdapterEvent } from '../src/adapters/types';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ FAIL: ' + name); }
}

function count(path: string): number {
  try { return Number(readFileSync(path, 'utf8')) || 0; } catch { return 0; }
}

async function waitFor(events: AdapterEvent[], type: AdapterEvent['type'], previous = 0): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (events.filter((event) => event.type === type).length > previous) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let probe = '';
  try { probe = readFileSync(join(stateDir, 'probe-result'), 'utf8'); } catch { /* no probe output */ }
  throw new Error(`timed out waiting for ${type}: ${JSON.stringify(events)} probe=${probe}`);
}

const stateDir = mkdtempSync(join(tmpdir(), 'claude-canary-test-'));
const previousDir = process.env.TEST_CLAUDE_CANARY_DIR;
const previousFailAt = process.env.TEST_CLAUDE_FAIL_PROBE_AT;
process.env.TEST_CLAUDE_CANARY_DIR = stateDir;
process.env.TEST_CLAUDE_FAIL_PROBE_AT = '2';

const session = new ClaudeSession({
  sessionId: '11111111-1111-4111-8111-111111111111',
  cliSessionRef: '11111111-1111-4111-8111-111111111111',
  cwd: stateDir,
  port: 12345,
  approvalTimeoutSec: 10,
  hooks: new HookRegistry(),
  approvalPolicy: 'never',
  bin: fileURLToPath(new URL('./mock-claude-canary.js', import.meta.url)),
});
const events: AdapterEvent[] = [];
session.onEvent((event) => events.push(event));

try {
  await session.init();
  await session.send({ text: 'first' });
  await waitFor(events, 'turn.completed');
  check('fresh SessionStart nonce allows the real turn', count(join(stateDir, 'probe-count')) === 1 && count(join(stateDir, 'turn-count')) === 1);

  await session.send({ text: 'second' });
  await waitFor(events, 'turn.failed');
  check('missing second-turn nonce fails closed', count(join(stateDir, 'probe-count')) === 2);
  const firstNonce = readFileSync(join(stateDir, 'probe-1-nonce'), 'utf8');
  const secondNonce = readFileSync(join(stateDir, 'probe-2-nonce'), 'utf8');
  check('every turn receives a fresh readiness nonce', firstNonce.length === 64 && secondNonce.length === 64 && firstNonce !== secondNonce);
  check('stale marker cannot start the real CLI turn', count(join(stateDir, 'stale-marker-written')) === 1 && count(join(stateDir, 'turn-count')) === 1);
} finally {
  await session.dispose();
  if (previousDir === undefined) delete process.env.TEST_CLAUDE_CANARY_DIR;
  else process.env.TEST_CLAUDE_CANARY_DIR = previousDir;
  if (previousFailAt === undefined) delete process.env.TEST_CLAUDE_FAIL_PROBE_AT;
  else process.env.TEST_CLAUDE_FAIL_PROBE_AT = previousFailAt;
  rmSync(stateDir, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ` (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
