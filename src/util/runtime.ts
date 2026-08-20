// Runtime identity helpers shared by the single-binary entry and subprocess adapters.
// The build-generated entry sets this flag before importing src/index.ts. Source/tsx
// execution leaves it unset, which lets adapters choose a development bootstrap.
import { delimiter, dirname, resolve } from 'node:path';

interface MoyuRuntimeGlobal {
  __MOYU_COMPILED__?: boolean;
}

export function isCompiledBinary(): boolean {
  return (globalThis as MoyuRuntimeGlobal).__MOYU_COMPILED__ === true;
}

/** Remove only moyu's own control-plane variables before spawning an AI CLI. These values
 * identify the integration and can otherwise be inherited by tool subprocesses and echoed
 * into the model transcript by a normal `env` command. Provider credentials are deliberately
 * untouched: profile selection must behave exactly like the user's native shell export. */
const PRODUCT_PATH_MARKER = /(?:^|[\\/._\-\s])moyu(?=$|[\\/._\-\s])|remote[-_]dashboard/i;

function comparablePath(value: string): string {
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  const normalized = resolve(trimmed);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function scrubMoyuEnv(
  env: NodeJS.ProcessEnv,
  runtimeExecutable = isCompiledBinary() ? process.execPath : undefined,
  childCwd?: string,
): NodeJS.ProcessEnv {
  const clean = { ...env };
  const resolvedChildCwd = childCwd ? resolve(childCwd) : undefined;
  for (const key of Object.keys(clean)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('RD_HOOK_') || normalized.startsWith('MOYU_') || normalized === 'REMOTE_DASHBOARD_CONFIG') {
      delete clean[key];
      continue;
    }
    const value = clean[key];
    // child_process changes the OS cwd but does not rewrite inherited shell/package-manager
    // location variables. Keep PWD consistent with the explicit neutral session cwd, and remove
    // only stale launch-context paths that identify this product. Unrelated user environment is
    // preserved exactly as it is for a direct native headless invocation.
    if (normalized === 'PWD' && resolvedChildCwd) {
      clean[key] = resolvedChildCwd;
    } else if (
      (normalized === 'OLDPWD' || normalized === 'INIT_CWD' ||
        normalized === 'NPM_CONFIG_LOCAL_PREFIX' || normalized === 'NPM_PACKAGE_JSON') &&
      typeof value === 'string' && PRODUCT_PATH_MARKER.test(value)
    ) {
      delete clean[key];
    }
  }
  // A common one-time install adds the product executable's directory to PATH. If that exact
  // directory itself carries a product marker, remove only that segment from AI CLI children;
  // ordinary user PATH entries and generic install roots such as C:\bin remain untouched.
  if (runtimeExecutable) {
    const runtimeDir = dirname(runtimeExecutable);
    const runtimePath = comparablePath(runtimeExecutable);
    const comparableDir = comparablePath(runtimeDir);
    for (const key of Object.keys(clean)) {
      const normalized = key.toUpperCase();
      const value = clean[key];
      if (PRODUCT_PATH_MARKER.test(runtimeDir) && normalized === 'PATH' && typeof value === 'string') {
          clean[key] = value
            .split(delimiter)
            .filter((entry) => !entry || comparablePath(entry) !== comparableDir)
            .join(delimiter);
      } else if (normalized === '_' && typeof value === 'string' && comparablePath(value) === runtimePath) {
        delete clean[key];
      }
    }
  }
  return clean;
}
