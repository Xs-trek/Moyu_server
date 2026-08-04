// Claude auth detection (0-modify: presence only, NEVER reads token values).
// Paths (verified findings §1): $CLAUDE_CONFIG_DIR or ~/.claude/.credentials.json (oauth) |
// ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN+ANTHROPIC_BASE_URL (this machine, first-class) |
// settings.json.env | apiKeyHelper in settings.json
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthProfile } from '../types';
import { resolveConfigDirectory, type ConfigDirectoryLocation } from '../config-location';

const CLAUDE_LOCATION = { envVar: 'CLAUDE_CONFIG_DIR', defaultSegments: ['.claude'] } as const;

export function resolveClaudeConfigLocation(configured?: string): ConfigDirectoryLocation {
  return resolveConfigDirectory(configured, CLAUDE_LOCATION);
}

export function resolveClaudeConfigDir(configured?: string): string {
  return resolveClaudeConfigLocation(configured).path;
}

export function detectClaudeAuth(configuredDir?: string): AuthProfile {
  const profile: AuthProfile = { adapter: 'claude', mode: 'none', hasCredentials: false };
  profile.proxyDetected = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY);
  profile.baseUrlPresent = !!process.env.ANTHROPIC_BASE_URL;

  // 1. ANTHROPIC_AUTH_TOKEN (+ optional BASE_URL) -- this machine's mode, first-class
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    profile.mode = 'authToken+BaseUrl';
    profile.hasCredentials = true;
    return profile;
  }
  // 2. ANTHROPIC_API_KEY
  if (process.env.ANTHROPIC_API_KEY) {
    profile.mode = 'apiKey';
    profile.hasCredentials = true;
    return profile;
  }
  const configDir = resolveClaudeConfigDir(configuredDir);
  const settingsPath = join(configDir, 'settings.json');
  let settings: { apiKeyHelper?: unknown; env?: Record<string, unknown> } | undefined;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as typeof settings;
    } catch {
      // best-effort
    }
  }

  // 3. Native settings.json env. Claude Code itself loads these values, so detection must use
  // the same source even when the detached moyu daemon did not inherit the caller's shell env.
  const settingsEnv = settings?.env;
  profile.baseUrlPresent ||= !!settingsEnv?.ANTHROPIC_BASE_URL;
  if (settingsEnv?.CLAUDE_CODE_USE_BEDROCK === '1' || settingsEnv?.CLAUDE_CODE_USE_VERTEX === '1') {
    profile.mode = 'providerKey';
    profile.hasCredentials = true;
    return profile;
  }
  if (settingsEnv?.ANTHROPIC_AUTH_TOKEN) {
    profile.mode = 'authToken+BaseUrl';
    profile.hasCredentials = true;
    return profile;
  }
  if (settingsEnv?.ANTHROPIC_API_KEY) {
    profile.mode = 'apiKey';
    profile.hasCredentials = true;
    return profile;
  }

  // 4. OAuth credentials file (presence only)
  const credPath = join(configDir, '.credentials.json');
  if (existsSync(credPath)) {
    try {
      const c = JSON.parse(readFileSync(credPath, 'utf8')) as Record<string, unknown>;
      if (c && (c.claudeAiOauth || c.anthropicApiKey || c.accessToken || c.apiKey)) {
        profile.mode = 'oauth';
        profile.hasCredentials = true;
        return profile;
      }
    } catch {
      // best-effort
    }
  }
  // 5. apiKeyHelper in settings.json
  if (settings?.apiKeyHelper) {
    profile.mode = 'apiKey';
    profile.hasCredentials = true;
    return profile;
  }
  return profile;
}
