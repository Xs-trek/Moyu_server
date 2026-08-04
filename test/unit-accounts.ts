// Offline unit test: v3 accounts/profile service. No real provider, no CLI spawn, NO network
// probe (C3: the tool makes no outbound call to any AI provider; account availability is never
// tested by the backend -- failures surface through the normal session event flow). Uses a temp
// config dir (REMOTE_DASHBOARD_CONFIG).
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = join(tmpdir(), `rd-acc-test-${process.pid}`);
const CONFIG = join(TMP, 'config.json');
process.env.REMOTE_DASHBOARD_CONFIG = CONFIG; // MUST be set before importing loader/service

const { AccountService } = await import('../src/accounts/service');
const { configPath, loadConfig } = await import('../src/config/loader');
const profilesDir = join(dirname(configPath()), 'profiles');

function writeEnv(adapter: string, name: string, vars: Record<string, string>): void {
  const dir = join(profilesDir, adapter);
  mkdirSync(dir, { recursive: true });
  const body = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(join(dir, `${name}.env`), body + '\n');
}

/** Write a codex <name>.home file whose content is a CODEX_HOME dir path (path 1). */
function writeHome(name: string, homeDir: string): void {
  const dir = join(profilesDir, 'codex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.home`), homeDir + '\n');
}

const checks: [string, boolean][] = [];
function check(name: string, ok: boolean): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!ok) checks.push([name, false]);
}

async function main(): Promise<void> {
  const acc = new AccountService();

  // 1. Discovery with no profiles dir -> only nativeDefault.
  rmSync(profilesDir, { recursive: true, force: true });
  let claudeProfiles = acc.discoverProfiles('claude');
  check('discovery: nativeDefault present when dir absent', claudeProfiles.some((p) => p.source.kind === 'nativeDefault'));
  check('discovery: only nativeDefault when dir absent', claudeProfiles.length === 1);

  // 2. Discovery picks up env files; authMode inferred.
  writeEnv('claude', 'anthropic-key', { ANTHROPIC_API_KEY: 'sk-ant-test-KEYVALUE', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
  writeEnv('claude', 'anthropic-token', { ANTHROPIC_AUTH_TOKEN: 'sk-test-TOKENVALUE', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
  writeEnv('claude', 'bedrock', { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' });
  claudeProfiles = acc.discoverProfiles('claude');
  const byId = new Map(claudeProfiles.map((p) => [p.id, p]));
  check('discovery: env profiles discovered (3 + native)', claudeProfiles.length === 4);
  check('authMode apiKey inferred', byId.get('claude:env:anthropic-key')?.authMode === 'apiKey');
  check('authMode authToken+BaseUrl inferred', byId.get('claude:env:anthropic-token')?.authMode === 'authToken+BaseUrl');
  check('authMode providerKey inferred', byId.get('claude:env:bedrock')?.authMode === 'providerKey');

  // 3. Sanitize: field PRESENCE only; key VALUES never echoed.
  const cfg0 = loadConfig();
  const sanitized = acc.listSanitized('claude', cfg0);
  const blob = JSON.stringify(sanitized);
  check('sanitize: no key value echoed (KEYVALUE)', !blob.includes('KEYVALUE'));
  check('sanitize: no key value echoed (TOKENVALUE)', !blob.includes('TOKENVALUE'));
  check('sanitize: fields.hasCredentials true for apiKey profile', sanitized.find((p) => p.id === 'claude:env:anthropic-key')?.fields.apiKey === true);
  check('sanitize: fields.baseUrl true for apiKey profile', sanitized.find((p) => p.id === 'claude:env:anthropic-key')?.fields.baseUrl === true);
  check('sanitize: fields.provider true for bedrock profile', sanitized.find((p) => p.id === 'claude:env:bedrock')?.fields.provider === true);

  // 4. resolveEnv: nativeDefault -> {}; envFile -> values present.
  check('resolveEnv nativeDefault is empty', Object.keys(acc.resolveEnv(byId.get('claude:native')!)).length === 0);
  const envVars = acc.resolveEnv(byId.get('claude:env:anthropic-key')!);
  check('resolveEnv envFile has ANTHROPIC_API_KEY', envVars.ANTHROPIC_API_KEY === 'sk-ant-test-KEYVALUE');
  check('resolveEnv envFile has ANTHROPIC_BASE_URL', envVars.ANTHROPIC_BASE_URL === 'http://127.0.0.1:1');

  // 5. resolveActiveEnv defaults to {} (native) when no active profile.
  check('resolveActiveEnv empty when no active profile', Object.keys(acc.resolveActiveEnv('claude', cfg0)).length === 0);

  // 6. activate persists activeProfileId; resolveActiveEnv returns the profile's env.
  acc.activate('claude', 'claude:env:anthropic-token', cfg0);
  check('activate sets activeProfileId', cfg0.adapters.claude.activeProfileId === 'claude:env:anthropic-token');
  const activeEnv = acc.resolveActiveEnv('claude', cfg0);
  check('resolveActiveEnv after activate returns token', activeEnv.ANTHROPIC_AUTH_TOKEN === 'sk-test-TOKENVALUE');
  const reloaded = loadConfig();
  check('activate persisted to config file', reloaded.adapters.claude.activeProfileId === 'claude:env:anthropic-token');
  cfg0.adapters.claude.activeProfileId = undefined;

  // 7. getAccountSwitchingStatus: counts + applied flag + setupHint logic.
  rmSync(join(profilesDir, 'codex'), { recursive: true, force: true });
  rmSync(join(profilesDir, 'claude'), { recursive: true, force: true });
  const statusEmpty = acc.getAccountSwitchingStatus(cfg0);
  check('status: empty -> setupHint present', typeof statusEmpty.setupHint === 'string');
  check('status: claude applied=true', statusEmpty.adapters.claude.applied === true);
  check('status: codex applied=true (no longer reserved)', statusEmpty.adapters.codex.applied === true);
  check('status: profilesDir echoed', statusEmpty.profilesDir === profilesDir);
  const layout = acc.ensureProfileLayout();
  check('init automation: creates Claude profile dir', layout.claude === join(profilesDir, 'claude') && existsSync(layout.claude));
  check('init automation: creates Codex profile dir', layout.codex === join(profilesDir, 'codex') && existsSync(layout.codex));

  // 8. codex codexHome profile (path 1: per-account CODEX_HOME dirs). The backend reads the
  //    dir's auth.json 0-modify (existence/fields only) and injects { CODEX_HOME } at spawn;
  //    it NEVER writes the auth file (user pre-login'd via `CODEX_HOME=<dir> codex login`).
  rmSync(join(profilesDir, 'codex'), { recursive: true, force: true });
  const codexHomeB = join(TMP, 'codex-home-acctB');
  mkdirSync(codexHomeB, { recursive: true });
  writeFileSync(
    join(codexHomeB, 'auth.json'),
    JSON.stringify({
      auth_mode: 'Chatgpt',
      tokens: { id_token: 'eyJ-test-IDTOKEN', access_token: 'test-access-TOKENVALUE', refresh_token: 'test-refresh-TOKENVALUE', account_id: 'acctB' },
      last_refresh: '2026-07-31T00:00:00Z',
    }),
  );
  writeHome('acctB', codexHomeB);
  const codexProfiles = acc.discoverProfiles('codex');
  const codexBy = new Map(codexProfiles.map((p) => [p.id, p]));
  check('codexHome: nativeDefault + acctB discovered', codexProfiles.length === 2);
  check('codexHome: acctB sourceKind codexHome', codexBy.get('codex:home:acctB')?.source.kind === 'codexHome');
  check('codexHome: acctB authMode oauth inferred', codexBy.get('codex:home:acctB')?.authMode === 'oauth');
  check('codexHome: acctB dir captured', codexBy.get('codex:home:acctB')?.source.dir === codexHomeB);
  const codexEnv = acc.resolveEnv(codexBy.get('codex:home:acctB')!);
  check('codexHome: resolveEnv returns CODEX_HOME', codexEnv.CODEX_HOME === codexHomeB);
  check('codexHome: resolveEnv has no token values', !JSON.stringify(codexEnv).includes('TOKENVALUE'));
  const codexSan = acc.listSanitized('codex', cfg0);
  const codexBlob = JSON.stringify(codexSan);
  check('codexHome: sanitize no access/refresh token echoed', !codexBlob.includes('TOKENVALUE'));
  check('codexHome: sanitize no id token echoed', !codexBlob.includes('IDTOKEN'));
  check('codexHome: fields.hasCredentials true', codexSan.find((p) => p.id === 'codex:home:acctB')?.fields.hasCredentials === true);
  acc.activate('codex', 'codex:home:acctB', cfg0);
  check('codexHome: activate sets activeProfileId', cfg0.adapters.codex.activeProfileId === 'codex:home:acctB');
  const codexActiveEnv = acc.resolveActiveEnv('codex', cfg0);
  check('codexHome: resolveActiveEnv returns CODEX_HOME after activate', codexActiveEnv.CODEX_HOME === codexHomeB);
  const codexStatus = acc.getAccountSwitchingStatus(cfg0);
  check('codexHome: codex applied=true (no longer reserved)', codexStatus.adapters.codex.applied === true);
  check('codexHome: codex switchableCount=1', codexStatus.adapters.codex.switchableCount === 1);
  cfg0.adapters.codex.activeProfileId = undefined;

  // 9. (audit, C3) AccountService exposes NO probe method -- the tool makes no provider call.
  //    Account availability is learned only through real CLI session outcomes (normal flow).
  check('audit: no probe method on AccountService', typeof (acc as unknown as { probe?: unknown }).probe !== 'function');
  check('audit: no probeById method on AccountService', typeof (acc as unknown as { probeById?: unknown }).probeById !== 'function');

  rmSync(TMP, { recursive: true, force: true });

  const fail = checks.length;
  const summary = `\nACCOUNTS UNIT: ${fail === 0 ? `ALL PASS` : fail + ' FAILED'}\n`;
  process.stdout.write(summary, () => process.exit(fail === 0 ? 0 : 1));
}

void main();
