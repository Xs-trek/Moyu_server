// moyu CLI: argument parsing, one-time initialization, and local daemon control.
// The foreground server run path lives in index.ts. Lightweight by design:
// no third-party arg parser, no heavy modules -- process.argv switch + node:readline.
//
// Security: `init` and `check` only DETECT existing adapter auth (read-only,
// 0-modify to ~/.claude / ~/.codex); they never perform first login, token
// exchange, or enter auth-verification flows. The token is printed to local
// stdout only via the explicit `moyu -token`; -print-config stays sanitized.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { loadConfig, saveConfig, configPath as getConfigPath } from './config/loader';
import { sanitizeConfig } from './config/schema';
import { createClaudeAdapter } from './adapters/claude/adapter';
import { createCodexAdapter } from './adapters/codex/adapter';
import { HookRegistry } from './api/hooks';
import { EasyTierController } from './net/easytier';
import { materializeEmbeddedBin, selfCheckEmbeddedBin } from './net/embedded-bin';
import { VERSION } from './version';
import { AccountService } from './accounts/service';
import { assertNotProviderHost } from './net/egress';
import { isCompiledBinary } from './util/runtime';
import { existsSync } from 'node:fs';
import { normalizeConfigPath } from './adapters/config-location';
import { resolveClaudeConfigLocation } from './adapters/claude/auth';
import { resolveCodexConfigLocation } from './adapters/codex/auth';

export { VERSION };

export interface RunOptions {
  configPath?: string;
  port?: number;
  logLevel?: string;
}

export type CliAction =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'usage'; message: string }
  | { kind: 'check'; configPath?: string }
  | { kind: 'token'; configPath?: string }
  | { kind: 'print-config'; configPath?: string }
  | { kind: 'init'; configPath?: string }
  | { kind: 'pair'; configPath?: string }
  | { kind: 'exit'; configPath?: string }
  | { kind: 'selfcheck'; configPath?: string }
  | { kind: 'hook-relay'; relayConfigPath: string }
  | { kind: 'start'; options: RunOptions }
  | { kind: 'daemon-run'; options: RunOptions };

const HELP = `moyu ${VERSION} - remote AI CLI control backend

Usage:
  moyu -init                 Confirm CLI config paths + relay once, start in background
  moyu -pair                 Print a 5-minute phone pairing string, then return
  moyu -exit                 Gracefully stop the background gateway
  moyu                       Ensure the configured gateway is running in background
  moyu -check                Diagnose readiness without starting
  moyu -token                Print the gateway auth token (for phone client)
  moyu -print-config         Print sanitized config (secrets redacted)
  moyu -selfcheck            Verify the embedded easytier-core (build smoke test)
  moyu -version              Print version
  moyu -help                 Show this help

Options:
  -config <path>             Config file (default: ~/.remote-dashboard/config.json,
                             env: REMOTE_DASHBOARD_CONFIG)
  -port <n>                  Override gateway port
  -log-level <level>         debug|info|warn|error

First-time setup (one relay configuration):
  1. Log in with each native CLI you use: claude / codex login.
  2. Put moyu.exe's directory on PATH (or invoke it by absolute path).
  3. Run moyu -init and enter the EasyTier relay; the gateway starts hidden.
  4. Run moyu -pair and enter the printed relay + pairing string on the phone.
  Re-running -init keeps the saved relay when you press Enter. Bare init/pair/exit
  remain accepted for compatibility.

Multiple API/OAuth profiles (under <config-dir>/profiles):
  claude/<name>.env          Native Claude env, for example ANTHROPIC_API_KEY=...
                             or ANTHROPIC_AUTH_TOKEN=... + ANTHROPIC_BASE_URL=...
  codex/<name>.home          One line containing a pre-logged-in CODEX_HOME path.
                             POSIX: CODEX_HOME=<dir> codex login
                             PowerShell: $env:CODEX_HOME='<dir>'; codex login
  OAuth and token exchange are always performed by the native CLI, never by moyu.

Native CLI config directories (auto-detected; confirm/override during -init):
  Claude: adapters.claude.configDir > CLAUDE_CONFIG_DIR > ~/.claude
  Codex:  adapters.codex.configDir  > CODEX_HOME        > ~/.codex
  These PC-local paths cannot be changed by the phone API.

Config precedence: -config <path> > REMOTE_DASHBOARD_CONFIG >
                   ~/.remote-dashboard/config.json

Exit codes: 0 ok | 1 runtime error | 2 usage error`;

export function printHelp(toStderr = false): void {
  (toStderr ? process.stderr : process.stdout).write(HELP + '\n');
}

const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];

export function parseArgs(argv: string[]): CliAction {
  let configPath: string | undefined;
  let port: number | undefined;
  let logLevel: string | undefined;
  let command: string | undefined;
  let relayConfigPath: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === '-config' || a === '--config') {
      const v = argv[++i];
      if (!v) return { kind: 'usage', message: `${a} requires a path` };
      configPath = v;
      continue;
    }
    if (a === '-port' || a === '--port') {
      const v = argv[++i];
      if (!v) return { kind: 'usage', message: `${a} requires a number` };
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) return { kind: 'usage', message: `${a} requires a number` };
      port = n;
      continue;
    }
    if (a === '-log-level' || a === '--log-level') {
      const v = argv[++i];
      if (!v) return { kind: 'usage', message: `${a} requires a level` };
      if (!VALID_LEVELS.includes(v)) return { kind: 'usage', message: `${a} must be one of debug|info|warn|error` };
      logLevel = v;
      continue;
    }
    if (a === '-help' || a === '--help' || a === '-h') {
      flags.add('help');
      continue;
    }
    if (a === '-version' || a === '--version' || a === '-V') {
      flags.add('version');
      continue;
    }
    if (a === '-check' || a === '--check') {
      flags.add('check');
      continue;
    }
    if (a === '-token' || a === '--token') {
      flags.add('token');
      continue;
    }
    if (a === '-print-config' || a === '--print-config') {
      flags.add('print-config');
      continue;
    }
    if (a === '-selfcheck' || a === '--selfcheck') {
      flags.add('selfcheck');
      continue;
    }
    if (a === '-init' || a === '--init') {
      flags.add('init');
      continue;
    }
    if (a === '-pair' || a === '--pair') {
      flags.add('pair');
      continue;
    }
    if (a === '-exit' || a === '--exit') {
      flags.add('exit');
      continue;
    }
    // Internal compiled-binary contract. Hidden from help so users cannot accidentally start
    // a foreground duplicate; the public commands always use detached background mode.
    if (a === '--daemon-run') {
      flags.add('daemon-run');
      continue;
    }
    if (a.startsWith('-')) return { kind: 'usage', message: `unknown option ${a}` };
    if (!command) {
      command = a;
      continue;
    }
    if (command === 'hook-relay' && !relayConfigPath) {
      relayConfigPath = a;
      continue;
    }
    return { kind: 'usage', message: `unexpected argument ${a}` };
  }
  if (flags.has('help')) return { kind: 'help' };
  if (flags.has('version')) return { kind: 'version' };
  if (command === 'init' || flags.has('init')) return { kind: 'init', configPath };
  if (command === 'pair' || flags.has('pair')) return { kind: 'pair', configPath };
  if (command === 'exit' || flags.has('exit')) return { kind: 'exit', configPath };
  // Internal subprocess contract used only by the injected Codex hook. Intentionally
  // omitted from --help: it is authenticated by a mode-0600 per-session descriptor.
  if (command === 'hook-relay') {
    return relayConfigPath
      ? { kind: 'hook-relay', relayConfigPath }
      : { kind: 'usage', message: 'hook-relay requires a descriptor path' };
  }
  if (command) return { kind: 'usage', message: `unknown command ${command}` };
  if (flags.has('check')) return { kind: 'check', configPath };
  if (flags.has('token')) return { kind: 'token', configPath };
  if (flags.has('print-config')) return { kind: 'print-config', configPath };
  if (flags.has('selfcheck')) return { kind: 'selfcheck', configPath };
  if (flags.has('daemon-run')) return { kind: 'daemon-run', options: { configPath, port, logLevel } };
  return { kind: 'start', options: { configPath, port, logLevel } };
}

interface DetectResult {
  claudeAvail: boolean;
  codexAvail: boolean;
  claudeMode: string;
  codexMode: string;
  claudeConfigDir: string;
  claudeConfigSource: string;
  codexConfigDir: string;
  codexConfigSource: string;
  easytierBin: string | null;
  publicNode: string;
  hasToken: boolean;
  cfgPath: string;
}

/** Detect adapter CLIs + auth + overlay readiness. Read-only: 0 writes to
 *  ~/.claude / ~/.codex, no login, no network API calls (only `--version` probes). */
async function detect(configPath?: string): Promise<DetectResult> {
  const cfg = loadConfig(configPath, { generate: false });
  // §3: populate the embedded-bin cache (compiled mode) before the controller
  // reads its bin. No-op in dev/source mode (resolves null -> filesystem fallback).
  await materializeEmbeddedBin();
  const hooks = new HookRegistry();
  const claude = createClaudeAdapter({
    port: 0,
    approvalTimeoutSec: cfg.approvalTimeoutSec,
    hooks,
    adapterConfig: cfg.adapters.claude,
  });
  const codex = createCodexAdapter({
    port: 0,
    hooks,
    approvalTimeoutSec: cfg.approvalTimeoutSec,
    adapterConfig: cfg.adapters.codex,
  });
  const [claudeAvail, codexAvail, claudeAuth, codexAuth] = await Promise.all([
    claude.isAvailable(),
    codex.isAvailable(),
    claude.detect(),
    codex.detect(),
  ]);
  const easytierBin = new EasyTierController(cfg.network).getState().bin ?? null;
  const claudeLocation = resolveClaudeConfigLocation(cfg.adapters.claude.configDir);
  const codexLocation = resolveCodexConfigLocation(cfg.adapters.codex.configDir);
  return {
    claudeAvail,
    codexAvail,
    claudeMode: claudeAuth.mode,
    codexMode: codexAuth.mode,
    claudeConfigDir: claudeLocation.path,
    claudeConfigSource: claudeLocation.source,
    codexConfigDir: codexLocation.path,
    codexConfigSource: codexLocation.source,
    easytierBin,
    publicNode: cfg.network.publicNode,
    hasToken: !!cfg.token,
    cfgPath: getConfigPath(),
  };
}

export async function runCheck(configPath?: string): Promise<number> {
  const d = await detect(configPath);
  const lines = [
    'moyu -check',
    `config:     ${d.cfgPath}`,
    `token:      ${d.hasToken ? 'OK present' : 'MISSING (run moyu -init)'}`,
    `claude:     ${d.claudeAvail ? 'OK' : 'NOT FOUND'} (${d.claudeMode})`,
    `  config:   ${d.claudeConfigDir} (${d.claudeConfigSource})`,
    `codex:      ${d.codexAvail ? 'OK' : 'NOT FOUND'} (${d.codexMode})`,
    `  config:   ${d.codexConfigDir} (${d.codexConfigSource})`,
    `easytier:   ${d.easytierBin ? 'OK ' + d.easytierBin : 'NOT FOUND (set network.easytierBin)'}`,
    `publicNode: ${d.publicNode ? 'OK ' + d.publicNode : 'NOT SET (remote access disabled)'}`,
  ];
  for (const l of lines) console.log(l);
  // Ready to start if a token exists and at least one AI CLI is available.
  const ok = d.hasToken && (d.claudeAvail || d.codexAvail);
  return ok ? 0 : 1;
}

export async function runToken(configPath?: string): Promise<number> {
  const cfg = loadConfig(configPath, { generate: false });
  if (!cfg.token) {
    console.error('no token found - run `moyu -init` first');
    return 1;
  }
  console.log(cfg.token);
  return 0;
}

export async function runPrintConfig(configPath?: string): Promise<number> {
  const cfg = loadConfig(configPath, { generate: false });
  console.log(JSON.stringify(sanitizeConfig(cfg), null, 2));
  return 0;
}

/** `moyu --selfcheck`: §3 build smoke test. Verifies the compiled single-binary
 *  artifact can spawn its EMBEDDED easytier-core from any cwd (no bin/ on PATH,
 *  no vendor dir) -- i.e. the artifact is truly self-contained. In dev/source
 *  mode (not a compiled binary) it reports that and exits 0 (the build step only
 *  invokes this against the compiled `dist/moyu`). */
export async function runSelfCheck(): Promise<number> {
  const r = await selfCheckEmbeddedBin();
  if (r.ok) {
    console.log(`moyu -selfcheck: OK (embedded easytier-core ${r.version})`);
    console.log(`  extracted: ${r.path}`);
    return 0;
  }
  if (r.error === 'no embedded easytier-core (dev/source mode)') {
    console.log('moyu -selfcheck: skipped (not a compiled binary; dev/source mode)');
    return 0;
  }
  console.error(`moyu -selfcheck: FAIL (${r.error ?? 'unknown'})`);
  if (r.path) console.error(`  path: ${r.path}`);
  return 1;
}

export async function runInit(configPath?: string): Promise<number> {
  console.log(`moyu ${VERSION} first-time setup\n`);

  // [1] detect CLIs (read-only; never logs in)
  console.log('[1/5] AI CLI detection');
  const d = await detect(configPath);
  console.log(`  claude: ${d.claudeAvail ? 'OK' : 'NOT FOUND'} (${d.claudeMode})`);
  console.log(`  codex:  ${d.codexAvail ? 'OK' : 'NOT FOUND'} (${d.codexMode})`);
  if (!d.claudeAvail && !d.codexAvail) {
    console.log('  ! no AI CLI detected. Install + run native login first (moyu does NOT do first login).');
  }

  // [2] confirm adapter configuration roots. Enter accepts the discovered directory; an
  // environment-derived directory is persisted so later background starts need no shell setup.
  console.log('\n[2/5] Native CLI configuration directories');
  const rl = createInterface({ input: stdin, output: stdout });
  let enteredClaudeDir = '';
  let enteredCodexDir = '';
  let enteredNode = '';
  try {
    if (d.claudeAvail) {
      enteredClaudeDir = (await rl.question(
        `Claude config directory [${d.claudeConfigDir}] (Enter accepts, "auto" resets): `,
      )).trim();
    }
    if (d.codexAvail) {
      enteredCodexDir = (await rl.question(
        `Codex config directory [${d.codexConfigDir}] (Enter accepts, "auto" resets): `,
      )).trim();
    }

    // [3] embedded or explicitly configured EasyTier runtime.
    console.log('\n[3/5] EasyTier overlay');
    console.log(`  easytier-core: ${d.easytierBin ? 'OK ' + d.easytierBin : 'NOT FOUND (set network.easytierBin later)'}`);

    // [4] prompt publicNode (the one required manual input for remote access)
    console.log('\n[4/5] Public relay node (for remote phone access)');
    const current = d.publicNode ? `, Enter keeps ${d.publicNode}` : ', blank disables remote access';
    enteredNode = (await rl.question(`EasyTier public node URL (e.g. tcp://1.2.3.4:11010${current}): `)).trim();
  } finally {
    rl.close();
  }
  const node = enteredNode || d.publicNode;

  // F5: validate reachability before saving. WARN (never refuse) on failure -- the relay
  // may be temporarily down or reachable only from the phone's network; the user can still
  // proceed as a manual fallback (automation degrades, does not block).
  if (node) {
    try {
      assertNotProviderHost(node);
    } catch {
      console.error('  ! relay rejected: known AI-provider host is not a relay node');
      return 1;
    }
    const probe = await probePublicNode(node);
    if (probe.ok) {
      console.log(`  relay reachable (tcp connect OK, ${probe.ms}ms)`);
    } else {
      console.log(`  ! relay NOT reachable: ${probe.reason}`);
      console.log('    (saved anyway as a manual fallback; re-run `moyu -init` to re-check)');
    }
  }

  // [5] generate config (token/secrets) + apply local paths/publicNode
  console.log('\n[5/5] Generating config');
  const cfg = loadConfig(configPath, { generate: true });
  if (d.claudeAvail) {
    if (enteredClaudeDir.toLowerCase() === 'auto') delete cfg.adapters.claude.configDir;
    else if (enteredClaudeDir) cfg.adapters.claude.configDir = normalizeConfigPath(enteredClaudeDir);
    else if (d.claudeConfigSource === 'environment') cfg.adapters.claude.configDir = d.claudeConfigDir;
  }
  if (d.codexAvail) {
    if (enteredCodexDir.toLowerCase() === 'auto') delete cfg.adapters.codex.configDir;
    else if (enteredCodexDir) cfg.adapters.codex.configDir = normalizeConfigPath(enteredCodexDir);
    else if (d.codexConfigSource === 'environment') cfg.adapters.codex.configDir = d.codexConfigDir;
  }
  for (const [name, dir] of [
    ['Claude', cfg.adapters.claude.configDir],
    ['Codex', cfg.adapters.codex.configDir],
  ] as const) {
    if (dir && !existsSync(dir)) console.log(`  ! ${name} config directory does not exist yet: ${dir}`);
  }
  if (enteredNode) {
    cfg.network.publicNode = node;
    console.log(`  publicNode saved: ${node}`);
  } else if (node) {
    console.log(`  publicNode kept: ${node}`);
  } else {
    console.log('  publicNode skipped (remote access disabled; set later via config or frontend)');
  }
  saveConfig(cfg);
  const profileLayout = new AccountService().ensureProfileLayout();
  console.log(`  config: ${getConfigPath()}`);
  console.log(`  profiles: ${profileLayout.root}`);
  console.log('  phone credentials: generated and stored locally (delivered by pairing)');
  console.log('  add Claude <name>.env or Codex <name>.home files only if you need multiple accounts');
  console.log('\nInitialization saved. Starting the gateway in background...');
  return 0;
}

/** F5: lightweight TCP-reachability probe of a relay node URL (tcp://host:port).
 *  No easytier dependency -- just confirms the relay accepts a TCP connection. */
export function probePublicNode(url: string): Promise<{ ok: boolean; ms?: number; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, reason: 'invalid URL (expected tcp://host:port)' });
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 11010;
  if (!host) return Promise.resolve({ ok: false, reason: 'no host in URL' });
  try {
    assertNotProviderHost(host);
  } catch {
    return Promise.resolve({ ok: false, reason: 'known AI-provider host is not a relay node' });
  }
  const start = Date.now();
  return new Promise((resolve) => {
    const sock = createConnection({ host, port }, () => {
      const ms = Date.now() - start;
      sock.destroy();
      resolve({ ok: true, ms });
    });
    sock.setTimeout(4000);
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, reason: 'tcp connect timeout (4s)' });
    });
    sock.on('error', (e) => {
      resolve({ ok: false, reason: String((e as Error).message ?? e) });
    });
  });
}

/** Call the running gateway's admin API (Bearer = config token). Throws on network error
 *  (gateway not running); returns the HTTP status + parsed body otherwise. */
async function gatewayCall(
  configPath: string | undefined,
  method: string,
  p: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const cfg = loadConfig(configPath, { generate: false });
  if (!cfg.token) throw new Error('no token (run moyu -init)');
  if (!cfg.gateway.gwPort) throw new Error('gateway gwPort not persisted (start `moyu` first)');
  const base = `http://127.0.0.1:${cfg.gateway.gwPort}`;
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...extraHeaders },
    signal: AbortSignal.timeout(2500),
  });
  const text = await r.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: r.status, body };
}

async function gatewayIsReady(configPath?: string): Promise<boolean> {
  try {
    return (await gatewayCall(configPath, 'GET', '/api/v1/server/info')).status === 200;
  } catch {
    return false;
  }
}

/** Ensure the compiled gateway is detached and ready, then return control to the shell. */
export async function ensureBackgroundGateway(options: RunOptions = {}): Promise<number> {
  // Resolve while still in the caller's cwd. The detached child may have a different lifetime
  // and must never reinterpret a relative -config path later.
  const configPath = options.configPath ? resolve(options.configPath) : undefined;
  const cfg = loadConfig(configPath, { generate: false });
  if (!cfg.token) {
    console.error('not initialized - run `moyu -init` first.');
    return 1;
  }
  if (await gatewayIsReady(configPath)) {
    console.log(`moyu is already running on 127.0.0.1:${cfg.gateway.gwPort}.`);
    return 0;
  }
  if (!isCompiledBinary()) {
    console.error('background mode is available in the compiled moyu executable; use `npm start` for source development.');
    return 1;
  }

  const args = ['--daemon-run'];
  const effectiveConfigPath = getConfigPath(configPath);
  args.push('-config', effectiveConfigPath);
  if (options.port !== undefined) args.push('-port', String(options.port));
  if (options.logLevel !== undefined) args.push('-log-level', options.logLevel);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  let spawnError: Error | undefined;
  child.once('error', (e) => { spawnError = e; });
  child.unref();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (child.exitCode !== null) break;
    if (await gatewayIsReady(effectiveConfigPath)) {
      const running = loadConfig(effectiveConfigPath, { generate: false });
      console.log(`moyu started in background on 127.0.0.1:${running.gateway.gwPort}.`);
      return 0;
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  console.error(`moyu failed to start in background${spawnError ? `: ${spawnError.message}` : '.'}`);
  console.error('run `moyu -check` and inspect the local configuration.');
  return 1;
}

/** Stop the background process with a PC-only control secret. A paired phone has the normal
 * gateway bearer but never this secret, so it cannot invoke process lifecycle controls. */
export async function runExit(configPath?: string, quiet = false): Promise<number> {
  const cfg = loadConfig(configPath, { generate: false });
  if (!cfg.token || !cfg.gateway.gwPort) {
    if (!quiet) console.log('moyu is not running.');
    return 0;
  }
  if (!cfg.controlToken) {
    console.error('local control token is missing - run `moyu -init` once to repair the configuration.');
    return 1;
  }
  let response: { status: number; body: unknown };
  try {
    response = await gatewayCall(configPath, 'POST', '/api/v1/admin/exit', {
      'X-Moyu-Control': cfg.controlToken,
    });
  } catch {
    if (!quiet) console.log('moyu is not running.');
    return 0;
  }
  if (response.status !== 202) {
    console.error(`moyu refused to stop (HTTP ${response.status}).`);
    return 1;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await gatewayIsReady(configPath))) {
      console.log('moyu stopped.');
      return 0;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  console.error('moyu stop timed out; run `moyu -check` to diagnose.');
  return 1;
}

/** `moyu -pair`: create the gateway-owned five-minute pairing session, print the values the
 * phone needs, and return immediately. The gateway owns timeout, attempt caps, and cleanup. */
export async function runPair(configPath?: string): Promise<number> {
  const cfg = loadConfig(configPath, { generate: false });
  if (!cfg.controlToken) {
    console.error('local control token is missing - run `moyu -init` once to repair the configuration.');
    return 1;
  }
  let startRes: { status: number; body: unknown };
  try {
    startRes = await gatewayCall(configPath, 'POST', '/api/v1/pair/start', {
      'X-Moyu-Control': cfg.controlToken,
    });
  } catch (e) {
    console.error('cannot reach gateway:', String((e as Error).message));
    console.error('run `moyu` to start the background gateway.');
    return 1;
  }
  if (startRes.status === 401) {
    console.error('token rejected by gateway (config token changed? re-run `moyu -init`).');
    return 1;
  }
  if (startRes.status !== 200) {
    console.error('pair/start failed:', JSON.stringify(startRes.body));
    return 1;
  }
  const res = startRes.body as {
    code: string;
    gatewayPort: number;
    pairString: string;
    pairBackendVip: string;
    pairNetworkName: string;
  };
  console.log(`relay: ${cfg.network.publicNode || '(not configured)'}`);
  console.log(`pair:  ${res.pairString}`);
  console.log('valid for 5 minutes; this command may now be closed.');
  return 0;
}
