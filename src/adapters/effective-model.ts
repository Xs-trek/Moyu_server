// Read-only resolution of the model selected by each native CLI configuration. The resolved
// value is display metadata only: adapters must not turn it into a --model override unless the
// user explicitly configured/requested that override.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterKind, AppConfig } from '../config/schema';
import { normalizeConfigPath } from './config-location';
import { resolveClaudeConfigDir } from './claude/auth';
import { resolveCodexConfigDir } from './codex/auth';

const MAX_CONFIG_BYTES = 1024 * 1024;
export const MAX_MODEL_ID_CHARS = 128;

function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_MODEL_ID_CHARS ? normalized : undefined;
}

function readSmallText(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

export function effectiveConfigDir(
  kind: 'claude' | 'codex',
  configuredDir: string | undefined,
  profileEnv: Record<string, string> | undefined,
): string {
  const envKey = kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const selected = profileEnv?.[envKey];
  if (selected?.trim()) return normalizeConfigPath(selected);
  return kind === 'claude' ? resolveClaudeConfigDir(configuredDir) : resolveCodexConfigDir(configuredDir);
}

export function resolveClaudeEffectiveModel(opts: {
  configuredDir?: string;
  profileEnv?: Record<string, string>;
  explicitModel?: string;
}): string | undefined {
  const dir = effectiveConfigDir('claude', opts.configuredDir, opts.profileEnv);
  let settingsModel: string | undefined;
  let settingsEnv: Record<string, string> = {};
  const text = readSmallText(join(dir, 'settings.json'));
  if (text) {
    try {
      const settings = JSON.parse(text) as { model?: unknown; env?: unknown };
      settingsModel = modelId(settings.model);
      settingsEnv = stringRecord(settings.env);
    } catch {
      // A malformed native settings file is Claude's concern; display resolution stays unknown.
    }
  }

  const requested = modelId(opts.explicitModel) ?? settingsModel;
  if (!requested) return undefined;
  // Claude's native alias indirection is commonly used by compatible endpoints, e.g.
  // model="opus" + ANTHROPIC_DEFAULT_OPUS_MODEL="glm-5.2". Profile env wins because that is
  // exactly what the selected session adds to the native CLI process.
  const env: Record<string, string | undefined> = {
    ...settingsEnv,
    ...process.env,
    ...(opts.profileEnv ?? {}),
  };
  const alias = requested.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const resolved = env[`ANTHROPIC_DEFAULT_${alias}_MODEL`];
  return modelId(resolved) ?? requested;
}

function parseRootTomlModel(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Only the root model is the native default. A `model` inside a profile/provider table is
    // not necessarily active and must not be advertised as the current model.
    if (trimmed.startsWith('[')) break;
    const doubleQuoted = /^model\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/.exec(trimmed);
    if (doubleQuoted) {
      try {
        const value = JSON.parse(doubleQuoted[1]!) as unknown;
        return modelId(value);
      } catch {
        return undefined;
      }
    }
    const singleQuoted = /^model\s*=\s*'([^']+)'\s*(?:#.*)?$/.exec(trimmed);
    const singleValue = modelId(singleQuoted?.[1]);
    if (singleValue) return singleValue;
  }
  return undefined;
}

export function resolveCodexEffectiveModel(opts: {
  configuredDir?: string;
  profileEnv?: Record<string, string>;
  explicitModel?: string;
}): string | undefined {
  const explicit = modelId(opts.explicitModel);
  if (explicit) return explicit;
  const dir = effectiveConfigDir('codex', opts.configuredDir, opts.profileEnv);
  const text = readSmallText(join(dir, 'config.toml'));
  return text ? parseRootTomlModel(text) : undefined;
}

export function resolveEffectiveModel(
  kind: AdapterKind,
  config: AppConfig,
  profileEnv?: Record<string, string>,
  explicitModel?: string,
): string | undefined {
  if (kind === 'claude') {
    return resolveClaudeEffectiveModel({
      configuredDir: config.adapters.claude.configDir,
      profileEnv,
      explicitModel: explicitModel ?? config.adapters.claude.model,
    });
  }
  if (kind === 'codex') {
    return resolveCodexEffectiveModel({
      configuredDir: config.adapters.codex.configDir,
      profileEnv,
      explicitModel: explicitModel ?? config.adapters.codex.model,
    });
  }
  return explicitModel;
}

/** Resolve only the profile-local CLI default, deliberately ignoring the persisted Moyu model
 * override. This is presentation metadata used to label "CLI default" accurately. */
export function resolveCliDefaultModel(
  kind: AdapterKind,
  config: AppConfig,
  profileEnv?: Record<string, string>,
): string | undefined {
  if (kind === 'claude') {
    return resolveClaudeEffectiveModel({ configuredDir: config.adapters.claude.configDir, profileEnv });
  }
  if (kind === 'codex') {
    return resolveCodexEffectiveModel({ configuredDir: config.adapters.codex.configDir, profileEnv });
  }
  return undefined;
}
