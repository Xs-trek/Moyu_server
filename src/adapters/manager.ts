// AdapterManager: registry of adapters; availability + auth detection + session spawn.
import type { Adapter, AdapterKind, AuthProfile, SessionHandle, SessionOpts } from './types';
import type { AdapterConfig } from '../config/schema';
import { log } from '../util/logger';

export interface AdapterStatus {
  kind: AdapterKind;
  displayName: string;
  available: boolean;
  auth: AuthProfile | null;
  capabilities: Adapter['capabilities'];
  /** Added by the REST projection from local config/profile data; never provider-probed. */
  cliDefaultModel?: string;
  effectiveModel?: string;
  modelOverride?: string;
}

export class AdapterManager {
  private adapters = new Map<AdapterKind, Adapter>();
  private authCache = new Map<AdapterKind, AuthProfile>();

  register(a: Adapter): void {
    this.adapters.set(a.kind, a);
    log.info('adapter registered', { kind: a.kind, name: a.displayName });
  }

  get(kind: AdapterKind): Adapter | undefined {
    return this.adapters.get(kind);
  }

  has(kind: string): kind is AdapterKind {
    return this.adapters.has(kind as AdapterKind);
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }

  async refreshStatus(): Promise<AdapterStatus[]> {
    const out: AdapterStatus[] = [];
    for (const a of this.list()) {
      let available = false;
      let auth: AuthProfile | null = null;
      try {
        available = await a.isAvailable();
        if (available) auth = await a.detect();
      } catch (e) {
        log.warn('adapter status failed', { kind: a.kind, err: String(e) });
      }
      if (auth) this.authCache.set(a.kind, auth);
      out.push({ kind: a.kind, displayName: a.displayName, available, auth, capabilities: a.capabilities });
    }
    return out;
  }

  authOf(kind: AdapterKind): AuthProfile | null {
    return this.authCache.get(kind) ?? null;
  }

  async startSession(kind: AdapterKind, opts: SessionOpts): Promise<SessionHandle> {
    const a = this.get(kind);
    if (!a) throw new Error(`adapter not registered: ${kind}`);
    if (!(await a.isAvailable())) throw new Error(`adapter not available: ${kind}`);
    return a.startSession(opts);
  }

  /** Live-apply a /config PATCH to a registered adapter (review P1). */
  reconfigure(kind: AdapterKind, opts: { approvalTimeoutSec: number; adapterConfig: AdapterConfig }): void {
    this.adapters.get(kind)?.reconfigure?.(opts);
  }

  /** Apply config through the registry so adding an adapter does not add REST conditionals. */
  reconfigureAll(
    approvalTimeoutSec: number,
    configs: Partial<Record<AdapterKind, AdapterConfig>>,
  ): void {
    for (const adapter of this.adapters.values()) {
      const adapterConfig = configs[adapter.kind];
      if (adapterConfig) adapter.reconfigure?.({ approvalTimeoutSec, adapterConfig });
    }
  }
}
