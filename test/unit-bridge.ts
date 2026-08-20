// Unit tests for ApprovalTracker.clear() fail-closed (review P2: clear() only canceled
// timers + deleted the map, leaving registered callers' Promises pending forever).
// Verifies clear() resolves every pending approval as 'deny'.
// Run: npx tsx test/unit-bridge.ts
import { ApprovalTracker, toClaude, toCodexHook } from '../src/approval/bridge';
import type { ApprovalDecision } from '../src/adapters/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ FAIL: ' + name);
  }
}

async function main(): Promise<void> {
  const denied = toCodexHook('deny', { command: 'echo test' });
  check('codex deny reason is neutral', denied.hookSpecificOutput.permissionDecisionReason === 'approval was not granted');
  check('codex deny reason has no remote identity', !/moyu|remote|phone|mobile/i.test(denied.hookSpecificOutput.permissionDecisionReason ?? ''));
  const claudeInput = { command: 'echo test' };
  const claudeAllowed = toClaude('allow', claudeInput);
  check('claude allow echoes original input for relay validation', claudeAllowed.hookSpecificOutput.updatedInput === claudeInput);
  const claudeDenied = toClaude('deny', claudeInput);
  check('claude deny reason is neutral', claudeDenied.hookSpecificOutput.permissionDecisionReason === 'approval was not granted');
  check('claude deny reason has no integration identity', !/moyu|remote|phone|mobile|provider/i.test(claudeDenied.hookSpecificOutput.permissionDecisionReason ?? ''));

  // 1. clear() resolves a single pending as 'deny' + fires onResolved.
  const resolved: Array<{ id: string; decision: ApprovalDecision; timedOut: boolean }> = [];
  const t = new ApprovalTracker(600, (id, decision, timedOut) => resolved.push({ id, decision, timedOut }));
  const p = new Promise<ApprovalDecision>((r) => t.register('a1', r));
  check('pending registered', t.has('a1'));
  t.clear();
  const decision = await p;
  check('clear() resolves as deny', decision === 'deny');
  check('clear() fires onResolved(deny)', resolved.length === 1 && resolved[0].decision === 'deny');
  check('clear() onResolved timedOut=false', resolved[0].timedOut === false);
  check('clear() removes from pending', !t.has('a1'));

  // 2. clear() with multiple pending resolves ALL as deny.
  const seen: ApprovalDecision[] = [];
  const t2 = new ApprovalTracker(600, (_id, d) => seen.push(d));
  const ps = [
    new Promise<ApprovalDecision>((r) => t2.register('b1', r)),
    new Promise<ApprovalDecision>((r) => t2.register('b2', r)),
    new Promise<ApprovalDecision>((r) => t2.register('b3', r)),
  ];
  t2.clear();
  const all = await Promise.all(ps);
  check('clear() resolves ALL pending as deny', all.length === 3 && all.every((d) => d === 'deny'));
  check('clear() fired onResolved for each', seen.length === 3);

  // 3. clear() on empty tracker is a no-op (no throw).
  const t3 = new ApprovalTracker(600, () => {});
  let threw = false;
  try {
    t3.clear();
  } catch {
    threw = true;
  }
  check('clear() empty no-op (no throw)', !threw);

  // 4. After clear(), a fresh registration + explicit resolve still works.
  const t4 = new ApprovalTracker(600, () => {});
  const pStale = new Promise<ApprovalDecision>((r) => t4.register('c1', r));
  t4.clear();
  check('stale pending resolved to deny by clear', (await pStale) === 'deny');
  const pFresh = new Promise<ApprovalDecision>((r) => t4.register('c2', r));
  t4.resolve('c2', 'allow');
  check('fresh resolve works after clear', (await pFresh) === 'allow');

  console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
  if (fail) process.exitCode = 1;
}

void main();
