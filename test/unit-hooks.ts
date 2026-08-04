// Unit tests for the F8 hook shared-secret (no real claude, no quota burn).
// Covers verifyHookSecret + handlePreToolUse fail-closed behavior:
//   correct secret -> handler invoked; missing/wrong/non-Bearer -> 200+deny;
//   entry with no secret (legacy) -> handler invoked (backward-compat).
// Run: npx tsx test/unit-hooks.ts
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handlePreToolUse, HookRegistry, verifyHookSecret } from '../src/api/hooks';

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

// --- verifyHookSecret (pure) ---
const secret = 'a'.repeat(48); // 24 bytes hex
check('verify: correct secret -> true', verifyHookSecret(mkReq({ authorization: `Bearer ${secret}` }), secret));
check('verify: missing header -> false', !verifyHookSecret(mkReq({}), secret));
check('verify: wrong secret -> false', !verifyHookSecret(mkReq({ authorization: `Bearer ${'b'.repeat(48)}` }), secret));
check('verify: non-Bearer scheme -> false', !verifyHookSecret(mkReq({ authorization: `Basic ${secret}` }), secret));
check('verify: empty bearer -> false', !verifyHookSecret(mkReq({ authorization: 'Bearer ' }), secret));
check('verify: length mismatch (no throw) -> false', !verifyHookSecret(mkReq({ authorization: 'Bearer short' }), secret));

// --- handlePreToolUse (fail-closed) ---
{
  const reg = new HookRegistry();
  let called = false;
  reg.register('s1', 'owner1', async () => {
    called = true;
    return { hookSpecificOutput: { permissionDecision: 'allow' as const } };
  }, secret);

  // correct secret -> handler invoked, 200 allow
  const r1 = await run(reg, 's1', `Bearer ${secret}`);
  check('handle: correct secret -> 200', r1.status === 200);
  check('handle: correct secret -> allow', r1.body?.hookSpecificOutput?.permissionDecision === 'allow');
  check('handle: correct secret -> handler invoked', called);

  // missing secret header -> 200 deny, handler NOT invoked
  called = false;
  const r2 = await run(reg, 's1', undefined);
  check('handle: missing secret -> 200', r2.status === 200);
  check('handle: missing secret -> deny (fail-closed)', r2.body?.hookSpecificOutput?.permissionDecision === 'deny');
  check('handle: missing secret -> handler NOT invoked', !called);

  // wrong secret -> 200 deny
  const r3 = await run(reg, 's1', `Bearer ${'x'.repeat(48)}`);
  check('handle: wrong secret -> deny', r3.body?.hookSpecificOutput?.permissionDecision === 'deny');

  // unknown session -> 200 deny (no handler lookup bypass)
  const r4 = await run(reg, 'nope', `Bearer ${secret}`);
  check('handle: unknown session -> deny', r4.body?.hookSpecificOutput?.permissionDecision === 'deny');

  // legacy entry (no secret) -> handler invoked even without header (backward-compat)
  const reg2 = new HookRegistry();
  let called2 = false;
  reg2.register('s2', 'owner2', async () => {
    called2 = true;
    return { hookSpecificOutput: { permissionDecision: 'allow' as const } };
  }); // no secret
  const r5 = await run(reg2, 's2', undefined);
  check('handle: legacy (no secret) -> handler invoked', called2 && r5.body?.hookSpecificOutput?.permissionDecision === 'allow');
}

// --- §8: Claude resume hook ownership + cliSessionRef keying ---
{
  // §8 core: two backend sessions resuming the SAME Claude session (same cliSessionRef key,
  // different owner) must REJECT instead of overwriting. Same-owner re-register is idempotent.
  const reg = new HookRegistry();
  let threw = false;
  reg.register('claude-sess-X', 'backend-A', async () => ({ hookSpecificOutput: { permissionDecision: 'allow' as const } }), 'secA');
  try {
    reg.register('claude-sess-X', 'backend-B', async () => ({ hookSpecificOutput: { permissionDecision: 'deny' as const } }), 'secB');
  } catch {
    threw = true;
  }
  check('§8 duplicate resume (same key, diff owner) throws', threw);
  // The first owner's handler survives (not overwritten by the rejected second).
  const entry = reg.get('claude-sess-X');
  check('§8 first owner keeps the hook after rejected dup', !!entry && entry.owner === 'backend-A');
  check('§8 first owner secret preserved after rejected dup', entry?.secret === 'secA');
  // Same-owner re-register is allowed (idempotent init).
  let rethrew = false;
  try {
    reg.register('claude-sess-X', 'backend-A', async () => ({ hookSpecificOutput: { permissionDecision: 'allow' as const } }), 'secA');
  } catch {
    rethrew = true;
  }
  check('§8 same-owner re-register allowed (no throw)', !rethrew);

  // §8 unregister is owner-gated: wrong owner can't evict; right owner can.
  reg.unregister('claude-sess-X', 'backend-B'); // wrong owner -> no-op
  check('§8 unregister by wrong owner is a no-op', !!reg.get('claude-sess-X'));
  reg.unregister('claude-sess-X', 'backend-A'); // right owner -> deletes
  check('§8 unregister by right owner deletes', !reg.get('claude-sess-X'));

  // §8 resume routing: cliSessionRef (≠ backend sessionId) is the hook key, matching the
  // session_id claude sends. A fresh session (cliSessionRef === sessionId) uses one key.
  const reg2 = new HookRegistry();
  let allowed = false;
  // Resume case: backend sessionId 'back-1' resumes claude session 'claude-real-9'.
  reg2.register('claude-real-9', 'back-1', async () => {
    allowed = true;
    return { hookSpecificOutput: { permissionDecision: 'allow' as const } };
  }, 'secResume');
  // claude sends its REAL session_id ('claude-real-9'), NOT the backend sessionId ('back-1').
  const rr = await run(reg2, 'claude-real-9', 'Bearer secResume');
  check('§8 resume: hook routes by cliSessionRef (claude real id)', allowed);
  check('§8 resume: routed hook -> allow', rr.body?.hookSpecificOutput?.permissionDecision === 'allow');
  // A hook carrying the backend sessionId would NOT match (claude never sends it, but verify
  // the registry does not accidentally key on backend sessionId).
  const rr2 = await run(reg2, 'back-1', 'Bearer secResume');
  check('§8 resume: backend sessionId is NOT a hook key (deny)', rr2.body?.hookSpecificOutput?.permissionDecision === 'deny');
}

console.log(`\n${fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED'} (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;

// ---- helpers ----
function mkReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

interface RunResult {
  status: number | undefined;
  body: { hookSpecificOutput?: { permissionDecision?: string } } | null;
}

async function run(reg: HookRegistry, sessionId: string, authHeader: string | undefined): Promise<RunResult> {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.method = 'POST';
  req.headers = authHeader ? { authorization: authHeader } : {};
  let status: number | undefined;
  let body: RunResult['body'] = null;
  const res = {
    writeHead: (s: number) => {
      status = s;
    },
    end: (d?: string) => {
      body = d ? (JSON.parse(d) as RunResult['body']) : null;
    },
  } as unknown as ServerResponse;

  const p = handlePreToolUse(reg, req, res);
  // readJsonBody registers its data/end listeners synchronously before the await suspends,
  // but yield once to be safe, then feed the body.
  await new Promise((r) => setImmediate(r));
  req.emit('data', Buffer.from(JSON.stringify({ session_id: sessionId, tool_name: 'Bash' })));
  req.emit('end');
  await p;
  return { status, body };
}
