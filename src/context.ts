// Shared server context (hub type to avoid circular imports).
import type { AppConfig } from './config/schema';
import type { AdapterManager } from './adapters/manager';
import type { SessionManager } from './session/manager';
import type { HookRegistry } from './api/hooks';
import type { EasyTierController } from './net/easytier';
import type { PairingService } from './net/pairing';
import type { AccountService } from './accounts/service';
import type { NetNotifier } from './api/ws';
import type { InboundPolicy, NetStatus } from './net/types';
import type { ArtifactStore } from './artifacts/store';

export interface NetStatusProvider {
  getStatus(): Promise<NetStatus>;
  /** Re-probe, optionally with the mobile client's IPv6 availability. */
  refresh?(mobileV6Available?: boolean): Promise<NetStatus>;
  /** Apply a new publicNode URL live (after a config PATCH). */
  setPublicNode?(url: string): void;
  /** Apply the effective loopback/overlay inbound boundary live. */
  setInboundPolicy?(policy: InboundPolicy): void;
}

export interface ServerContext {
  config: AppConfig;
  adapters: AdapterManager;
  sessions: SessionManager;
  artifacts: ArtifactStore;
  hooks: HookRegistry;
  port: number;
  startedAt: string;
  net: NetStatusProvider;
  overlay: EasyTierController;
  accounts: AccountService; // v3: subscription/profile discovery + switching (no probe; C3 0-perception)
  /** One-time pairing orchestrator (F1/F2). Always present; inactive until the
   *  operator triggers /api/v1/pair/start. Holds the transient pairing overlay + code. */
  pairing: PairingService;
  /** §10 I7: broadcasts network change notifications (monotonic seq + snapshot) to all
   *  authenticated WS clients on net refresh / overlay state change / config hot-update. */
  netNotifier: NetNotifier;
  /** Request a graceful process shutdown from a PC-local control-plane route. The route is
   *  protected by a control secret that is never conveyed to paired mobile clients. */
  requestShutdown(reason: string): void;
}
