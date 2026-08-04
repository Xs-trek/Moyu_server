// §9 I6 diff capability tests: Git repo / non-Git / over-limit / nonexistent session.
// Uses real `git` (shell-less via util/spawn) against throwaway temp repos -- no account or
// system-config impact. Non-Git dir must be a distinguishable status (repo:false), NOT a throw/500.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/util/spawn';
import { diffRepo } from '../src/vcs/git';
import { SessionManager } from '../src/session/manager';
import { AdapterManager } from '../src/adapters/manager';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`PASS - ${name}`); }
  else { fail++; console.log(`FAIL - ${name}${detail ? ' ' + detail : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TIMEOUT = 20_000;
async function g(dir: string, ...args: string[]): Promise<void> {
  const r = await run('git', ['-C', dir, ...args], { cwd: dir, timeout: TIMEOUT });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (code ${r.code}): ${r.stderr}`);
}

async function main(): Promise<void> {
  // --- A. Git repo: staged + unstaged + untracked + head ---
  const dirA = mkdtempSync(join(tmpdir(), 'moyu-diff-repo-'));
  try {
    await g(dirA, 'init', '--quiet');
    await g(dirA, 'config', 'user.email', 'test@test.test');
    await g(dirA, 'config', 'user.name', 'Test');
    writeFileSync(join(dirA, 'a.txt'), 'line1\n');
    await g(dirA, 'add', 'a.txt');
    await g(dirA, 'commit', '--quiet', '-m', 'init');
    // staged: newly added b.txt
    writeFileSync(join(dirA, 'b.txt'), 'line2\n');
    await g(dirA, 'add', 'b.txt');
    // unstaged: modify tracked a.txt
    writeFileSync(join(dirA, 'a.txt'), 'line1\nextra\n');
    // untracked: c.txt (not added)
    writeFileSync(join(dirA, 'c.txt'), 'untracked\n');

    const r = await diffRepo(dirA);
    ok('A: repo=true', r.repo === true, `(repo=${r.repo})`);
    ok('A: cwd normalized to dir', r.cwd === dirA, `(cwd=${r.cwd})`);
    ok('A: head is short sha', typeof r.head === 'string' && /^[0-9a-f]{7,}$/.test(r.head), `(head=${r.head})`);
    ok('A: staged contains b.txt', r.staged.includes('b.txt'), `(staged=${r.staged.slice(0, 80)})`);
    ok('A: staged contains line2', r.staged.includes('line2'));
    ok('A: unstaged contains a.txt', r.unstaged.includes('a.txt'), `(unstaged=${r.unstaged.slice(0, 80)})`);
    ok('A: unstaged contains extra', r.unstaged.includes('extra'));
    ok('A: untracked includes c.txt', Array.isArray(r.untracked) && r.untracked.includes('c.txt'), `(untracked=${JSON.stringify(r.untracked)})`);
    ok('A: not truncated', r.truncated === false);
    ok('A: no error field on repo', r.error === undefined);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }

  // --- B. Non-Git directory: distinguishable status (repo:false), no throw ---
  const dirB = mkdtempSync(join(tmpdir(), 'moyu-diff-nongit-'));
  try {
    let threw = false;
    let r;
    try {
      r = await diffRepo(dirB);
    } catch {
      threw = true;
    }
    ok('B: non-Git does not throw', !threw);
    ok('B: repo=false', r!.repo === false, `(repo=${r!.repo})`);
    ok('B: error set', typeof r!.error === 'string' && r!.error.length > 0, `(error=${r!.error})`);
    ok('B: cwd still returned', r!.cwd === dirB);
    ok('B: empty staged/unstaged/untracked', r!.staged === '' && r!.unstaged === '' && r!.untracked.length === 0);
    ok('B: head null', r!.head === null);
  } finally {
    rmSync(dirB, { recursive: true, force: true });
  }

  // --- C. Over-limit diff: aggregated output > 512 KiB -> truncated ---
  const dirC = mkdtempSync(join(tmpdir(), 'moyu-diff-big-'));
  try {
    await g(dirC, 'init', '--quiet');
    await g(dirC, 'config', 'user.email', 'test@test.test');
    await g(dirC, 'config', 'user.name', 'Test');
    // ~1.1 MiB of short text lines -> staged diff well over the 512 KiB cap.
    const big = Array.from({ length: 100_000 }, () => 'abcdefghij\n').join('');
    writeFileSync(join(dirC, 'big.txt'), big);
    await g(dirC, 'add', 'big.txt');

    const r = await diffRepo(dirC);
    ok('C: repo=true', r.repo === true);
    ok('C: truncated=true', r.truncated === true, `(truncated=${r.truncated})`);
    // Staged is truncated to <= 512 KiB (the cap), not the full ~1.1 MiB.
    ok('C: staged under cap', Buffer.byteLength(r.staged, 'utf8') <= 512 * 1024 + 64, `(staged bytes=${Buffer.byteLength(r.staged, 'utf8')})`);
  } finally {
    rmSync(dirC, { recursive: true, force: true });
  }

  // --- D. Nonexistent session: getCwd returns null (drives 404, not 500) ---
  const mgr = new SessionManager(new AdapterManager());
  ok('D: getCwd(null) returns null for unknown session', mgr.getCwd('does-not-exist') === null);

  // --- E. git unavailable path: missing cwd dir behaves as repo:false, no throw ---
  // A path that doesn't exist: git -C <missing> rev-parse exits non-zero -> repo:false.
  const rE = await diffRepo(join(tmpdir(), 'moyu-diff-missing-' + 'x'.repeat(8)));
  ok('E: missing dir -> repo=false (no throw)', rE.repo === false && typeof rE.error === 'string');

  await sleep(10);
  console.log(`\nDIFF: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
