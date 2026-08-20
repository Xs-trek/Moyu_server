// Codex auth detection (0-modify: presence only, NEVER reads token values).
// Verified findings §2 + 2026-07-31 codex-rs source re-verification:
//   ~/.codex/auth.json (NOT auth.toml) | OPENAI_API_KEY env | openai_base_url in config.toml
//   (OPENAI_BASE_URL env NOT supported in current source).
// auth.json structure (codex-rs/login/src/auth/storage.rs:38-52 + token_data.rs:11-24):
//   { auth_mode?, OPENAI_API_KEY?, tokens?: {id_token, access_token, refresh_token, account_id?},
//     last_refresh?, ... } -- tokens => ChatGPT OAuth; OPENAI_API_KEY => API key mode.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthProfile } from '../types';
import { resolveConfigDirectory, type ConfigDirectoryLocation } from '../config-location';

const CODEX_LOCATION = { envVar: 'CODEX_HOME', defaultSegments: ['.codex'] } as const;

export function resolveCodexConfigLocation(configured?: string): ConfigDirectoryLocation {
  return resolveConfigDirectory(configured, CODEX_LOCATION);
}

export function resolveCodexConfigDir(configured?: string): string {
  return resolveCodexConfigLocation(configured).path;
}

/** Read auth state from an arbitrary CODEX_HOME directory (0-modify: presence only).
 *  Used for codexHome profiles: the dir's auth.json is user-pre-created via
 *  `CODEX_HOME=<dir> codex login`. Does NOT consult process.env -- a codexHome profile's
 *  auth is the directory, not the shell. */
export function readCodexAuthAt(
  dir: string,
  base?: AuthProfile,
  env: NodeJS.ProcessEnv = {},
): AuthProfile {
  const profile: AuthProfile = base ?? { adapter: 'codex', mode: 'none', hasCredentials: false };
  if (env.OPENAI_API_KEY) {
    profile.mode = 'apiKey';
    profile.hasCredentials = true;
  }
  const authPath = join(dir, 'auth.json');
  if (existsSync(authPath)) {
    try {
      const a = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
      if (a && (a.OPENAI_API_KEY || a.tokens || a.access_token)) {
        profile.mode = a.tokens || a.access_token ? 'oauth' : 'apiKey';
        profile.hasCredentials = true;
      }
    } catch {
      // best-effort
    }
  }
  // base_url presence in config.toml (existence only)
  const configPath = join(dir, 'config.toml');
  if (existsSync(configPath)) {
    try {
      const t = readFileSync(configPath, 'utf8');
      if (/openai_base_url|base_url\s*=|model_providers/.test(t)) {
        profile.baseUrlPresent = true;
      }
      const providerEnvKeys = [...t.matchAll(/\benv_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g)]
        .map((match) => match[1]!);
      if (providerEnvKeys.some((key) => !!env[key]) || /\bexperimental_bearer_token\s*=/.test(t)) {
        profile.mode = 'apiKey';
        profile.hasCredentials = true;
      } else if (/\[model_providers\.[^\]]+\.auth\]|\bauth\.command\s*=/.test(t)) {
        profile.mode = 'providerKey';
        profile.hasCredentials = true;
      }
    } catch {
      // best-effort
    }
  }
  return profile;
}

/** nativeDefault: the user's ~/.codex + shell env hints (proxy / OPENAI_API_KEY). */
export function detectCodexAuth(configuredDir?: string): AuthProfile {
  const profile: AuthProfile = { adapter: 'codex', mode: 'none', hasCredentials: false };
  profile.proxyDetected = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY);

  return readCodexAuthAt(resolveCodexConfigDir(configuredDir), profile, process.env);
}
