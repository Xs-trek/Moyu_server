// Config model. Public node is USER-PROVIDED (no hardcoded default, per user decision).
// S6: /config GET excludes auth/proxy/network-secret VALUES; subscription switching is
// done via discovered profiles (v3) -- the backend reads user-maintained credential sets
// 0-modify and never echoes key values. See AccountProfile / sanitizeProfile.
import { isProviderHost } from '../net/egress';

export type AdapterKind = 'claude' | 'codex' | 'opencode' | 'pty';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Per-adapter approval/account config (v2: frontend-configurable, NOT hardcoded).
// Codex contract is version-bound to codex exec --json 0.146.x; see codex/protocol.ts.
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

/**
 * Per-adapter config (v3). Frontend-configurable; adapters must NOT hardcode these.
 * - sandbox/approvalsReviewer: codex CLI config. approvalPolicy is enforced by the local
 *   PreToolUse bridge ('never' => auto-allow; all other values => remote every-tool).
 *   claude maps approvalPolicy to the same hook behavior;
 *   claude has no native sandbox/reviewer -> ignores those two (kept for interface uniformity).
 * - model: undefined => inherit CLI's own config (do not override).
 * - activeProfileId: which discovered AccountProfile is active (subscription switching).
 *   claude: the profile's env vars are injected at spawn. codex: a codexHome profile sets
 *   CODEX_HOME at spawn (codex reads its own auth.json there; 0-modify, never written);
 *   nativeDefault uses ~/.codex. Value is a profile id (never a key); frontend selects
 *   among discovered profiles only.
 */
export interface AdapterConfig {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
  model?: string;
  /** Explicit CLI binary path (overrides PATH lookup). Set when multiple CLI
   *  versions are installed and PATH ordering picks a stale one (e.g. a distro
   *  /usr/bin/codex 0.133.0 shadowing npm-global 0.146.0). undefined => which(). */
  bin?: string;
  /** Explicit native CLI configuration root. undefined => adapter-specific environment/default.
   *  Like bin, this is PC-local startup configuration and is never remotely PATCH-able. */
  configDir?: string;
  activeProfileId?: string;
}

export interface AdaptersConfig {
  claude: AdapterConfig;
  codex: AdapterConfig;
}

export const DEFAULT_ADAPTER_CONFIG: AdapterConfig = {
  approvalPolicy: 'untrusted', // every-command approval, matches claude matcher:'*'
  sandbox: 'workspace-write', // safe default; user may escalate to danger-full-access via frontend
  approvalsReviewer: 'user',
};

// ---------------------------------------------------------------------------
// v3: Account profiles (subscription switching).
//
// A profile is a REFERENCE to a user-maintained credential set on the PC -- NOT the
// key values themselves. Two sources:
//   - nativeDefault: use the CLI's own native config/env (whatever the user already set up
//     via the platform's normal login). The tool touches nothing; it just spawns the CLI.
//   - envFile: a user-authored *.env file under <datadir>/profiles/<adapter>/ holding the
//     subscription's env vars (ANTHROPIC_AUTH_TOKEN+ANTHROPIC_BASE_URL, OPENAI_API_KEY+OPENAI_BASE_URL,
//     CLAUDE_CODE_USE_BEDROCK/VERTEX + provider creds, ...). The backend reads it 0-modify and
//     injects via spawn env (claude). codex uses a codexHome profile (a CODEX_HOME directory
//     whose auth.json the user pre-created via `codex login`; the backend never writes it).
//
// Principles (user-confirmed):
//   S-key  : keys are pre-authenticated on the PC via the platform's native login; the tool
//            NEVER does first login / token exchange / OAuth flow / touches auth files for write.
//   S0mod  : backend never modifies any normal-use (CLI native) file; env-file read is read-only.
//   S0perc : the tool makes NO outbound call to any AI provider; account availability is never
//            probed. Failures surface via the normal usage flow (user input -> CLI -> frontend).
//   S6echo : key VALUES are never echoed to the frontend; only field PRESENCE.
// ---------------------------------------------------------------------------

/** How a profile authenticates against its provider (inferred, never asserted). */
export type AuthMode = 'oauth' | 'apiKey' | 'authToken+BaseUrl' | 'providerKey' | 'none';

/** Where a profile's credentials live. */
export type ProfileSourceKind = 'nativeDefault' | 'envFile' | 'codexHome';

export interface ProfileSource {
  kind: ProfileSourceKind;
  /** Absolute path to the env file (envFile only). Never contains the file's contents. */
  path?: string;
  /** Absolute path to a CODEX_HOME directory (codexHome only). Holds the user's pre-login
   *  auth.json; the backend reads it 0-modify (existence only) and never writes it. */
  dir?: string;
}

/** Field PRESENCE only -- never values (S6). Describes what the credential set contains. */
export interface ProfileFields {
  hasCredentials: boolean;
  baseUrl?: boolean;
  authToken?: boolean;
  apiKey?: boolean;
  provider?: boolean; // CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
}

export interface AccountProfile {
  id: string;
  name: string;
  adapter: AdapterKind;
  authMode: AuthMode;
  source: ProfileSource;
}

/** Sanitized profile view returned to the frontend (S6: no key values). */
export interface SanitizedAccountProfile {
  id: string;
  name: string;
  adapter: AdapterKind;
  authMode: AuthMode;
  sourceKind: ProfileSourceKind;
  fields: ProfileFields;
  active: boolean;
}

export interface AccountSwitchingAdapterStatus {
  /** Count of switchable (non-nativeDefault) profiles discovered. */
  switchableCount: number;
  nativeDefaultPresent: boolean;
  activeProfileId?: string;
  /** Is profile env actually applied at spawn for this adapter?
   *  claude=true (envFile injected); codex=true when the active profile is codexHome (CODEX_HOME
   *  set at spawn), false for nativeDefault. */
  applied: boolean;
  profiles: SanitizedAccountProfile[];
}

export interface AccountSwitchingStatus {
  profilesDir: string;
  /** Setup hint shown at init when an adapter has no switchable profiles (auto-reminder). */
  setupHint?: string;
  adapters: {
    claude: AccountSwitchingAdapterStatus;
    codex: AccountSwitchingAdapterStatus;
  };
}

export interface GatewayConfig {
  portMin: number; // default 18080
  portMax: number; // default 18099
  bindHost: string; // "127.0.0.1" preferred (S10); NOT runtime-patchable (S10)
  /** Persisted gateway port so the phone's --port-forward target is stable across
   *  restarts (F4). Resolved at startup: reused if free, else a new free port is
   *  picked + persisted. NOT runtime-patchable via /config (managed by startup). */
  gwPort?: number;
}

export interface NetworkConfig {
  /** User-provided public/relay node, e.g. "tcp://203.0.113.5:11010". NO default. */
  publicNode: string;
  /** Path to easytier-core binary (vendor/PATH). If unset, controller searches default locations. */
  easytierBin?: string;
  virtualIp?: string; // PC virtual IP, e.g. "10.144.144.1"
  backendMapCidr?: string; // virtual mapping target for backend bind, e.g. "10.1.1.10/32"
  networkName?: string; // generated if absent
  networkSecret?: string; // generated if absent; NEVER echoed in /config (S6)
  privateMode: boolean;
}

export interface PtyAddonConfig {
  enabled: boolean;
  path?: string; // path to pty.node addon (lazy load); not in sanitized view
}

export interface AppConfig {
  gateway: GatewayConfig;
  network: NetworkConfig;
  defaultAdapter: AdapterKind;
  approvalTimeoutSec: number; // MUST be < 600 (claude hook hard limit); default 120
  logLevel: LogLevel;
  ptyAddon: PtyAddonConfig;
  adapters: AdaptersConfig; // v2: per-adapter approval/account config (frontend-configurable)
  token?: string; // generated first-run, persisted locally, NEVER in /config response (S4/S6)
  /** PC-local daemon control secret. This is deliberately distinct from `token`: the phone
   *  receives the gateway token during pairing, but must never gain permission to stop the
   *  PC backend. Generated on first load, never sanitized, paired, or runtime-PATCHable. */
  controlToken?: string;
}

/** Sanitized adapter view: active profile id only, never key values (S6). */
export interface SanitizedAdapterConfig {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
  model?: string;
  bin?: string;
  configDir?: string;
  activeProfileId?: string;
}

/** Sanitized view returned by GET /config (S6: no secret values). */
export interface SanitizedConfig {
  gateway: GatewayConfig;
  network: {
    publicNode: string;
    easytierBin?: string;
    virtualIp?: string;
    backendMapCidr?: string;
    networkName?: string; // identifier only, not secret
    privateMode: boolean;
  };
  defaultAdapter: AdapterKind;
  approvalTimeoutSec: number;
  logLevel: LogLevel;
  ptyAddon: { enabled: boolean };
  adapters: {
    claude: SanitizedAdapterConfig;
    codex: SanitizedAdapterConfig;
  };
}

function sanitizeAdapter(a: AdapterConfig): SanitizedAdapterConfig {
  return {
    approvalPolicy: a.approvalPolicy,
    sandbox: a.sandbox,
    approvalsReviewer: a.approvalsReviewer,
    model: a.model,
    bin: a.bin,
    configDir: a.configDir,
    activeProfileId: a.activeProfileId,
  };
}

export function sanitizeConfig(cfg: AppConfig): SanitizedConfig {
  return {
    gateway: { ...cfg.gateway },
    network: {
      publicNode: cfg.network.publicNode,
      easytierBin: cfg.network.easytierBin,
      virtualIp: cfg.network.virtualIp,
      backendMapCidr: cfg.network.backendMapCidr,
      networkName: cfg.network.networkName,
      privateMode: cfg.network.privateMode,
    },
    defaultAdapter: cfg.defaultAdapter,
    approvalTimeoutSec: cfg.approvalTimeoutSec,
    logLevel: cfg.logLevel,
    ptyAddon: { enabled: cfg.ptyAddon.enabled },
    adapters: {
      claude: sanitizeAdapter(cfg.adapters.claude),
      codex: sanitizeAdapter(cfg.adapters.codex),
    },
  };
}

/**
 * Fields a user is allowed to PATCH at runtime. This is the AUTHORITATIVE allowlist;
 * loader.applyPick mirrors it exactly at runtime (no blind spread) so that even
 * shape-mismatched JSON cannot write secrets or dangerous fields.
 *
 * Excluded by design (F3):
 *   - network.networkSecret / network.networkName / token / controlToken: never runtime-settable
 *     (conveyed only via the authenticated pairing handoff).
 *   - network.easytierBin: binary path -> RCE vector; set via config file / init only.
 *   - network.privateMode: forced true (§2); never PATCH-able. loadConfig restores true
 *     on disk so a stale privateMode:false cannot weaken the overlay.
 *   - gateway.bindHost: must stay 127.0.0.1 (S10); never PATCH-able to 0.0.0.0.
 *   - gateway.gwPort: managed by startup port-resolution, not runtime PATCH.
 *   - adapters.*.bin/configDir: CLI executable/config sources -> code/config injection vector;
 *     set only via the PC-local config file / init.
 */
export interface ConfigPatch {
  gateway?: Partial<Pick<GatewayConfig, 'portMin' | 'portMax'>>;
  network?: Partial<Pick<NetworkConfig, 'publicNode' | 'virtualIp' | 'backendMapCidr'>>;
  defaultAdapter?: AdapterKind;
  approvalTimeoutSec?: number;
  logLevel?: LogLevel;
  ptyAddon?: Partial<Pick<PtyAddonConfig, 'enabled'>>;
  adapters?: {
    claude?: Partial<Pick<AdapterConfig, 'approvalPolicy' | 'sandbox' | 'approvalsReviewer' | 'model' | 'activeProfileId'>>;
    codex?: Partial<Pick<AdapterConfig, 'approvalPolicy' | 'sandbox' | 'approvalsReviewer' | 'model' | 'activeProfileId'>>;
  };
}

/** Runtime validation of a /config PATCH (review P2): applyPatch trusts the JSON shape, so a
 *  string approvalTimeoutSec -> NaN or a bad enum could persist into runtime config. Returns a
 *  list of human-readable errors (empty = valid). applyPatch still clamps defensively, but this
 *  gates a 400 response before any mutation. Unknown keys are ignored (applyPatch allowlists). */
const ADAPTER_KINDS: readonly AdapterKind[] = ['claude', 'codex', 'opencode', 'pty'];
/** Adapters enabled by default at runtime (§4). opencode is experiment-gated (not registered
 *  unless MOYU_EXPERIMENT_OPENCODE=1); pty is not a selectable backend. defaultAdapter and
 *  server/info only expose this enabled set. The AdapterKind type still includes opencode/pty
 *  so the opencode interface code can be retained without being active. */
export const ENABLED_ADAPTER_KINDS: readonly AdapterKind[] = ['claude', 'codex'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['untrusted', 'on-failure', 'on-request', 'never'];
const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const REVIEWERS: readonly ApprovalsReviewer[] = ['user', 'auto_review', 'guardian_subagent'];

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}
function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

export function validateConfigPatch(patch: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObj(patch)) return ['patch must be a JSON object'];
  if (patch.gateway !== undefined) {
    const gw = patch.gateway;
    if (!isPlainObj(gw)) errors.push('gateway must be an object');
    else {
      if (gw.portMin !== undefined && !isInt(gw.portMin)) errors.push('gateway.portMin must be an integer');
      if (gw.portMax !== undefined && !isInt(gw.portMax)) errors.push('gateway.portMax must be an integer');
      if (isInt(gw.portMin) && (gw.portMin < 1 || gw.portMin > 65535)) errors.push('gateway.portMin out of range 1-65535');
      if (isInt(gw.portMax) && (gw.portMax < 1 || gw.portMax > 65535)) errors.push('gateway.portMax out of range 1-65535');
      if (isInt(gw.portMin) && isInt(gw.portMax) && gw.portMin > gw.portMax) errors.push('gateway.portMin must be <= portMax');
    }
  }
  if (patch.network !== undefined) {
    const net = patch.network;
    if (!isPlainObj(net)) errors.push('network must be an object');
    else {
      if (net.publicNode !== undefined && (!isStr(net.publicNode) || net.publicNode.length > 256)) errors.push('network.publicNode must be a string <= 256 chars');
      else if (isStr(net.publicNode) && isProviderHost(net.publicNode)) errors.push('network.publicNode must be a relay node, not a known AI-provider host');
      if (net.virtualIp !== undefined && (!isStr(net.virtualIp) || net.virtualIp.length > 64)) errors.push('network.virtualIp must be a string <= 64 chars');
      if (net.backendMapCidr !== undefined && (!isStr(net.backendMapCidr) || net.backendMapCidr.length > 64)) errors.push('network.backendMapCidr must be a string <= 64 chars');
      // network.privateMode is intentionally NOT validated here: §2 removed it from
      // ConfigPatch (forced true, never PATCH-able). An unknown key is ignored by applyPatch.
    }
  }
  if (patch.defaultAdapter !== undefined && !ENABLED_ADAPTER_KINDS.includes(patch.defaultAdapter as AdapterKind)) errors.push('defaultAdapter must be one of claude|codex (only enabled adapters; opencode/pty are not runtime-selectable, §4)');
  if (patch.approvalTimeoutSec !== undefined && !(isInt(patch.approvalTimeoutSec) && patch.approvalTimeoutSec >= 10 && patch.approvalTimeoutSec <= 590)) errors.push('approvalTimeoutSec must be an integer 10-590');
  if (patch.logLevel !== undefined && !LOG_LEVELS.includes(patch.logLevel as LogLevel)) errors.push('logLevel must be one of debug|info|warn|error');
  if (patch.ptyAddon !== undefined) {
    if (!isPlainObj(patch.ptyAddon)) errors.push('ptyAddon must be an object');
    else if (patch.ptyAddon.enabled !== undefined && !isBool(patch.ptyAddon.enabled)) errors.push('ptyAddon.enabled must be a boolean');
  }
  if (patch.adapters !== undefined) {
    if (!isPlainObj(patch.adapters)) errors.push('adapters must be an object');
    else
      for (const k of ['claude', 'codex'] as const) {
        const a = (patch.adapters as Record<string, unknown>)[k];
        if (a === undefined) continue;
        if (!isPlainObj(a)) {
          errors.push(`adapters.${k} must be an object`);
          continue;
        }
        if (a.approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(a.approvalPolicy as ApprovalPolicy)) errors.push(`adapters.${k}.approvalPolicy must be one of untrusted|on-failure|on-request|never`);
        if (a.sandbox !== undefined && !SANDBOX_MODES.includes(a.sandbox as SandboxMode)) errors.push(`adapters.${k}.sandbox must be one of read-only|workspace-write|danger-full-access`);
        if (a.approvalsReviewer !== undefined && !REVIEWERS.includes(a.approvalsReviewer as ApprovalsReviewer)) errors.push(`adapters.${k}.approvalsReviewer must be one of user|auto_review|guardian_subagent`);
        if (a.model !== undefined && (!isStr(a.model) || a.model.length > 128)) errors.push(`adapters.${k}.model must be a string <= 128 chars`);
        if (a.activeProfileId !== undefined && (!isStr(a.activeProfileId) || a.activeProfileId.length > 256)) errors.push(`adapters.${k}.activeProfileId must be a string <= 256 chars`);
      }
  }
  return errors;
}
