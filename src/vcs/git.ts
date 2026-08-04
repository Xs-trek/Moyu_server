// §9 I6 diff capability. Shell-less Git subprocess (shell:false in util/spawn `run`) to read
// staged/unstaged diff + untracked files for a session's cwd. No shell -> no injection; every
// invocation is bounded by an exec timeout and the aggregated output is capped.
//
// A non-Git directory is a *distinguishable* status (repo:false), NOT a 500: the REST layer
// returns 200 with {repo:false} so the frontend can branch. Only a missing session yields 404.
import { run } from '../util/spawn';
import { resolve } from 'node:path';
import { log } from '../util/logger';

const DIFF_TIMEOUT_MS = 10_000; // per git invocation; protects against a hung repo / large pack
const MAX_DIFF_BYTES = 512 * 1024; // 512 KiB cap on aggregated staged+unstaged diff text

export interface DiffResult {
  /** false => cwd is not inside a git work tree (or git is unavailable). Distinguishable from error. */
  repo: boolean;
  /** normalized absolute cwd the diff was computed against. */
  cwd: string;
  /** `git diff --cached --no-color` (staged changes vs HEAD). */
  staged: string;
  /** `git diff --no-color` (unstaged tracked changes). */
  unstaged: string;
  /** `git ls-files --others --exclude-standard` (untracked, respect .gitignore). */
  untracked: string[];
  /** current HEAD short sha (best-effort; null on unborn branch / no commits). */
  head: string | null;
  /** true if the aggregated diff output exceeded MAX_DIFF_BYTES and was truncated. */
  truncated: boolean;
  /** present only when repo:false (not a work tree / git unavailable). Never sent as 500. */
  error?: string;
}

/**
 * Compute a workspace diff for `cwd` via shell-less Git. Safe to call on any path: a non-Git
 * directory resolves to {repo:false} rather than throwing. Subprocess failures (git missing,
 * timeout-kill) are absorbed into the result so the REST handler never throws a 500.
 */
export async function diffRepo(cwd: string): Promise<DiffResult> {
  const abs = resolve(cwd || process.cwd());
  const empty: DiffResult = { repo: false, cwd: abs, staged: '', unstaged: '', untracked: [], head: null, truncated: false };

  // rev-parse --is-inside-work-tree: exit 0 + "true" iff inside a work tree. Shell-less.
  let inside;
  try {
    inside = await run('git', ['-C', abs, 'rev-parse', '--is-inside-work-tree'], { cwd: abs, timeout: DIFF_TIMEOUT_MS });
  } catch (e) {
    // git binary missing / spawn failure -> not a usable git dir (distinguishable, not 500).
    log.warn('diff: git spawn failed', { cwd: abs, err: String(e) });
    return { ...empty, error: 'git unavailable' };
  }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { ...empty, error: 'not a git work tree' };
  }

  // HEAD short sha (best-effort). Unborn branch (fresh `git init`, no commits) exits non-zero.
  const head = await run('git', ['-C', abs, 'rev-parse', '--short', 'HEAD'], { cwd: abs, timeout: DIFF_TIMEOUT_MS });
  // staged + unstaged diffs (no pager, no color). --no-pager avoids the pager blocking on a tty.
  const stagedR = await run('git', ['-C', abs, '--no-pager', 'diff', '--cached', '--no-color'], { cwd: abs, timeout: DIFF_TIMEOUT_MS });
  const unstagedR = await run('git', ['-C', abs, '--no-pager', 'diff', '--no-color'], { cwd: abs, timeout: DIFF_TIMEOUT_MS });
  const untrackedR = await run('git', ['-C', abs, 'ls-files', '--others', '--exclude-standard'], { cwd: abs, timeout: DIFF_TIMEOUT_MS });

  let staged = stagedR.stdout;
  let unstaged = unstagedR.stdout;
  const untracked = untrackedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  // Output size cap: if staged+unstaged exceed the budget, truncate staged first then unstaged.
  // A timeout-kill also leaves partial stdout; flag truncated so the client knows it's incomplete.
  const stagedBytes = Buffer.byteLength(staged, 'utf8');
  const unstagedBytes = Buffer.byteLength(unstaged, 'utf8');
  let truncated = false;
  if (stagedR.code !== 0 || unstagedR.code !== 0) truncated = true; // timeout/kill -> partial
  if (stagedBytes + unstagedBytes > MAX_DIFF_BYTES) {
    if (stagedBytes >= MAX_DIFF_BYTES) {
      staged = Buffer.from(staged, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8');
      unstaged = '';
    } else {
      unstaged = Buffer.from(unstaged, 'utf8').subarray(0, MAX_DIFF_BYTES - stagedBytes).toString('utf8');
    }
    truncated = true;
    log.warn('diff: output truncated to cap', { cwd: abs, total: stagedBytes + unstagedBytes, cap: MAX_DIFF_BYTES });
  }

  return {
    repo: true,
    cwd: abs,
    staged,
    unstaged,
    untracked,
    head: head.code === 0 ? head.stdout.trim() || null : null,
    truncated,
  };
}
