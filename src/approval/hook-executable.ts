// Compiled command hooks must not expose the product executable path in native CLI
// settings, argv, or detailed hook telemetry. Keep the single-binary distribution by
// launching the same executable through a private, neutral hard-link. A copy-on-write
// copy is only the last resort for cross-volume/read-only installations.
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  rmSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateRuntimeSubdirectory, createPrivateTempDirectory } from '../util/private-file';
import { isWindows } from '../util/platform';

// Only product-owned identifiers are forbidden here. Do not reject ordinary words such as
// "mobile" or "phone", and do not inspect user-controlled cwd/attachment path segments.
const FORBIDDEN_HOOK_SURFACE = /(?:^|[\\/._\-\s])moyu(?=$|[\\/._\-\s])|remote[-_]dashboard|hook-relay/i;
const NEUTRAL_EXECUTABLE_NAME = isWindows ? 'local-guard.exe' : 'local-guard';

let cachedPath: string | null = null;
let cachedDir: string | null = null;
let cleanupRegistered = false;

/** Product/provider names must never enter a compiled native hook definition. */
export function assertNeutralHookSurface(command: string, args: readonly string[]): void {
  if ([command, ...args].some((part) => FORBIDDEN_HOOK_SURFACE.test(part))) {
    // Keep the failure itself neutral because it can be surfaced beside native CLI output.
    throw new Error('local command path is not neutral');
  }
}

/** The descriptor leaf is product-owned even though its ancestor may be user-controlled. */
export function assertNeutralHookDescriptor(configPath: string): void {
  if (basename(configPath).toLowerCase() !== 'data.json') {
    throw new Error('local command descriptor is not neutral');
  }
}

function neutral(value: string): boolean {
  return !FORBIDDEN_HOOK_SURFACE.test(value);
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort. A residue is an unprivileged alias of the already-installed executable and
    // contains no descriptor, credential, or session data.
  }
}

function waitForExecutableRelease(attempt: number): void {
  // Freshly compiled/downloaded Windows executables can remain briefly locked by the writer or
  // local malware scanner. A bounded synchronous wait is acceptable during daemon startup and
  // avoids weakening the neutral-path requirement or falling back to the product executable.
  if (!isWindows) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, 200 * attempt);
}

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    if (cachedDir) cleanup(cachedDir);
  });
}

export interface NeutralExecutableAlias {
  path: string;
  dir: string;
  method: 'link' | 'copy';
}

/**
 * Create a neutral alias for an executable. Exported for a bounded filesystem unit test.
 * `roots` may be supplied by the test; production considers only neutral local roots.
 */
export function createNeutralExecutableAlias(
  sourcePath: string,
  roots: readonly string[] = [tmpdir()],
): NeutralExecutableAlias {
  if (!statSync(sourcePath).isFile()) throw new Error('local command executable is invalid');

  for (const root of roots) {
    if (!neutral(root)) continue;
    let dir: string | null = null;
    try {
      dir = createPrivateTempDirectory('.tmp-', root);
      const path = join(dir, NEUTRAL_EXECUTABLE_NAME);
      assertNeutralHookSurface(path, []);
      linkSync(sourcePath, path);
      return { path, dir, method: 'link' };
    } catch {
      if (dir) cleanup(dir);
    }
  }

  // Cross-volume or locked-down installation fallback. COPYFILE_FICLONE requests a reflink
  // where supported and transparently degrades to a normal copy elsewhere. This happens once
  // per daemon, never once per session.
  if (!neutral(tmpdir())) throw new Error('neutral local command directory is unavailable');
  const maxAttempts = isWindows ? 5 : 1;
  let lastError: unknown = new Error('local command copy failed');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let dir: string | null = null;
    try {
      dir = createPrivateRuntimeSubdirectory();
      const path = join(dir, NEUTRAL_EXECUTABLE_NAME);
      assertNeutralHookSurface(path, []);
      copyFileSync(sourcePath, path, constants.COPYFILE_FICLONE);
      if (!isWindows) chmodSync(path, 0o700);
      return { path, dir, method: 'copy' };
    } catch (error) {
      lastError = error;
      if (dir) cleanup(dir);
      if (attempt < maxAttempts) waitForExecutableRelease(attempt);
    }
  }
  throw lastError;
}

/** Lazily materialize one process-wide neutral alias for the compiled executable. */
export function neutralHookExecutable(): string {
  if (cachedPath && existsSync(cachedPath)) return cachedPath;
  const alias = createNeutralExecutableAlias(process.execPath);
  cachedPath = alias.path;
  cachedDir = alias.dir;
  registerCleanup();
  return alias.path;
}

/** Build/runtime smoke: exercise the exact hidden dispatch used by native command hooks.
 * A deliberately missing descriptor must fail closed with the stable neutral response; this
 * proves the alias, CLI parser and local-check dispatch all work without contacting a provider. */
export function selfCheckNeutralHookExecutable(): { ok: boolean; path: string | null; error?: string } {
  try {
    const path = neutralHookExecutable();
    assertNeutralHookSurface(path, ['local-check']);
    const missingDescriptor = join(dirname(path), 'data.json');
    assertNeutralHookDescriptor(missingDescriptor);
    rmSync(missingDescriptor, { force: true });
    const result = spawnSync(path, ['local-check', missingDescriptor], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (
      !result.error &&
      result.status === 2 &&
      result.stdout === '' &&
      result.stderr === 'approval unavailable\n'
    ) return { ok: true, path };
    return { ok: false, path, error: 'local command fail-closed probe did not execute' };
  } catch {
    return { ok: false, path: null, error: 'local command alias is unavailable' };
  }
}
