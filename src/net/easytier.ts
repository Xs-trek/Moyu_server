// EasyTierController: manages the PC-side easytier-core subprocess (overlay).
// Flags verified against `easytier-core v2.6.4 --help` + live bind probes (authoritative):
//   --no-tun, --use-smoltcp (optional value, bare=true)
//   -i/--ipv4 <vIP>, -e/--external-node <pub>, -n/--proxy-networks <realCIDR->virtualCIDR>
//   --network-name, --network-secret, --private-mode <true|false>  (forced true, §2)
//   --socks5 <port>  (binds 0.0.0.0 -- NOT loopback; mobile uses a config file instead, §1)
//   --port-forward <proto>://<bind>:<lport>/<vIP>:<vport>  (optional mobile optimization; binds 127.0.0.1)
//   --latency-first, --encryption-algorithm <algo>, --rpc-portal <port|0>, --no-listener
// Mobile SOCKS5 loopback: a minimal TOML config `socks5_proxy = "socks5://127.0.0.1:<port>"`
//   is the ONLY verified way to bind the SOCKS5 server to loopback (live-verified: --socks5
//   binds 0.0.0.0; the config file binds 127.0.0.1). The phone passes it via `-c <file>` plus
//   the verified CLI flags for everything else (§1 / N4 baseline).
// Public node is USER-PROVIDED (config.network.publicNode); never hardcoded.
// Lifecycle ties to the gateway (C5: graceful degradation; bin missing => not-configured,
// never crashes the gateway). T5: LGPL binary via spawn only (no linking).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log, registerSecrets, safeStderrSummary } from '../util/logger';
import { isWindows } from '../util/platform';
import { which } from '../util/spawn';
import { getEmbeddedBinPath } from './embedded-bin';
import type { NetworkConfig } from '../config/schema';
import { assertNotProviderHost } from './egress';

export type OverlayStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'not-configured';

export interface OverlayState {
  status: OverlayStatus;
  pid?: number;
  bin?: string;
  virtualIp?: string;
  publicNode?: string;
  /** Present when status is failed/not-configured. */
  error?: string;
}

export interface EasyTierControllerOptions {
  /** Disable every inbound EasyTier listener. Pairing uses a second controller beside the
   *  long-lived PC overlay, so it must be outbound-only or both processes contend for the
   *  default 11010-11013 listener set. The primary PC overlay intentionally keeps listeners
   *  enabled for normal P2P operation. */
  noListener?: boolean;
  /** Process-wide EasyTier management portal. Each controller is a separate process, and
   *  EasyTier 2.6.4's host:0 selection can still choose the same 15888 port when the bind
   *  address is identical. Pairing therefore uses a distinct, off-map loopback address. */
  rpcPortal?: string;
}

export interface PortForwardOptimization {
  /** Tested OPTIONAL optimization (NOT the baseline). CLI arg vector that binds
   *  127.0.0.1:localPort on the phone and forwards to the PC backend VIP. The phone
   *  MAY use this instead of SOCKS5 if it prefers a direct TCP forward; it must NOT
   *  be the only data path (SOCKS5 is the N4 baseline). Loopback-bound, so safe. */
  args: string[];
  localPort: number;
}

export interface MobileJoinParams {
  /** Access mode. SOCKS5 is the N4 baseline: the phone runs a loopback-bound SOCKS5
   *  server and its HTTP client uses it to reach the PC backend VIP over the overlay. */
  mode: 'socks5';
  /** Minimal TOML the phone writes to a temp file and passes via `easytier-core -c`.
   *  Contains ONLY `socks5_proxy` bound to 127.0.0.1 (loopback) -- the `--socks5 <port>`
   *  CLI flag binds 0.0.0.0 (live-verified), so the config file is the verified way to
   *  restrict SOCKS5 to the phone's loopback. All other settings come from `args`. */
  configFile: string;
  /** Phone-side loopback SOCKS5 port. The phone's HTTP client uses SOCKS5 proxy
   *  127.0.0.1:socks5Port and CONNECTs to targetHost:targetPort. */
  socks5Port: number;
  /** PC backend virtual IP the phone reaches via the overlay (10.1.1.10). The SOCKS5
   *  client CONNECTs here; the PC's -n map translates 10.1.1.10 -> 127.0.0.1:gatewayPort. */
  targetHost: string;
  /** Gateway port on the PC (the backend's real loopback port). */
  targetPort: number;
  /** Verified CLI flag vector for everything EXCEPT socks5 (no --socks5; no --port-forward).
   *  Phone launches: `easytier-core -c <configFile> ...args`. */
  args: string[];
  networkName: string;
  /** Secret is included: the mobile node needs it to join the private network.
   * Only convey over an authenticated/trusted channel (S5) -- in this design, via
   * the one-time pairing handoff (PairingService), never in a long-lived QR/URL. */
  networkSecret: string;
  publicNode: string;
  /** Phone's virtual IP in the overlay (distinct from the PC's). */
  mobileVip: string;
  /** Virtual IP of the PC backend map (10.1.1.10). */
  backendVip: string;
  /** Gateway port on the PC. */
  gatewayPort: number;
  /** Optional tested optimization (port-forward, loopback-bound). NOT the baseline. */
  portForward?: PortForwardOptimization;
}

const DEFAULT_VIRTUAL_IP = '10.144.144.1';
const DEFAULT_BACKEND_MAP_CIDR = '10.1.1.10/32';
const DEFAULT_MOBILE_VIP = '10.144.144.3';
// Phone-side loopback ports. SOCKS5 is the N4 baseline (config-file bound to 127.0.0.1);
// port-forward is an optional optimization (CLI flag, also loopback-bound). Distinct ports so
// a phone that probes both never clashes with itself.
const DEFAULT_SOCKS5_PORT = 1080; // phone-side loopback SOCKS5 server (N4 baseline)
const DEFAULT_PORT_FORWARD_PORT = 1081; // phone-side loopback --port-forward bind (optional)
const BACKEND_BIND = '127.0.0.1'; // S10: backend binds loopback; proxy maps it to a virtual IP

// Encryption: explicitly strong (default algorithm is undocumented in --help).
const ENCRYPTION = 'aes-256-gcm';
// RPC portal binds 127.0.0.2 (random port). The -n map is 127.0.0.1/32 -> virtual IP, so
// 127.0.0.2 is NOT mapped: overlay peers (which appear as 127.0.0.1 via the -n->loopback
// forward) cannot reach the unauthenticated RPC management portal. Same isolation trick as
// the F8 hook fix. We don't use the portal (no web GUI); binding it off the mapped loopback
// just removes the surface. EasyTier 2.6.4 resolves `:0` from 15888..15900; a second process
// using the same host may still select 15888, so pairing overrides the host to 127.0.0.3.
const RPC_PORTAL = '127.0.0.2:0';

export class EasyTierController {
  private child: ChildProcess | null = null;
  // §10 I7: `state` is a getter/setter so EVERY assignment (start/stop/restart/exit/error
  // transitions, including the async running/failed ticks) fires stateListener -> NetNotifier
  // broadcast. Field initializer runs before the constructor body; the setter is inert until
  // onStateChange registers a listener (server.ts, after attachWs).
  private _state: OverlayState = { status: 'stopped' };
  private stateListener?: (s: OverlayState) => void;
  private bin: string | null;
  private cfg: NetworkConfig;
  private readonly options: EasyTierControllerOptions;
  private startPromise: Promise<void> | null = null;

  constructor(cfg: NetworkConfig, options: EasyTierControllerOptions = {}) {
    this.cfg = cfg;
    this.options = options;
    this.bin = resolveBin(cfg.easytierBin);
    this.state = { status: 'stopped', bin: this.bin ?? undefined };
  }

  get state(): OverlayState {
    return this._state;
  }
  set state(next: OverlayState) {
    this._state = next;
    try {
      this.stateListener?.(next);
    } catch (e) {
      log.warn('overlay state listener threw', { err: String(e) });
    }
  }

  /** §10 I7: register for overlay state changes (start/stop/restart/exit/error). The listener
   *  is invoked synchronously on each transition; it may perform async work (net snapshot +
   *  broadcast) and must catch its own errors. */
  onStateChange(cb: (s: OverlayState) => void): void {
    this.stateListener = cb;
  }

  getState(): OverlayState {
    return { ...this.state };
  }

  /** Apply a new NetworkConfig live (review P1: PATCH must reconfigure, not just reassign
   *  ctx.config). If a material field changed AND the overlay is running, restart it so the
   *  new publicNode/secret/vIP takes effect; otherwise just adopt the new cfg for the next
   *  start. Returns whether a restart was performed. */
  async reconfigure(cfg: NetworkConfig): Promise<boolean> {
    const changed = materialChange(this.cfg, cfg);
    this.cfg = cfg;
    this.bin = resolveBin(cfg.easytierBin);
    this.state.bin = this.bin ?? undefined;
    if (changed && this.child) {
      log.warn('network config changed -> restarting overlay', {});
      await this.restart();
      return true;
    }
    return false;
  }

  /** Build the PC-mode arg vector (verified flags). */
  private pcArgs(): string[] {
    const virtualIp = this.cfg.virtualIp ?? DEFAULT_VIRTUAL_IP;
    const mapCidr = this.cfg.backendMapCidr ?? DEFAULT_BACKEND_MAP_CIDR;
    // -n maps the backend's loopback bind to a virtual IP the mobile node can reach.
    const proxyNetwork = `${BACKEND_BIND}/32->${mapCidr}`;
    const args = [
      '--no-tun',
      '--use-smoltcp',
      '-i',
      virtualIp,
      '-n',
      proxyNetwork,
      '-e',
      this.cfg.publicNode,
      '--network-name',
      this.cfg.networkName ?? '',
      '--network-secret',
      this.cfg.networkSecret ?? '',
      '--private-mode',
      'true', // §2: private mode is forced + immutable (loadConfig forces true; ConfigPatch can't change it)
      // Path selection: latency-first auto-matches P2P vs relay by feasibility/latency
      // (user requirement). Default is shortest-path; latency-first prefers lowest RTT.
      '--latency-first',
      '--encryption-algorithm',
      ENCRYPTION,
      // RPC portal is off the mapped 127.0.0.1 address so overlay peers cannot reach the
      // unauthenticated management API. Pairing supplies another off-map host because it is
      // a separate process and EasyTier's `:0` selection alone does not guarantee coexistence.
      '--rpc-portal',
      this.options.rpcPortal ?? RPC_PORTAL,
    ];
    // A pairing overlay is a short-lived second process on the same PC. It only needs to
    // dial the shared relay, so listeners add no reachability and collide with the primary
    // overlay's default TCP/UDP/WG/WS ports. Keep this opt-in: the primary overlay still
    // listens and remains eligible for normal inbound P2P paths.
    if (this.options.noListener) args.push('--no-listener');
    return args;
  }

  /** Common mobile CLI flags (verified): no-tun, smoltcp, vip, external node, network
   *  identity, forced private mode, latency-first, strong encryption, no listener, off-map
   *  RPC portal. Shared by the SOCKS5 baseline args and the optional port-forward args. */
  private mobileCommonArgs(mobileVip: string): string[] {
    return [
      '--no-tun',
      '--use-smoltcp',
      '-i',
      mobileVip,
      '-e',
      this.cfg.publicNode,
      '--network-name',
      this.cfg.networkName ?? '',
      '--network-secret',
      this.cfg.networkSecret ?? '',
      '--private-mode',
      'true', // §2: forced + immutable
      '--latency-first',
      '--encryption-algorithm',
      ENCRYPTION,
      // Mobile never accepts inbound peer connections (it only dials the PC's listener via
      // the public node), so --no-listener removes that surface entirely.
      '--no-listener',
      '--rpc-portal',
      RPC_PORTAL,
    ];
  }

  /** Generate join params for the mobile (Android) node (real network).
   *  N4 baseline = SOCKS5: the phone runs a loopback-bound SOCKS5 server (via a minimal
   *  `-c` config file -- the only verified way to bind SOCKS5 to 127.0.0.1; the --socks5
   *  CLI flag binds 0.0.0.0) and its HTTP client uses it to reach the PC backend VIP over
   *  the overlay. --port-forward is kept ONLY as an optional, loopback-bound optimization
   *  (not the baseline). --use-smoltcp is required on mobile for the overlay forward to
   *  deliver (verified v2.6.4: without it, peering works but forwarding fails). */
  mobileJoinParams(gatewayPort: number, mobileVip: string = DEFAULT_MOBILE_VIP): MobileJoinParams {
    const mapCidr = this.cfg.backendMapCidr ?? DEFAULT_BACKEND_MAP_CIDR;
    const backendVip = mapCidr.replace(/\/\d+$/, ''); // 10.1.1.10/32 -> 10.1.1.10
    const socks5Port = DEFAULT_SOCKS5_PORT;
    const pfPort = DEFAULT_PORT_FORWARD_PORT;
    // Minimal TOML: socks5_proxy bound to loopback. The phone writes this to a temp file and
    // launches `easyster-core -c <file> ...args`. (The --socks5 CLI flag binds 0.0.0.0.)
    const configFile =
      `# N4 SOCKS5 baseline (loopback-only). Generated by moyu; do not edit.\n` +
      `socks5_proxy = "socks5://127.0.0.1:${socks5Port}"\n`;
    return {
      mode: 'socks5',
      configFile,
      socks5Port,
      targetHost: backendVip,
      targetPort: gatewayPort,
      args: this.mobileCommonArgs(mobileVip),
      networkName: this.cfg.networkName ?? '',
      networkSecret: this.cfg.networkSecret ?? '',
      publicNode: this.cfg.publicNode,
      mobileVip,
      backendVip,
      gatewayPort,
      portForward: {
        args: [
          ...this.mobileCommonArgs(mobileVip),
          '--port-forward',
          `tcp://${BACKEND_BIND}:${pfPort}/${backendVip}:${gatewayPort}`,
        ],
        localPort: pfPort,
      },
    };
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.child) return; // already running
    if (!this.cfg.publicNode) {
      this.state = { status: 'not-configured', error: 'network.publicNode not set (user must configure)' };
      log.warn('easytier not starting: publicNode not configured');
      return;
    }
    try {
      assertNotProviderHost(this.cfg.publicNode);
    } catch {
      this.state = { status: 'not-configured', error: 'publicNode is a known AI-provider host, not a relay node' };
      log.warn('easytier not starting: publicNode rejected');
      return;
    }
    if (!this.bin) {
      this.state = { status: 'not-configured', error: 'easytier-core binary not found (set network.easytierBin)' };
      log.warn('easytier not starting: binary not found');
      return;
    }
    const args = this.pcArgs();
    log.info('easytier starting', { bin: this.bin, virtualIp: args[3], publicNode: this.cfg.publicNode });
    this.state = { status: 'starting', bin: this.bin, virtualIp: args[3], publicNode: this.cfg.publicNode };

    try {
      const child = spawn(this.bin, args, {
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });
      this.child = child;
      // §5 (redaction principle, applied to the network component): the per-deployment
      // network-secret is a *SECRET* value EasyTier may echo in startup logs. Register it so
      // any exact match is masked in easytier stdout/stderr below (reuses the existing redactor;
      // no new security model).
      if (this.cfg.networkSecret) registerSecrets(this.cfg.networkSecret);
      this.state = { status: 'starting', pid: child.pid, bin: this.bin, virtualIp: args[3], publicNode: this.cfg.publicNode };

      let started = false;
      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        // Mark running once listeners are added (startup succeeded).
        if (!started && /new listener added|Starting easytier/.test(text)) {
          started = true;
          this.state = { ...this.state, status: 'running' };
          log.info('easytier running', { pid: child.pid });
        }
        for (const line of text.split('\n')) {
          if (line.trim()) log.debug('easytier', { line: safeStderrSummary(line, 200) });
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        for (const line of text.split('\n')) {
          // §5: never log raw easytier stderr; redact registered secrets (network-secret) +
          // value patterns, then hard-truncate. Network name/VIP are not secrets and stay visible.
          if (line.trim()) log.warn('easytier stderr', { line: safeStderrSummary(line, 200) });
        }
      });
      child.on('exit', (code, signal) => {
        const wasRunning = this.state.status === 'running';
        this.child = null;
        if (this.state.status === 'stopped') return; // intentional stop
        // Unexpected exit => failed (C5). Gateway keeps running.
        this.state = {
          status: 'failed',
          bin: this.bin ?? undefined,
          publicNode: this.cfg.publicNode,
          error: `easytier exited unexpectedly (code=${code} signal=${signal})`,
        };
        if (wasRunning) log.error('easytier exited unexpectedly', { code, signal });
        else log.error('easytier failed to start', { code, signal });
      });
      child.on('error', (err) => {
        this.child = null;
        this.state = { status: 'failed', bin: this.bin ?? undefined, error: `spawn error: ${err.message}` };
        log.error('easytier spawn error', { err: err.message });
      });

      // Give it a moment to confirm startup or fail fast on flag errors.
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      if (this.state.status === 'starting' && this.child) {
        // Still starting (no listener line yet) but alive; treat as running. [L] CAVEAT: a process
        // that is alive but stalled (e.g. handshake hang) is misreported as running; 1.5s is a
        // heuristic, not a confirmed-listen check.
        this.state = { ...this.state, status: 'running' };
        log.info('easytier assumed running (alive, no early exit)', { pid: child.pid });
      }
    } catch (e) {
      this.child = null;
      this.state = { status: 'failed', bin: this.bin, error: String(e) };
      log.error('easytier start exception', { err: String(e) });
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = { status: 'stopped' };
      return;
    }
    this.state = { ...this.state, status: 'stopped' };
    log.info('easytier stopping', { pid: child.pid });
    await killTree(child);
    this.child = null;
    this.state = { ...this.state, pid: undefined };
  }

  async restart(): Promise<void> {
    await this.stop();
    this.startPromise = null;
    await this.start();
  }
}

/** Whether two NetworkConfigs differ in a field that affects the running overlay's arg vector
 *  or connectivity. Non-material fields (e.g. future cosmetic ones) don't trigger a restart.
 *  privateMode is excluded: §2 forces it true at load + it is not PATCH-able, so it can never
 *  differ between two configs that passed through loadConfig. */
function materialChange(a: NetworkConfig, b: NetworkConfig): boolean {
  return (
    a.publicNode !== b.publicNode ||
    a.networkName !== b.networkName ||
    a.networkSecret !== b.networkSecret ||
    (a.virtualIp ?? DEFAULT_VIRTUAL_IP) !== (b.virtualIp ?? DEFAULT_VIRTUAL_IP) ||
    (a.backendMapCidr ?? DEFAULT_BACKEND_MAP_CIDR) !== (b.backendMapCidr ?? DEFAULT_BACKEND_MAP_CIDR) ||
    a.easytierBin !== b.easytierBin
  );
}

/** Resolve the easytier-core binary: embedded asset (compiled single-binary
 *  mode, §3) > explicit path > env > vendor dir > PATH. The embedded cache is
 *  populated by materializeEmbeddedBin() at startup (index.ts main / cli.ts
 *  detect); in dev/source mode it is null and we fall through to the filesystem. */
function resolveBin(explicit?: string): string | null {
  // §3: compiled single-binary mode. The embedded easytier-core was materialized
  // to a temp dir at startup; use it (no external bin/ dir or PATH needed).
  const embedded = getEmbeddedBinPath();
  if (embedded) return embedded;
  const exe = isWindows ? 'easytier-core.exe' : 'easytier-core';
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.EASYTIER_BIN) candidates.push(process.env.EASYTIER_BIN);
  // vendor dir next to the running process (dev) or package root
  candidates.push(join(process.cwd(), 'bin', isWindows ? 'win-x64' : process.platform, exe));
  candidates.push(join(homedir(), '.remote-dashboard', 'bin', exe));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return which(exe);
}

/** Robust process-tree kill (Windows taskkill /T /F, unix SIGTERM->SIGKILL). */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (!pid) return resolve();
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.on('exit', finish);
    if (isWindows) {
      // D-4: attach 'error' so a missing taskkill (ENOENT) doesn't become an uncaughtException.
      // The global handler (D-1) would still catch it, but this keeps killTree self-contained and
      // resolves the promise instead of leaving the awaiter hanging.
      spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true })
        .on('close', finish)
        .on('error', (e) => { log.warn('killTree taskkill error', { err: String(e) }); finish(); });
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        finish();
      }, 2000);
    }
    setTimeout(finish, 5000); // safety
  });
}
