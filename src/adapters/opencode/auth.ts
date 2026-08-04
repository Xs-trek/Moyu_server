// Opencode auth detection (0-modify: presence only). Verified findings §3.
// opencode.json provider.<id>.options.apiKey ({env:VAR}/{file:path}); OPENCODE_SERVER_PASSWORD (server auth).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthProfile } from '../types';

export function detectOpencodeAuth(): AuthProfile {
  const profile: AuthProfile = { adapter: 'opencode', mode: 'none', hasCredentials: false };
  profile.proxyDetected = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY);

  const paths = [
    join(homedir(), '.config', 'opencode', 'opencode.json'),
    join(homedir(), '.opencode', 'opencode.json'),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8')) as {
        providers?: Record<string, unknown>;
        provider?: Record<string, unknown>;
      };
      const providers = cfg?.providers ?? cfg?.provider;
      if (providers && typeof providers === 'object') {
        for (const v of Object.values(providers)) {
          const opts = (v as { options?: Record<string, unknown> })?.options;
          if (opts?.apiKey || opts?.apikey) {
            profile.mode = 'providerKey';
            profile.hasCredentials = true;
            return profile;
          }
        }
      }
    } catch {
      // best-effort
    }
  }
  return profile;
}
