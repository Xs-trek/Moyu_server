// AdapterManager: registry of adapters; availability + auth detection + session spawn.
import type {
  Adapter,
  AdapterCompatibility,
  AdapterHistoryPage,
  AdapterHistoryRecord,
  AdapterKind,
  AuthProfile,
  SessionHandle,
  SessionOpts,
} from './types';
import type { AdapterConfig } from '../config/schema';
import { log } from '../util/logger';

export interface AdapterStatus {
  kind: AdapterKind;
  displayName: string;
  available: boolean;
  auth: AuthProfile | null;
  capabilities: Adapter['capabilities'];
  compatibility: AdapterCompatibility;
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
      let compatibility: AdapterCompatibility = {
        state: 'unknown',
        protocol: `${a.kind}-native`,
      };
      try {
        available = await a.isAvailable();
        compatibility = a.compatibility
          ? await a.compatibility()
          : {
              state: available ? 'compatible' : 'unavailable',
              protocol: `${a.kind}-native`,
              ...(available ? {} : { reason: `${a.displayName} runtime is unavailable` }),
            };
        if (compatibility.state !== 'compatible') available = false;
        if (available) auth = await a.detect();
      } catch (e) {
        log.warn('adapter status failed', { kind: a.kind, err: String(e) });
        compatibility = {
          state: 'unavailable',
          protocol: compatibility.protocol,
          reason: 'adapter status check failed',
        };
      }
      if (auth) this.authCache.set(a.kind, auth);
      out.push({ kind: a.kind, displayName: a.displayName, available, auth, capabilities: a.capabilities, compatibility });
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

  /** Aggregate adapter-owned histories without teaching REST about platform ids, storage, or
   * resume formats. The global offset is evaluated over a fresh bounded snapshot. */
  async listHistory(limit: number, offset = 0): Promise<AdapterHistoryPage> {
    const requested = Math.max(1, offset + limit);
    const sources = this.list().filter((adapter) => adapter.history);
    const results = await Promise.allSettled(sources.map((adapter) => adapter.history!.list(requested, 0)));
    const pages: AdapterHistoryPage[] = [];
    const partialFailures: AdapterKind[] = [];
    results.forEach((result, index) => {
      const adapter = sources[index]!;
      if (result.status === 'fulfilled') pages.push(result.value);
      else {
        partialFailures.push(adapter.kind);
        log.warn('adapter history unavailable', { kind: adapter.kind, err: String(result.reason) });
      }
    });
    const all = pages
      .flatMap((page) => page.items)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)
        || a.kind.localeCompare(b.kind)
        || a.resumeRef.localeCompare(b.resumeRef));
    const items = all.slice(offset, offset + limit);
    return {
      items,
      nextOffset: offset + items.length,
      hasMore: offset + items.length < all.length || pages.some((page) => page.hasMore),
      generatedAt: new Date().toISOString(),
      ...(partialFailures.length ? { partialFailures } : {}),
    };
  }

  async readHistory(kind: string, resumeRef: string): Promise<AdapterHistoryRecord | null> {
    const adapter = this.get(kind as AdapterKind);
    if (!adapter?.history) return null;
    return adapter.history.read(resumeRef);
  }

  async disposeAll(): Promise<void> {
    await Promise.all(this.list().map(async (adapter) => {
      try {
        await adapter.dispose?.();
      } catch (error) {
        log.warn('adapter dispose failed', { kind: adapter.kind, err: String(error) });
      }
    }));
  }
}
