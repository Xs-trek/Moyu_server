// Leveled logger with secret redaction (S4: no key value ever logged).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let currentLevel = LEVELS.info;

export function setLogLevel(l: LogLevel): void {
  currentLevel = LEVELS[l] ?? LEVELS.info;
}

const SECRET_KEYS =
  /^(secret|token|apikey|api_key|key|password|passwd|auth|authorization|credentials?|networksecret|network_secret|base_url|baseurl|anthropic_api_key|anthropic_auth_token|openai_api_key)$/i;

// Value-level secret masking for string leaves. Secret-named keys are already redacted
// above, but a credential can also appear inside an arbitrary string value -- most importantly
// subprocess stderr logged as {line: rawText}, where a CLI error may embed a token, auth header,
// or key. Without this, S4 (no key value ever logged) is violated for any secret that rides
// inside a non-secret-named string. Patterns mirror accounts/service.ts redactSecrets.
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer ***'],
  [/eyJ[A-Za-z0-9._-]{8,}/g, 'eyJ***'], // JWT-ish
  // 32+ consecutive hex chars: API keys / hashes. UUIDs (with dashes) and short hex don't match.
  [/[A-Fa-f0-9]{32,}/g, '***'],
];

// Exact-value secret registry (review P1): pattern masking misses arbitrary-format tokens
// (AWS-style keys, base64 creds, custom provider keys) that ride inside CLI stderr. Adapters
// register the active profile's actual sensitive values (profileEnv values + hook secret) via
// registerSecrets(); any exact match is then masked regardless of format. The set accumulates
// across sessions -- more masked is always safer than less, and a stale entry harms nothing.
const registeredSecrets = new Set<string>();
export function registerSecrets(...vals: string[]): void {
  for (const v of vals) {
    if (typeof v === 'string' && v.length >= 8) registeredSecrets.add(v);
  }
}
export function clearSecrets(): void {
  registeredSecrets.clear();
}

function maskSecretsInString(s: string): string {
  let out = s;
  // Exact-replace registered secrets first (arbitrary format: AWS keys, base64, custom tokens).
  if (registeredSecrets.size > 0) {
    for (const secret of registeredSecrets) {
      if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join('***');
    }
  }
  for (const [re, repl] of SECRET_VALUE_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Credential-bearing env-key detector (§5). Matches the user-named secret categories
 *  *KEY* / *TOKEN* / *SECRET* / *PASSWORD* / *AUTHORIZATION*. Tighter than SECRET_KEYS (which
 *  also covers base_url etc. for field redaction) so we register only real credential values. */
const CREDENTIAL_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i;

/** Register every credential-bearing value from a subprocess env (§5). Covers nativeDefault
 *  (the CLI's inherited process.env), Codex, and custom Provider env formats -- not just Claude
 *  profileEnv. Arbitrary-format tokens (AWS keys, base64 creds, custom provider keys) are
 *  registered by KEY NAME so their exact values are masked wherever they later appear in logs. */
export function registerEnvSecrets(env: Record<string, string> | NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && CREDENTIAL_ENV_KEY.test(k)) registerSecrets(v);
  }
}

/** Best-effort error category from a subprocess stderr blob (§5). Never asserts; 'unknown' is
 *  the safe fallback so a category is always loggable without leaking raw text. */
export type FailureCategory = 'auth' | 'rate-limit' | 'network' | 'not-found' | 'parse' | 'unknown';

export interface SafeFailure {
  category: FailureCategory;
  summary: string;
}

export function categorizeError(text: string): FailureCategory {
  const t = (text ?? '').toLowerCase();
  if (/unauthor|401|auth(?:enticat|orizar|ority)?[\s_-]*(?:fail|error|denied)|invalid.{0,12}(?:api[-_ ]?key|token)|expired.{0,8}token|forbidden|403/.test(t)) return 'auth';
  if (/rate.?limit|429|too many requests|quota/.test(t)) return 'rate-limit';
  if (/network|econnrefused|enotfound|etimedout|timeout|unreachable|dns|connection reset|broken pipe/.test(t)) return 'network';
  if (/not found|no such file|enoent|command not found|is not recognized/.test(t)) return 'not-found';
  if (/syntax|parse|unexpected token|invalid json/.test(t)) return 'parse';
  return 'unknown';
}

/** Fixed-length, secret-redacted safe summary of subprocess stderr (§5). This is the ONLY form
 *  in which stderr text may reach logs: raw stderr is never logged directly. Registered env
 *  secrets + value patterns are masked first, whitespace collapsed, then hard-truncated. */
export function safeStderrSummary(text: string, maxLen = 200): string {
  const redacted = maskSecretsInString(text ?? '').replace(/\s+/g, ' ').trim();
  return redacted.length > maxLen ? redacted.slice(0, maxLen) + '…' : redacted;
}

/** Convert an internal/CLI error to the only failure shape allowed on REST/WS.
 * Non-string objects are intentionally not serialized because they may contain credentials. */
export function safeFailure(error: unknown, fallback = 'operation failed'): SafeFailure {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return {
    category: categorizeError(text),
    summary: safeStderrSummary(text) || fallback,
  };
}

function redact(v: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof v === 'string') return maskSecretsInString(v);
  if (typeof v !== 'object' || v === null) return v;
  if (seen.has(v as object)) return '[Circular]';
  seen.add(v as object);
  if (Array.isArray(v)) return v.map((x) => redact(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? (val == null ? null : '[REDACTED]') : redact(val, seen);
  }
  return out;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(redact(v));
  } catch {
    return String(v);
  }
}

function fmt(level: LogLevel, msg: string, ctx?: unknown): string {
  const ts = new Date().toISOString();
  const c = ctx !== undefined ? ' ' + safeJson(ctx) : '';
  return `[${ts}] ${level.toUpperCase()} ${msg}${c}`;
}

export const log = {
  debug: (m: string, ctx?: unknown): void => {
    if (currentLevel <= LEVELS.debug) process.stdout.write(fmt('debug', m, ctx) + '\n');
  },
  info: (m: string, ctx?: unknown): void => {
    if (currentLevel <= LEVELS.info) process.stdout.write(fmt('info', m, ctx) + '\n');
  },
  warn: (m: string, ctx?: unknown): void => {
    if (currentLevel <= LEVELS.warn) process.stderr.write(fmt('warn', m, ctx) + '\n');
  },
  error: (m: string, ctx?: unknown): void => {
    if (currentLevel <= LEVELS.error) process.stderr.write(fmt('error', m, ctx) + '\n');
  },
};
