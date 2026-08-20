// Focused offline coverage for adapter config-directory precedence, native auth detection and
// spawn-env propagation. No CLI spawn and no provider/network call.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectClaudeAuth, resolveClaudeConfigLocation } from '../src/adapters/claude/auth';
import { detectCodexAuth, resolveCodexConfigLocation } from '../src/adapters/codex/auth';
import { mergeConfigDirectoryEnv } from '../src/adapters/config-location';
import { buildClaudeSpawnEnv } from '../src/adapters/claude/session';
import { AccountService } from '../src/accounts/service';
import { loadConfig } from '../src/config/loader';

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`  ${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failed++;
}

const root = join(tmpdir(), `moyu-auth-locations-${process.pid}-${Date.now()}`);
const claudeDir = join(root, 'Claude Config With Spaces');
const claudeOauthDir = join(root, 'claude-oauth-profile');
const codexDir = join(root, 'codex-home');
mkdirSync(claudeDir, { recursive: true });
mkdirSync(claudeOauthDir, { recursive: true });
mkdirSync(codexDir, { recursive: true });

const savedEnv = {
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

try {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;

  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'unit-secret-never-echo',
      ANTHROPIC_BASE_URL: 'https://relay.invalid',
    },
  }));
  const claude = detectClaudeAuth(claudeDir);
  check('Claude detects settings.json.env auth token', claude.mode === 'authToken+BaseUrl');
  check('Claude detects settings.json.env base URL presence', claude.baseUrlPresent === true);
  check('Claude auth result contains no credential value', !JSON.stringify(claude).includes('unit-secret'));

  writeFileSync(join(claudeOauthDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'unit-oauth-secret-never-echo' },
  }));
  const claudeOauth = detectClaudeAuth(claudeOauthDir, { CLAUDE_CONFIG_DIR: claudeOauthDir });
  check('Claude detects OAuth in profile CLAUDE_CONFIG_DIR', claudeOauth.mode === 'oauth');
  check('Claude OAuth profile result contains no credential value', !JSON.stringify(claudeOauth).includes('unit-oauth-secret'));
  const claudeTokenOauth = detectClaudeAuth(codexDir, {
    CLAUDE_CONFIG_DIR: codexDir,
    CLAUDE_CODE_OAUTH_TOKEN: 'selected-oauth-token-never-echo',
  });
  check('Claude detects setup-token OAuth profiles', claudeTokenOauth.mode === 'oauth');
  check('Claude setup-token result contains no credential value', !JSON.stringify(claudeTokenOauth).includes('selected-oauth-token'));

  const inheritedClaudeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'native-key-must-not-leak',
    ANTHROPIC_AUTH_TOKEN: 'native-token-must-not-leak',
    ANTHROPIC_BASE_URL: 'https://native-relay.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'native-oauth-must-not-leak',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    AWS_REGION: 'us-east-1',
  };
  const oauthSpawn = buildClaudeSpawnEnv(
    { CLAUDE_CONFIG_DIR: claudeOauthDir },
    true,
    inheritedClaudeEnv,
  );
  check('Claude OAuth profile clears inherited API key', oauthSpawn.ANTHROPIC_API_KEY === undefined);
  check('Claude OAuth profile clears inherited auth token', oauthSpawn.ANTHROPIC_AUTH_TOKEN === undefined);
  check('Claude OAuth profile clears inherited base URL', oauthSpawn.ANTHROPIC_BASE_URL === undefined);
  check('Claude OAuth profile clears inherited setup-token OAuth', oauthSpawn.CLAUDE_CODE_OAUTH_TOKEN === undefined);
  check('Claude OAuth profile clears inherited provider selectors',
    oauthSpawn.CLAUDE_CODE_USE_BEDROCK === undefined && oauthSpawn.CLAUDE_CODE_USE_VERTEX === undefined);
  check('Claude OAuth profile preserves non-conflicting provider environment', oauthSpawn.AWS_REGION === 'us-east-1');
  check('Claude OAuth profile selects its configuration directory', oauthSpawn.CLAUDE_CONFIG_DIR === claudeOauthDir);

  const directProfileSpawn = buildClaudeSpawnEnv({
    ANTHROPIC_API_KEY: 'selected-key',
    ANTHROPIC_BASE_URL: 'https://selected-relay.invalid',
  }, true, inheritedClaudeEnv);
  check('Claude direct profile values win after isolation',
    directProfileSpawn.ANTHROPIC_API_KEY === 'selected-key' &&
    directProfileSpawn.ANTHROPIC_BASE_URL === 'https://selected-relay.invalid');
  check('Claude direct profile does not retain native token/provider mode',
    directProfileSpawn.ANTHROPIC_AUTH_TOKEN === undefined &&
    directProfileSpawn.CLAUDE_CODE_USE_BEDROCK === undefined);

  const nativeSpawn = buildClaudeSpawnEnv(undefined, false, inheritedClaudeEnv);
  check('Claude native profile preserves native CLI auth environment',
    nativeSpawn.ANTHROPIC_API_KEY === inheritedClaudeEnv.ANTHROPIC_API_KEY &&
    nativeSpawn.ANTHROPIC_BASE_URL === inheritedClaudeEnv.ANTHROPIC_BASE_URL &&
    nativeSpawn.CLAUDE_CODE_OAUTH_TOKEN === inheritedClaudeEnv.CLAUDE_CODE_OAUTH_TOKEN);

  writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({
    auth_mode: 'Chatgpt',
    tokens: { access_token: 'unit-codex-secret-never-echo' },
  }));
  writeFileSync(join(codexDir, 'config.toml'), 'openai_base_url = "https://relay.invalid"\n');
  const codex = detectCodexAuth(codexDir);
  check('Codex detects auth.json in configured CODEX_HOME', codex.mode === 'oauth');
  check('Codex detects config.toml base URL presence', codex.baseUrlPresent === true);
  check('Codex auth result contains no credential value', !JSON.stringify(codex).includes('unit-codex-secret'));

  const cfg = loadConfig(join(root, 'moyu-config.json'), { generate: false });
  cfg.adapters.claude.configDir = claudeDir;
  cfg.adapters.codex.configDir = codexDir;
  const accountStatus = new AccountService().getAccountSwitchingStatus(cfg);
  const nativeClaude = accountStatus.adapters.claude.profiles.find((p) => p.id === 'claude:native');
  const nativeCodex = accountStatus.adapters.codex.profiles.find((p) => p.id === 'codex:native');
  check('accounts API view uses configured Claude directory', nativeClaude?.fields.hasCredentials === true);
  check('accounts API view uses configured Codex directory', nativeCodex?.fields.hasCredentials === true);

  const claudeConfigured = resolveClaudeConfigLocation(claudeDir);
  check('configured Claude directory has highest precedence',
    claudeConfigured.source === 'configured' && claudeConfigured.path === claudeDir);
  const codexConfigured = resolveCodexConfigLocation(codexDir);
  check('configured Codex directory has highest precedence',
    codexConfigured.source === 'configured' && codexConfigured.path === codexDir);

  const claudeSpawn = mergeConfigDirectoryEnv(claudeDir, 'CLAUDE_CONFIG_DIR', { EXTRA: '1' });
  check('Claude configured directory is propagated to spawn env', claudeSpawn?.CLAUDE_CONFIG_DIR === claudeDir);
  check('profile env is preserved with configured directory', claudeSpawn?.EXTRA === '1');
  const codexProfileWins = mergeConfigDirectoryEnv(codexDir, 'CODEX_HOME', { CODEX_HOME: claudeDir });
  check('selected Codex account directory overrides native configured directory', codexProfileWins?.CODEX_HOME === claudeDir);
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nAUTH LOCATIONS UNIT: ${failed ? `${failed} failed` : 'ALL PASS'}`);
if (failed) process.exitCode = 1;
