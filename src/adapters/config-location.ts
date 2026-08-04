// Shared adapter configuration-directory resolution. Paths are resolved locally and are
// never provider-probed: configured override > CLI-specific environment > user-home default.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type ConfigLocationSource = 'configured' | 'environment' | 'default';

export interface ConfigDirectoryLocation {
  path: string;
  source: ConfigLocationSource;
}

export interface ConfigDirectorySpec {
  envVar: string;
  defaultSegments: readonly string[];
}

/** Expand the only portable shorthand accepted by init, then make the saved path absolute. */
export function normalizeConfigPath(input: string): string {
  let value = input.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function resolveConfigDirectory(
  configured: string | undefined,
  spec: ConfigDirectorySpec,
  env: NodeJS.ProcessEnv = process.env,
): ConfigDirectoryLocation {
  if (typeof configured === 'string' && configured.trim()) {
    return { path: normalizeConfigPath(configured), source: 'configured' };
  }
  const fromEnv = env[spec.envVar];
  if (fromEnv?.trim()) {
    return { path: normalizeConfigPath(fromEnv), source: 'environment' };
  }
  return { path: join(homedir(), ...spec.defaultSegments), source: 'default' };
}

/** Apply a configured directory to the CLI process. A selected account profile wins, so a
 * Codex *.home profile can intentionally override the adapter's native CODEX_HOME. */
export function mergeConfigDirectoryEnv(
  configured: string | undefined,
  envVar: string,
  profileEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const hasConfigured = typeof configured === 'string' && !!configured.trim();
  if (!hasConfigured && !profileEnv) return undefined;
  return {
    ...(hasConfigured ? { [envVar]: normalizeConfigPath(configured) } : {}),
    ...(profileEnv ?? {}),
  };
}
