// PairingService (F1/F2): one-time, in-band credential conveyance over a transient
// pairing overlay. Closes the bootstrap hole (F1): pre-pairing the phone has no token
// and cannot reach /api/v1/*, so it cannot fetch join params. Instead the PC starts a
// SHORT-LIVED second easytier network (`rd-pair`, secret = the one-time code C) that
// the phone joins with just {relayNode, C, gatewayPort}. The phone POSTs C to /pair
// (Bearer-exempt; auth = C); the PC verifies+consumes C and returns the REAL network
// creds {N, S, token, gatewayPort, mobileVip, ...} over the same E2E-encrypted overlay.
//
// Threat model & mitigations:
//   - C is 8-char Crockford base32 (~40 bits). Online brute-force over the 5-min window
//     is infeasible (2^40 ≈ 1.1e12); a 5-wrong-attempt cap makes it impossible.
//   - Single-use: first correct guess consumes C; a replay gets nothing.
//   - /pair is reachable via BOTH overlays (real 10.1.1.10 + pairing 10.1.1.11) since
//     both map to 127.0.0.1. An S-holder (compromised real secret) reaching /pair during
//     a pairing window could try to steal T -- defeated by the 40-bit C + 5-attempt cap.
//   - The pairing overlay is torn down on success, on timeout (5 min, fail-closed), or on
//     5 wrong attempts. The real overlay (long-lived S) is untouched.
//   - F2 (rotation/revocation): token T is conveyed at pairing; rotating T = regen +
//     re-pair. No remote revocation (accepted residual); a stolen phone requires the
//     operator to rotate T + re-pair on the PC.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EasyTierController } from './easytier';
import type { AppConfig, NetworkConfig } from '../config/schema';
import { log } from '../util/logger';

// Crockford base32 (excludes I/L/O/U to avoid 0/O, 1/I confusion). 8 chars = 40 bits.
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 8;
const MAX_ATTEMPTS = 5;
const PAIR_TIMEOUT_MS = 5 * 60 * 1000; // Bounded one-time pairing window.

// Pairing overlay constants (protocol-fixed; the phone app hardcodes these too).
const PAIR_NETWORK_NAME = 'rd-pair';
const PAIR_PC_VIRTUAL_IP = '10.144.144.2'; // PC's VIP in the pairing network
const PAIR_PHONE_VIRTUAL_IP = '10.144.144.4'; // phone's VIP in the pairing network
const PAIR_BACKEND_MAP_CIDR = '10.1.1.11/32'; // pairing VIP -> backend (distinct from real 10.1.1.10)
const PAIR_BACKEND_VIP = '10.1.1.11';

/** Credentials handed to the phone once C is verified. The phone persists these and
 *  switches to the real network (N, S); it does NOT retain C or the pairing network. */
export interface PairingHandoff {
  networkName: string;
  networkSecret: string;
  token: string;
  gatewayPort: number;
  mobileVip: string; // phone's VIP in the REAL network
  backendVip: string; // --port-forward target VIP in the real network (10.1.1.10)
  virtualIp: string; // PC's real VIP (informational)
  publicNode: string;
  privateMode: boolean;
}

export interface PairingStartResult {
  code: string;
  gatewayPort: number;
  /** Convenience pairing string shown to the operator: "<CODE>:<gatewayPort>". */
  pairString: string;
  /** Phone's --port-forward target during pairing (protocol constant, for the UI). */
  pairBackendVip: string;
  pairNetworkName: string;
}

/** Outcome of a pairing session. Survives stop() for local status diagnostics. */
export type PairingResult = 'idle' | 'pending' | 'success' | 'timeout' | 'capped';

export interface PairingStatus {
  active: boolean;
  result: PairingResult;
  startedAt: string | null;
  attempts: number;
  maxAttempts: number;
}

function genPairCode(): string {
  // 5 bytes = 40 bits -> 8 base32 chars.
  const bytes = randomBytes(5);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out = BASE32[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function constTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export class PairingService {
  private code: string | null = null;
  private overlay: EasyTierController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private consumed = false;
  private attempts = 0;
  private startedAt: string | null = null;
  private result: PairingResult = 'idle';

  constructor(private getConfig: () => AppConfig, private gatewayPort: number) {}

  isActive(): boolean {
    return this.code !== null && !this.consumed && this.attempts < MAX_ATTEMPTS;
  }

  getStatus(): PairingStatus {
    return {
      active: this.isActive(),
      result: this.result,
      startedAt: this.startedAt,
      attempts: this.attempts,
      maxAttempts: MAX_ATTEMPTS,
    };
  }

  /** Start a pairing session: generate C + spawn the transient pairing overlay.
   *  Throws if already active or the overlay cannot start (no publicNode/bin). */
  async start(): Promise<PairingStartResult> {
    if (this.code) throw new Error('pairing already active');
    // Read LIVE config: applyPatch reassigns ctx.config, so a captured reference would go
    // stale if the operator PATCHed publicNode/virtualIp/backendMapCidr before pairing.
    const cfg = this.getConfig();
    if (!cfg.network.publicNode) throw new Error('network.publicNode not set (run moyu -init)');
    if (!cfg.token) throw new Error('no gateway token (run moyu -init)');
    const n = cfg.network;
    if (!n.networkName || !n.networkSecret) throw new Error('network name/secret missing (run moyu -init)');

    const code = genPairCode();
    const pairNet: NetworkConfig = {
      publicNode: n.publicNode,
      virtualIp: PAIR_PC_VIRTUAL_IP,
      backendMapCidr: PAIR_BACKEND_MAP_CIDR,
      networkName: PAIR_NETWORK_NAME,
      networkSecret: code, // the one-time code IS the pairing network secret
      privateMode: true,
      easytierBin: n.easytierBin,
    };
    // The real PC overlay is already running and owns EasyTier's default listener set.
    // Pairing is a second, outbound-only overlay that dials the same shared relay; disabling
    // its listeners prevents an immediate 11010-11013 bind collision without changing the
    // long-lived overlay's P2P behavior. Its process-wide RPC portal also needs a distinct
    // off-map loopback address: EasyTier 2.6.4 may otherwise choose 127.0.0.2:15888 for both
    // processes even though `:0` was requested.
    this.overlay = new EasyTierController(pairNet, {
      noListener: true,
      rpcPortal: '127.0.0.3:0',
    });
    this.code = code;
    this.consumed = false;
    this.attempts = 0;
    this.startedAt = new Date().toISOString();
    this.result = 'pending';
    await this.overlay.start();
    if (this.overlay.getState().status === 'not-configured' || this.overlay.getState().status === 'failed') {
      const err = this.overlay.getState().error ?? 'pairing overlay failed to start';
      this.overlay = null;
      this.code = null;
      this.startedAt = null;
      throw new Error(err);
    }

    this.timer = setTimeout(() => {
      log.warn('pairing timed out -> fail-closed teardown');
      this.result = 'timeout';
      void this.stop();
    }, PAIR_TIMEOUT_MS);
    this.timer.unref?.();

    log.info('pairing started', { gatewayPort: this.gatewayPort });
    return {
      code,
      gatewayPort: this.gatewayPort,
      pairString: `${code}:${this.gatewayPort}`,
      pairBackendVip: PAIR_BACKEND_VIP,
      pairNetworkName: PAIR_NETWORK_NAME,
    };
  }

  /** Verify + consume the one-time code. Returns handoff creds on success, null otherwise.
   *  After MAX_ATTEMPTS wrong guesses, auto-tears-down (fail-closed). */
  verifyAndConsume(code: string | undefined): PairingHandoff | null {
    if (!this.code || this.consumed || this.attempts >= MAX_ATTEMPTS) return null;
    const guess = (code ?? '').toUpperCase();
    if (!constTimeEqual(guess, this.code)) {
      this.attempts += 1;
      log.warn('pair: wrong code', { attempts: this.attempts });
      if (this.attempts >= MAX_ATTEMPTS) {
        log.warn('pair: attempt cap reached -> fail-closed teardown');
        this.result = 'capped';
        void this.stop();
      }
      return null;
    }
    this.consumed = true;
    this.result = 'success';
    const cfg = this.getConfig();
    const n = cfg.network;
    const backendMapCidr = n.backendMapCidr ?? '10.1.1.10/32';
    return {
      networkName: n.networkName ?? '',
      networkSecret: n.networkSecret ?? '',
      token: cfg.token ?? '',
      gatewayPort: this.gatewayPort,
      mobileVip: '10.144.144.3',
      backendVip: backendMapCidr.replace(/\/\d+$/, ''),
      virtualIp: n.virtualIp ?? '10.144.144.1',
      publicNode: n.publicNode,
      privateMode: n.privateMode,
    };
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.code = null;
    this.consumed = false;
    this.attempts = 0;
    this.startedAt = null;
    if (this.overlay) {
      try {
        await this.overlay.stop();
      } catch (e) {
        log.warn('pairing overlay stop error', { err: String(e) });
      }
      this.overlay = null;
    }
    log.info('pairing stopped');
  }
}

// Re-exported protocol constants for the CLI / frontend architecture reference.
export const PAIRING_CONSTANTS = {
  PAIR_NETWORK_NAME,
  PAIR_PHONE_VIRTUAL_IP,
  PAIR_BACKEND_VIP,
  CODE_LEN,
  MAX_ATTEMPTS,
  PAIR_TIMEOUT_MS,
} as const;
