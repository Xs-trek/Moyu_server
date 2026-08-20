// v3 account/subscription switching service.
//
// A profile is a REFERENCE to a user-maintained credential set on the PC (never the key
// values). The backend discovers profiles from <datadir>/profiles/<adapter>/* plus a
// synthetic nativeDefault (use the CLI's own config), reads them 0-modify, and injects the
// active profile at spawn:
//   - claude: *.env files -> env vars injected at spawn.
//   - codex:  *.home files -> each holds a CODEX_HOME dir path; injected as { CODEX_HOME } at
//     spawn (codex reads its own auth.json there; the backend NEVER writes it).
//
// 0-perception guarantees (C3 strict):
//   - The tool NEVER does first login / OAuth flow / token exchange / writes to auth files (S-key).
//   - The tool makes NO outbound call to any AI provider. Account availability is NOT probed;
//     failures surface through the normal usage flow (user input -> CLI -> server feedback ->
//     frontend via session events). The provider never sees the tool (C3: 0-perception).
//   - Key VALUES are never returned to the frontend; only field presence (S6echo).
//   - codex multi-account (path 1, CODEX_HOME): the auth.json in each CODEX_HOME is pre-created
//     by the user via `CODEX_HOME=<dir> codex login`. The backend reads its existence 0-modify
//     and sets only the CODEX_HOME env (a path, not a credential) at spawn. Verified vs
//     codex-rs/login source 2026-07-31: OAuth tokens have no env-injection path (only CODEX_API_KEY
//     / CODEX_ACCESS_TOKEN do, and they take precedence over auth.json -- so they are scrubbed
//     from the spawn env in CodexSession when a codexHome profile is active).
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AccountProfile,
  AccountSwitchingStatus,
  AdapterKind,
  AppConfig,
  AuthMode,
  ProfileFields,
  SanitizedAccountProfile,
} from '../config/schema';
import { configPath, saveConfig } from '../config/loader';
import { detectClaudeAuth } from '../adapters/claude/auth';
import { detectCodexAuth, readCodexAuthAt } from '../adapters/codex/auth';
import { resolveCliDefaultModel, resolveEffectiveModel } from '../adapters/effective-model';
import { normalizeConfigPath } from '../adapters/config-location';
import { log } from '../util/logger';

/** Adapters that participate in account/profile switching. */
export type SwitchableAdapter = 'claude' | 'codex';

function profilesDir(): string {
  return join(dirname(configPath()), 'profiles');
}

/** Does this adapter apply the active profile at spawn?
 *  claude: envFile env injected. codex: CODEX_HOME injected (codexHome profile). Both adapters
 *  now apply the active profile at spawn -- codex is no longer interface-reserved (path 1). */
function appliesAtSpawn(adapter: SwitchableAdapter): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// env-file parsing (0-modify: read-only). Minimal dotenv: KEY=VALUE per line,
// `export ` prefix tolerated, surrounding quotes stripped, # comments / blanks skipped.
// ---------------------------------------------------------------------------
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('export ')) line = line.slice('export '.length).trim();
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = val;
    }
  } catch (e) {
    log.warn('accounts: env file unreadable', { path, err: String(e) });
  }
  return out;
}

/** Read a Codex *.home file without retaining credentials in profile state. Backward-compatible
 * format: the first bare line is CODEX_HOME. A `CODEX_HOME=<path>` line is also accepted, and
 * subsequent KEY=VALUE entries supply custom provider env_key values to the native CLI. */
function readCodexHomeFile(path: string): { dir: string; env: Record<string, string> } | undefined {
  try {
    const text = readFileSync(path, 'utf8');
    const env = readEnvFile(path);
    const barePath = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((line) => line && !line.startsWith('#') && !line.startsWith('export ') && !line.includes('='));
    const selected = env.CODEX_HOME || barePath;
    if (!selected) return undefined;
    const dir = normalizeConfigPath(selected);
    return { dir, env: { ...env, CODEX_HOME: dir } };
  } catch (e) {
    log.warn('accounts: home file unreadable', { path, err: String(e) });
    return undefined;
  }
}

function detectClaudeEnvFile(
  env: Record<string, string>,
  configuredDir?: string,
): ReturnType<typeof detectClaudeAuth> {
  // Spawn precedence is profile CLAUDE_CONFIG_DIR > adapter configDir > daemon environment.
  // Pass only the profile env to auth detection so a native shell API key/token cannot make an
  // OAuth-directory profile report the wrong account. The resolved directory is explicit, so
  // settings.json and .credentials.json are still inspected read-only.
  const effectiveDir = env.CLAUDE_CONFIG_DIR ?? configuredDir ?? process.env.CLAUDE_CONFIG_DIR;
  return detectClaudeAuth(effectiveDir, env);
}

function inferEnvFileAuthMode(
  adapter: SwitchableAdapter,
  env: Record<string, string>,
  configuredDir?: string,
): AuthMode {
  if (adapter === 'claude') {
    return detectClaudeEnvFile(env, configuredDir).mode as AuthMode;
  }
  // codex envFile is no longer discovered (codex uses *.home/CODEX_HOME); kept for completeness.
  if (env.OPENAI_API_KEY) return 'apiKey';
  return 'none';
}

function inferCodexHomeAuthMode(dir: string, env: Record<string, string>): AuthMode {
  const d = readCodexAuthAt(dir, undefined, env);
  return (d.mode === 'none' ? 'none' : d.mode) as AuthMode;
}

function inferNativeAuthMode(adapter: SwitchableAdapter, cfg?: AppConfig): AuthMode {
  const configuredDir = cfg?.adapters[adapter].configDir;
  const p = adapter === 'claude' ? detectClaudeAuth(configuredDir) : detectCodexAuth(configuredDir);
  return (p.mode === 'none' ? 'none' : p.mode) as AuthMode;
}

function makeNativeDefault(adapter: SwitchableAdapter, cfg?: AppConfig): AccountProfile {
  return {
    id: `${adapter}:native`,
    name: 'native default',
    adapter,
    authMode: inferNativeAuthMode(adapter, cfg),
    source: { kind: 'nativeDefault' },
  };
}

export class AccountService {
  /** Create only moyu-owned profile folders. Native CLI auth/config remains untouched. */
  ensureProfileLayout(): { root: string; claude: string; codex: string } {
    const root = profilesDir();
    const claude = join(root, 'claude');
    const codex = join(root, 'codex');
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    return { root, claude, codex };
  }

  /** Resolve an explicit per-session profile, or the configured default/native profile. */
  selectedProfile(adapter: SwitchableAdapter, requestedId: string | undefined, cfg: AppConfig): AccountProfile {
    const id = requestedId ?? cfg.adapters[adapter].activeProfileId ?? `${adapter}:native`;
    const profile = this.discoverProfiles(adapter, cfg).find((candidate) => candidate.id === id);
    if (!profile) throw new Error(`unknown profile id: ${id}`);
    return profile;
  }

  resolveSelectedEnv(adapter: SwitchableAdapter, requestedId: string | undefined, cfg: AppConfig): Record<string, string> {
    return this.resolveEnv(this.selectedProfile(adapter, requestedId, cfg));
  }

  /** Discover profiles for an adapter: nativeDefault first, then profile files under
   *  profilesDir/<adapter>/. claude scans *.env; codex scans *.home (CODEX_HOME dir paths). */
  discoverProfiles(adapter: SwitchableAdapter, cfg?: AppConfig): AccountProfile[] {
    const profiles: AccountProfile[] = [makeNativeDefault(adapter, cfg)];
    const dir = join(profilesDir(), adapter);
    if (existsSync(dir)) {
      const ext = adapter === 'codex' ? '.home' : '.env';
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith(ext));
      } catch (e) {
        log.warn('accounts: profiles dir unreadable', { dir, err: String(e) });
      }
      for (const f of names) {
        const path = join(dir, f);
        const name = f.slice(0, -ext.length);
        if (adapter === 'codex') {
          const home = readCodexHomeFile(path);
          if (!home) continue;
          profiles.push({
            id: `codex:home:${name}`,
            name,
            adapter,
            authMode: inferCodexHomeAuthMode(home.dir, home.env),
            source: { kind: 'codexHome', dir: home.dir, path },
          });
        } else {
          const env = readEnvFile(path);
          profiles.push({
            id: `${adapter}:env:${name}`,
            name,
            adapter,
            authMode: inferEnvFileAuthMode(adapter, env, cfg?.adapters[adapter].configDir),
            source: { kind: 'envFile', path },
          });
        }
      }
    }
    return profiles;
  }

  /** Resolve the env vars to inject at spawn for a profile.
   *  nativeDefault => {} (use CLI native). envFile => file contents. codexHome => { CODEX_HOME: dir }. */
  resolveEnv(profile: AccountProfile): Record<string, string> {
    if (profile.source.kind === 'nativeDefault') return {};
    if (profile.source.kind === 'envFile') return profile.source.path ? readEnvFile(profile.source.path) : {};
    if (profile.source.kind === 'codexHome') {
      if (!profile.source.dir) return {};
      const current = profile.source.path ? readCodexHomeFile(profile.source.path) : undefined;
      return current?.env ?? { CODEX_HOME: profile.source.dir };
    }
    return {};
  }

  /** Resolve the active profile's env set for an adapter (live config). */
  resolveActiveEnv(adapter: AdapterKind, cfg: AppConfig): Record<string, string> {
    if (adapter !== 'claude' && adapter !== 'codex') return {};
    const id = cfg.adapters[adapter].activeProfileId;
    if (!id) return {};
    const p = this.discoverProfiles(adapter, cfg).find((x) => x.id === id);
    if (!p) {
      // S-1: stale activeProfileId (profile file deleted after activate). Fall back to native
      // default env rather than fail the session -- but log so the silent wrong-account case is
      // observable instead of silently using the wrong subscription.
      log.warn('accounts: active profile not found (stale id); falling back to native default', { adapter, profileId: id });
      return {};
    }
    return this.resolveEnv(p);
  }

  /** Field PRESENCE only (S6echo) for a profile. */
  resolveProfileFields(profile: AccountProfile, cfg?: AppConfig): ProfileFields {
    if (profile.source.kind === 'nativeDefault') {
      const configuredDir =
        (profile.adapter === 'claude' || profile.adapter === 'codex')
          ? cfg?.adapters[profile.adapter].configDir
          : undefined;
      const d = profile.adapter === 'claude'
        ? detectClaudeAuth(configuredDir)
        : detectCodexAuth(configuredDir);
      return {
        hasCredentials: d.hasCredentials,
        baseUrl: !!d.baseUrlPresent,
        authToken: d.mode === 'authToken+BaseUrl',
        apiKey: d.mode === 'apiKey',
        provider: d.mode === 'providerKey',
      };
    }
    if (profile.source.kind === 'codexHome') {
      // codex auth is OAuth (tokens) or apiKey (OPENAI_API_KEY in auth.json); authToken/provider
      // are claude-only concepts. baseUrl comes from the dir's config.toml (readCodexAuthAt).
      const d = profile.source.dir ? readCodexAuthAt(profile.source.dir, undefined, this.resolveEnv(profile)) : null;
      return {
        hasCredentials: !!d?.hasCredentials,
        baseUrl: !!d?.baseUrlPresent,
        authToken: false,
        apiKey: d?.mode === 'apiKey',
        provider: false,
      };
    }
    const env = profile.source.path ? readEnvFile(profile.source.path) : {};
    if (profile.adapter === 'claude') {
      const d = detectClaudeEnvFile(env, cfg?.adapters.claude.configDir);
      return {
        hasCredentials: d.hasCredentials,
        baseUrl: !!d.baseUrlPresent,
        authToken: d.mode === 'authToken+BaseUrl',
        apiKey: d.mode === 'apiKey',
        provider: d.mode === 'providerKey',
      };
    }
    const provider = env.CLAUDE_CODE_USE_BEDROCK === '1' || env.CLAUDE_CODE_USE_VERTEX === '1';
    const authToken = !!env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
    const baseUrl = !!(env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL);
    return {
      hasCredentials: provider || authToken || apiKey,
      baseUrl,
      authToken,
      apiKey,
      provider,
    };
  }

  sanitizeProfile(profile: AccountProfile, active: boolean, cfg?: AppConfig): SanitizedAccountProfile {
    const profileEnv = cfg ? this.resolveEnv(profile) : undefined;
    const cliDefaultModel = cfg
      ? resolveCliDefaultModel(profile.adapter, cfg, profileEnv)
      : undefined;
    const effectiveModel = cfg
      ? resolveEffectiveModel(profile.adapter, cfg, profileEnv)
      : undefined;
    const modelOverride = cfg?.adapters[profile.adapter as SwitchableAdapter]?.model?.trim() || undefined;
    return {
      id: profile.id,
      name: profile.name,
      adapter: profile.adapter,
      authMode: profile.authMode,
      sourceKind: profile.source.kind,
      fields: this.resolveProfileFields(profile, cfg),
      active,
      ...(cliDefaultModel ? { cliDefaultModel } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
      ...(modelOverride ? { modelOverride } : {}),
    };
  }

  listSanitized(adapter: SwitchableAdapter, cfg: AppConfig): SanitizedAccountProfile[] {
    // Absence of an explicit choice means the native CLI profile everywhere else
    // (selectedProfile/resolveActiveEnv). Report that same effective state to the UI.
    const activeId = cfg.adapters[adapter].activeProfileId ?? `${adapter}:native`;
    return this.discoverProfiles(adapter, cfg).map((p) => this.sanitizeProfile(p, p.id === activeId, cfg));
  }

  /** Set the active profile for an adapter (persisted). Validates the id is discovered. */
  activate(adapter: SwitchableAdapter, profileId: string, cfg: AppConfig): AppConfig {
    const profiles = this.discoverProfiles(adapter, cfg);
    const p = profiles.find((x) => x.id === profileId);
    if (!p) throw new Error(`unknown profile id: ${profileId}`);
    cfg.adapters[adapter].activeProfileId = profileId;
    saveConfig(cfg);
    log.info('accounts: profile activated', { adapter, profileId, applied: appliesAtSpawn(adapter) });
    return cfg;
  }

  getAccountSwitchingStatus(cfg: AppConfig): AccountSwitchingStatus {
    const dir = profilesDir();
    const mk = (adapter: SwitchableAdapter) => {
      const profiles = this.listSanitized(adapter, cfg);
      const switchable = profiles.filter((p) => p.sourceKind !== 'nativeDefault');
      return {
        switchableCount: switchable.length,
        nativeDefaultPresent: profiles.some((p) => p.sourceKind === 'nativeDefault'),
        activeProfileId: cfg.adapters[adapter].activeProfileId ?? `${adapter}:native`,
        applied: appliesAtSpawn(adapter),
        profiles,
      };
    };
    const claude = mk('claude');
    const codex = mk('codex');
    const setupHint =
      claude.switchableCount === 0 && codex.switchableCount === 0
        ? `account switching not configured. claude: drop *.env files under ${dir}/claude/ ` +
          `(e.g. ANTHROPIC_AUTH_TOKEN+ANTHROPIC_BASE_URL), or set CLAUDE_CONFIG_DIR to a directory ` +
          `where the native Claude CLI already completed OAuth login. codex: run \`CODEX_HOME=<dir> codex login\` ` +
          `once per account, then drop a <name>.home file (containing the dir path) under ${dir}/codex/. ` +
          `For a custom model_provider/base_url, append the provider's env_key as KEY=VALUE lines. ` +
          `The backend reads them 0-modify and never writes keys; keys must already be valid on the PC. ` +
          `(codex auth_credentials_store_mode must be the default File; keyring mode bypasses auth.json.)`
        : undefined;
    return { profilesDir: dir, setupHint, adapters: { claude, codex } };
  }
}
