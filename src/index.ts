// Entry point: parse CLI args, dispatch short-circuit commands (help/version/
// check/token/print-config/init), or load config + register adapters + start the
// gateway. CLI logic lives in ./cli; this file owns the server run path.
// Packaged as `moyu` via bun-compile (single binary, no runtime needed).
import {
  parseArgs,
  printHelp,
  runCheck,
  runToken,
  runPrintConfig,
  runInit,
  runPair,
  runExit,
  runSelfCheck,
  ensureBackgroundGateway,
  VERSION,
  type RunOptions,
} from './cli';
import { loadConfig, saveConfig } from './config/loader';
import { setLogLevel, log } from './util/logger';
import { findFreePort, isFree } from './gateway/ports';
import { startServer } from './gateway/server';
import { AdapterManager } from './adapters/manager';
import { SessionManager } from './session/manager';
import { HookRegistry } from './api/hooks';
import { createClaudeAdapter } from './adapters/claude/adapter';
import { createCodexAdapter } from './adapters/codex/adapter';
import { NetProbe } from './net/probe';
import { createInboundPolicy } from './net/types';
import { EasyTierController } from './net/easytier';
import { materializeEmbeddedBin } from './net/embedded-bin';
import { PairingService } from './net/pairing';
import { AccountService } from './accounts/service';
import { NetNotifier } from './api/ws';
import type { ServerContext } from './context';
import type { LogLevel } from './config/schema';
import { getPlatform, getArch } from './util/platform';
import { runHookRelay } from './approval/hook-relay';
import { isCompiledBinary } from './util/runtime';

// D-1: global safety net. A single unhandled Promise rejection or uncaught exception must not
// crash the whole gateway (taking down every active session). Log + degrade instead. This is the
// backstop for edge-case rejects that individual try/catch blocks miss (killTree spawn errors,
// stray rejects in async listeners, /pair handler gaps). It does NOT suppress errors -- they are
// logged at error level -- it only prevents process death. Per Node guidance, uncaughtException
// is a last resort; correctness relies on the per-call try/catch elsewhere in the codebase.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection (gateway continues)', { err: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException (gateway continues)', { err: String(err) });
});

async function main(options: RunOptions = {}): Promise<void> {
  // §3: materialize the embedded easytier-core (compiled single-binary mode) to
  // a temp path BEFORE the controller reads its bin. No-op in dev/source mode.
  await materializeEmbeddedBin();
  const config = loadConfig(options.configPath);
  if (options.logLevel) {
    // parseArgs already validated the level against debug|info|warn|error.
    config.logLevel = options.logLevel as LogLevel;
  }
  setLogLevel(config.logLevel);
  log.info('moyu starting', {
    platform: getPlatform(),
    arch: getArch(),
    configPath: 'set',
  });

  // F4: persist the gateway port so the phone's --port-forward target is stable across
  // restarts. Explicit -port wins; else reuse the persisted gwPort if still free; else
  // pick a fresh free port in [portMin,portMax]. Resolved port is persisted to config.
  const bindHost = config.gateway.bindHost;
  let port: number;
  if (options.port) {
    port = (await isFree(options.port, bindHost))
      ? options.port
      : await findFreePort(options.port, options.port, bindHost);
  } else if (
    config.gateway.gwPort &&
    config.gateway.gwPort >= config.gateway.portMin &&
    config.gateway.gwPort <= config.gateway.portMax
  ) {
    port = (await isFree(config.gateway.gwPort, bindHost))
      ? config.gateway.gwPort
      : await findFreePort(config.gateway.portMin, config.gateway.portMax, bindHost);
  } else {
    port = await findFreePort(config.gateway.portMin, config.gateway.portMax, bindHost);
  }
  if (config.gateway.gwPort !== port) {
    config.gateway.gwPort = port;
    saveConfig(config);
  }

  const adapters = new AdapterManager();
  const hooks = new HookRegistry();
  const sessions = new SessionManager(adapters);
  const accounts = new AccountService();

  // §4: register only claude + codex by default. opencode is retained as interface code but
  // registered ONLY behind an explicit experiment flag (MOYU_EXPERIMENT_OPENCODE=1) via a
  // dynamic import, so it is not loaded into the running process unless explicitly opted in.
  adapters.register(
    createClaudeAdapter({ port, approvalTimeoutSec: config.approvalTimeoutSec, hooks, adapterConfig: config.adapters.claude }),
  );
  adapters.register(createCodexAdapter({ port, hooks, approvalTimeoutSec: config.approvalTimeoutSec, adapterConfig: config.adapters.codex }));
  if (process.env.MOYU_EXPERIMENT_OPENCODE === '1') {
    const { createOpencodeAdapter } = await import('./adapters/opencode/adapter');
    adapters.register(
      createOpencodeAdapter({
        approvalTimeoutSec: config.approvalTimeoutSec,
        password: process.env.OPENCODE_SERVER_PASSWORD,
      }),
    );
    log.warn('opencode adapter registered (experiment flag MOYU_EXPERIMENT_OPENCODE=1)', {});
  }
  // §4: defaultAdapter must be an enabled (registered) kind. A stale config carrying
  // opencode/pty is coerced back to claude so the runtime never selects a disabled backend.
  if (!adapters.get(config.defaultAdapter)) {
    log.warn('defaultAdapter not enabled; coercing to claude', { was: config.defaultAdapter });
    config.defaultAdapter = 'claude';
    saveConfig(config);
  }

  // NetProbe: detect-only network profile (IPv6/temp-addr, firewall, Clash TUN)
  // + public-node reachability + dead-zone verdict (N5: never modify).
  const net = new NetProbe(
    config.network.publicNode,
    createInboundPolicy(config.gateway.bindHost, config.network.backendMapCidr),
  );

  // EasyTierController: PC-side overlay subprocess (C5 graceful degradation;
  // missing binary/publicNode => not-configured, gateway still runs).
  const overlay = new EasyTierController(config.network);

  // PairingService: one-time in-band credential conveyance (F1/F2). Inactive until the
  // operator triggers /api/v1/pair/start; holds the transient pairing overlay + code.
  // Reads LIVE config via the getter: applyPatch reassigns ctx.config at runtime, so a
  // captured reference would go stale if the operator PATCHed config before pairing.
  let ctx: ServerContext;
  const pairing = new PairingService(() => ctx.config, port);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { sig });
    try {
      await pairing.stop();
    } catch (e) {
      log.warn('pairing stop error', { err: String(e) });
    }
    try {
      await overlay.stop();
    } catch (e) {
      log.warn('overlay stop error', { err: String(e) });
    }
    try {
      await sessions.disposeAll();
    } catch (e) {
      log.warn('session disposal error', { err: String(e) });
    }
    if (server) {
      // Upgraded WebSocket connections can keep Server.close() pending. Give in-flight HTTP
      // responses a brief flush window, then exit; pairing/overlay/session cleanup is complete.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 750);
        server?.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    process.exit(0);
  };
  ctx = {
    config,
    adapters,
    sessions,
    hooks,
    port,
    startedAt: new Date().toISOString(),
    net,
    overlay,
    accounts,
    pairing,
    netNotifier: new NetNotifier(),
    requestShutdown: (reason) => { void shutdown(reason); },
  };

  server = await startServer(ctx);

  // Start the overlay after the gateway is up (non-fatal on failure).
  overlay.start().catch((e) => log.error('overlay start failed (non-fatal)', { err: String(e) }));

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('ready', {
    listen: `${config.gateway.bindHost}:${port}`,
    token: '[REDACTED]',
    hook: `http://127.0.0.1:${port}/hooks/pre-tool-use`,
    ws: `ws://127.0.0.1:${port}/api/v1/ws?token=<token>`,
    configPath: '(see config.json)',
  });
  log.info('first-run: read token from config file to connect clients (or run `moyu -token`)');
}

async function entry(): Promise<void> {
  const action = parseArgs(process.argv.slice(2));
  switch (action.kind) {
    case 'help':
      printHelp(false);
      process.exit(0);
    case 'version':
      process.stdout.write(`moyu ${VERSION}\n`);
      process.exit(0);
    case 'usage':
      process.stderr.write(`moyu: ${action.message}\n\n`);
      printHelp(true);
      process.exit(2);
    case 'check':
      process.exit(await runCheck(action.configPath));
    case 'token':
      process.exit(await runToken(action.configPath));
    case 'print-config':
      process.exit(await runPrintConfig(action.configPath));
    case 'selfcheck':
      process.exit(await runSelfCheck());
    case 'init':
      if (await runInit(action.configPath)) process.exit(1);
      // Re-running init may change the relay. Restart an existing daemon so the saved value is
      // also the active runtime value; on first run this is a quiet no-op.
      if (await runExit(action.configPath, true)) process.exit(1);
      process.exit(await ensureBackgroundGateway({ configPath: action.configPath }));
    case 'pair': {
      const ready = await ensureBackgroundGateway({ configPath: action.configPath });
      if (ready !== 0) process.exit(ready);
      process.exit(await runPair(action.configPath));
    }
    case 'exit':
      process.exit(await runExit(action.configPath));
    case 'hook-relay': {
      process.exitCode = await runHookRelay(action.relayConfigPath);
      return;
    }
    case 'start':
      if (isCompiledBinary()) {
        process.exit(await ensureBackgroundGateway(action.options));
      }
      // Development/source mode stays foreground so `npm start` retains normal logs and
      // signal handling. Released binaries always use detached mode.
      await main(action.options);
      return;
    case 'daemon-run':
      await main(action.options);
      return;
  }
}

entry().catch((e) => {
  log.error('fatal', { err: String(e) });
  process.exit(1);
});
