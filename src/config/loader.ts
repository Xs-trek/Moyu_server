// Config loader: local JSON (mode 0600), env override, first-run generation of
// token / networkSecret / networkName. Never logs secret values (logger redacts).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AppConfig, ConfigPatch } from './schema';
import { DEFAULT_ADAPTER_CONFIG } from './schema';
import { log } from '../util/logger';

const DEFAULT_CONFIG_PATH = join(homedir(), '.remote-dashboard', 'config.json');

/**
 * Active config file path. Set by loadConfig() so the server (and /config PATCH)
 * persist to the same file it loaded. Resolution precedence: explicit -config arg
 * > REMOTE_DASHBOARD_CONFIG env > ~/.remote-dashboard/config.json.
 */
let activePath: string | null = null;

function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const fromEnv = process.env.REMOTE_DASHBOARD_CONFIG;
  return fromEnv ? resolve(fromEnv) : DEFAULT_CONFIG_PATH;
}

export function configPath(explicit?: string): string {
  return activePath ?? resolveConfigPath(explicit);
}

const DEFAULTS: AppConfig = {
  gateway: { portMin: 18080, portMax: 18099, bindHost: '127.0.0.1' },
  network: { publicNode: '', privateMode: true },
  defaultAdapter: 'claude',
  approvalTimeoutSec: 120,
  logLevel: 'info',
  ptyAddon: { enabled: false },
  adapters: {
    claude: { ...DEFAULT_ADAPTER_CONFIG },
    codex: { ...DEFAULT_ADAPTER_CONFIG },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return base;
  const b = base as Record<string, unknown>;
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(b[k]) && isPlainObject(v) ? deepMerge(b[k], v) : v;
  }
  return out as T;
}

export function loadConfig(path?: string, opts: { generate?: boolean } = {}): AppConfig {
  const cfgPath = resolveConfigPath(path);
  activePath = cfgPath;
  let loaded: unknown = {};
  if (existsSync(cfgPath)) {
    try {
      loaded = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      log.warn('config parse failed, using defaults', { err: String(e) });
    }
  }
  const cfg = deepMerge(DEFAULTS, loaded);

  // §2: private mode is forced + immutable. A stale on-disk config carrying
  // privateMode:false (or missing it) is restored to true at startup. The force is
  // in-memory regardless of `generate`; persistence only happens when generate !== false.
  let dirty = false;
  // N4: port range contract. min>max is an invalid config (the hand-edited config.json path;
  // PATCH is already rejected by validateConfigPatch). Fail-safe to defaults + warn rather than
  // fail-fast -- failing fast would deadlock the user (backend can't start -> can't PATCH repair).
  // Persist the corrected range so the on-disk config is also fixed.
  if (cfg.gateway.portMin > cfg.gateway.portMax) {
    log.warn('gateway port range invalid (min>max), using defaults', {
      portMin: cfg.gateway.portMin,
      portMax: cfg.gateway.portMax,
    });
    cfg.gateway = { ...DEFAULTS.gateway };
    dirty = true;
  }
  if (cfg.gateway.bindHost !== '127.0.0.1') {
    log.warn('gateway bindHost must remain loopback; restoring 127.0.0.1');
    cfg.gateway.bindHost = '127.0.0.1';
    dirty = true;
  }
  if (cfg.network.privateMode !== true) {
    cfg.network.privateMode = true;
    dirty = true;
  }

  if (opts.generate !== false) {
    // First-run generation of secrets/identifiers.
    if (!cfg.token) {
      cfg.token = randomBytes(32).toString('hex');
      dirty = true;
    }
    if (!cfg.controlToken) {
      cfg.controlToken = randomBytes(32).toString('hex');
      dirty = true;
    }
    if (!cfg.network.networkSecret) {
      cfg.network.networkSecret = randomBytes(24).toString('hex');
      dirty = true;
    }
    if (!cfg.network.networkName) {
      cfg.network.networkName = 'rd-' + randomBytes(4).toString('hex');
      dirty = true;
    }
    // approval timeout must stay under claude hook hard limit (600s).
    if (cfg.approvalTimeoutSec >= 600) {
      cfg.approvalTimeoutSec = 590;
      dirty = true;
    }
    if (dirty) saveConfig(cfg);
  }
  return cfg;
}

export function saveConfig(cfg: AppConfig): void {
  const cfgPath = activePath ?? resolveConfigPath();
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  if (platform() !== 'win32') {
    try {
      chmodSync(cfgPath, 0o600);
    } catch {
      // best-effort
    }
  }
  log.info('config persisted', { path: cfgPath });
}

/**
 * Apply a user PATCH. Runtime allowlist mirrors ConfigPatch exactly (F3): only the
 * explicitly-listed fields are copied; secrets (networkSecret/networkName/token/controlToken),
 * binary paths (easytierBin, adapters.*.bin), bindHost, and gwPort are NEVER written
 * here regardless of what JSON arrives. No blind object spread on patch sub-objects.
 */
export function applyPatch(cfg: AppConfig, patch: ConfigPatch): AppConfig {
  const gw = patch.gateway ?? {};
  const net = patch.network ?? {};
  const cla = patch.adapters?.claude ?? {};
  const cod = patch.adapters?.codex ?? {};
  const next: AppConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      ...(gw.portMin !== undefined ? { portMin: gw.portMin } : {}),
      ...(gw.portMax !== undefined ? { portMax: gw.portMax } : {}),
    },
    network: {
      ...cfg.network,
      ...(net.publicNode !== undefined ? { publicNode: net.publicNode } : {}),
      ...(net.virtualIp !== undefined ? { virtualIp: net.virtualIp } : {}),
      ...(net.backendMapCidr !== undefined ? { backendMapCidr: net.backendMapCidr } : {}),
      // privateMode intentionally NOT copied: §2 forces true + it is not PATCH-able.
      // Always re-assert true so a PATCH can never weaken the overlay via this path.
      privateMode: true,
    },
    defaultAdapter: patch.defaultAdapter ?? cfg.defaultAdapter,
    approvalTimeoutSec:
      patch.approvalTimeoutSec !== undefined
        ? Math.min(Math.max(10, patch.approvalTimeoutSec), 590)
        : cfg.approvalTimeoutSec,
    logLevel: patch.logLevel ?? cfg.logLevel,
    ptyAddon: {
      ...cfg.ptyAddon,
      ...(patch.ptyAddon?.enabled !== undefined ? { enabled: patch.ptyAddon.enabled } : {}),
    },
    adapters: {
      claude: pickAdapter(cfg.adapters.claude, cla),
      codex: pickAdapter(cfg.adapters.codex, cod),
    },
  };
  saveConfig(next);
  return next;
}

/** Copy only allowlisted adapter fields; never bin (RCE vector). */
function pickAdapter(
  base: AppConfig['adapters']['claude'],
  p: NonNullable<NonNullable<ConfigPatch['adapters']>['claude']>,
): AppConfig['adapters']['claude'] {
  return {
    ...base,
    ...(p.approvalPolicy !== undefined ? { approvalPolicy: p.approvalPolicy } : {}),
    ...(p.sandbox !== undefined ? { sandbox: p.sandbox } : {}),
    ...(p.approvalsReviewer !== undefined ? { approvalsReviewer: p.approvalsReviewer } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.activeProfileId !== undefined ? { activeProfileId: p.activeProfileId } : {}),
  };
}
