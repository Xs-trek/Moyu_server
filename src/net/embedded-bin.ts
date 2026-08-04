// §3 single-binary delivery (T2–T6). The per-platform `easytier-core` binary is
// embedded as a Bun compile file asset: the build-generated entry does
//   import binPath from './embedded/easytier-core.bin' with { type: 'file' }
// and assigns it to globalThis.__MOYU_EMBEDDED_EASYTIER before importing the
// server entry. At runtime that import yields a VIRTUAL path (e.g.
// "B:/~BUN/root/asset-<rand>.bin") that only Bun's file APIs can read -- it
// CANNOT be passed to child_process.spawn (uv_spawn ENOENT). So we read the
// bytes via Bun.file(...).arrayBuffer(), write them to a versioned temp dir,
// chmod 0o755 on unix, and return the real path. Cached once per process.
//
// Dev/source mode (tsx/Node tests, `npm run dev`): the global is unset and the
// Bun global is absent -> materializeEmbeddedBin() resolves null and resolveBin()
// in easytier.ts falls back to the bin/<platform>/ filesystem lookup. Tests and
// dev are therefore unaffected by this module.
//
// Residue policy (mandate §3): on a clean shutdown the temp dir is removed
// best-effort (process 'exit'). If the process dies abnormally (SIGKILL/crash)
// the exit handler never runs and the dir stays on disk; the NEXT start sees a
// matching version+platform stamp and reuses it (safe -- same bytes), or removes
// a stale (version/platform mismatch) dir and re-extracts. So residue is always
// "safely reusable or cleaned next start".
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { log } from '../util/logger';
import { getPlatform, getArch, isWindows } from '../util/platform';
import { VERSION } from '../version';

/** Global key the build-generated entry sets to the embedded asset's virtual path. */
export const EMBEDDED_GLOBAL = '__MOYU_EMBEDDED_EASYTIER';

interface EmbeddedGlobal {
  [EMBEDDED_GLOBAL]?: string;
}
interface BunGlobal {
  Bun?: { file: (p: string) => { arrayBuffer: () => Promise<ArrayBuffer> } };
}

function embeddedAssetPath(): string | null {
  const g = (globalThis as unknown as EmbeddedGlobal)[EMBEDDED_GLOBAL];
  return typeof g === 'string' && g.length > 0 ? g : null;
}

/** Only the compiled binary sets the global AND has the Bun global to read it. */
function isCompiled(): boolean {
  return embeddedAssetPath() !== null && typeof (globalThis as BunGlobal).Bun !== 'undefined';
}

/** The real binary file name for the current platform (win adds .exe). */
export function exeName(): string {
  return isWindows ? 'easytier-core.exe' : 'easytier-core';
}

/** Versioned per-platform temp dir so a stale residue (old version / other arch)
 *  is distinguishable from a reusable one. */
export function dirFor(): string {
  return join(tmpdir(), `moyu-easytier-${VERSION}-${getPlatform()}-${getArch()}`);
}

/** Stamp written next to the binary so reuse can verify it matches this build. */
export function stampValue(): string {
  return `${VERSION}|${getPlatform()}|${getArch()}`;
}

function stampPath(dir: string): string {
  return join(dir, '.moyu-stamp');
}

/** A temp dir is reusable iff the binary AND a matching stamp are present. */
export function dirValid(dir: string): boolean {
  if (!existsSync(join(dir, exeName()))) return false;
  if (!existsSync(stampPath(dir))) return false;
  try {
    if (readFileSync(stampPath(dir), 'utf8').trim() !== stampValue()) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Write bytes + stamp into a fresh dir (caller guarantees `dir` was just created
 * or cleaned). chmod 0o755 on unix so the binary is executable. Returns the real
 * binary path. Exported (not just used internally) so the reuse/stale/chmod logic
 * is unit-testable without the Bun global / a real compiled asset.
 */
export function extractToDir(dir: string, bytes: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, exeName());
  writeFileSync(bin, bytes);
  writeFileSync(stampPath(dir), stampValue());
  if (!isWindows) {
    try {
      chmodSync(bin, 0o755);
    } catch (e) {
      // chmod can fail on odd filesystems; the binary is still written. spawn()
      // will surface an EACCES if it truly isn't executable.
      log.warn('embedded easytier chmod failed', { err: String(e) });
    }
  }
  return bin;
}

let cached: string | null | undefined = undefined;
let cleanupRegistered = false;

/** Best-effort temp cleanup on clean shutdown. Abnormal exit (SIGKILL/crash)
 *  skips this; the next start reuses (same stamp) or cleans (stale) the residue. */
function registerCleanup(dir: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort; residue is reusable/cleaned next start */
    }
  });
}

/**
 * Materialize the embedded easytier-core binary to a real temp path and return
 * it. Cached per process. Returns null in dev/source mode (no embedded asset).
 *
 * MUST be awaited before the EasyTierController reads its bin in compiled mode
 * (index.ts main() and cli.ts detect() do this). In dev mode it resolves null
 * quickly (no Bun global) and resolveBin() falls back to bin/<platform>/.
 */
export async function materializeEmbeddedBin(): Promise<string | null> {
  if (cached !== undefined) return cached;
  if (!isCompiled()) {
    cached = null;
    return null;
  }
  const asset = embeddedAssetPath()!;
  const dir = dirFor();
  try {
    if (dirValid(dir)) {
      cached = join(dir, exeName());
      log.debug('embedded easytier-core reused', { dir });
      registerCleanup(dir);
      return cached;
    }
    // Stale (other version/platform) or missing: clean + re-extract.
    rmSync(dir, { recursive: true, force: true });
    const bytes = await (globalThis as BunGlobal).Bun!.file(asset).arrayBuffer();
    cached = extractToDir(dir, new Uint8Array(bytes));
    log.info('embedded easytier-core extracted', { dir, bytes: bytes.byteLength });
    registerCleanup(dir);
    return cached;
  } catch (e) {
    cached = null;
    log.error('embedded easytier-core extract failed', { err: String(e) });
    return null;
  }
}

/** Sync read of the materialized cache. null if not yet materialized or dev mode.
 *  Used by resolveBin() (sync) after materializeEmbeddedBin() has populated it. */
export function getEmbeddedBinPath(): string | null {
  return cached ?? null;
}

/** Self-check: verify the embedded binary spawns and reports a version. Used by
 *  `moyu --selfcheck` (the §3 "single artifact, no external bin/PATH" build smoke
 *  step). Runs the extracted binary with --version from ANY cwd (no bin/ on PATH,
 *  no vendor dir) -- proving the artifact is self-contained. */
export async function selfCheckEmbeddedBin(): Promise<{
  ok: boolean;
  path: string | null;
  version?: string;
  error?: string;
}> {
  const path = await materializeEmbeddedBin();
  if (!path) {
    return { ok: false, path: null, error: 'no embedded easytier-core (dev/source mode)' };
  }
  try {
    const { spawn } = await import('node:child_process');
    const child = spawn(path, ['--version'], { windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code: number = await new Promise((resolve) => {
      child.on('close', (c) => resolve(c ?? -1));
      child.on('error', () => resolve(-1));
    });
    const version = (stdout || stderr).trim().split('\n')[0];
    if (code === 0 && version) return { ok: true, path, version };
    return { ok: false, path, error: `exit ${code}` };
  } catch (e) {
    return { ok: false, path, error: String(e) };
  }
}
