import type {
  Adapter,
  AdapterHistoryItem,
  AdapterHistoryProvider,
  AdapterHistoryRecord,
  AuthProfile,
  SessionHandle,
  SessionOpts,
} from '../types';
import type { AdapterConfig } from '../../config/schema';
import { log } from '../../util/logger';
import { type OpenCodeMessageRecord, type OpenCodeSessionInfo } from './client';
import { OpenCodeServerRuntime } from './runtime';
import { normalizeOpenCodeMessages, OpenCodeSession } from './session';

export interface OpencodeAdapterDeps {
  approvalTimeoutSec: number;
  adapterConfig: AdapterConfig;
  password?: string;
  username?: string;
}

function validResumeRef(value: string): boolean {
  return value.length > 0 && value.length <= 512 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function modelFrom(records: readonly OpenCodeMessageRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const info = records[index]!.info;
    if (info.role !== 'assistant') continue;
    if (info.providerID && info.modelID) return `${info.providerID}/${info.modelID}`;
    if (info.model?.providerID && info.model.modelID) return `${info.model.providerID}/${info.model.modelID}`;
  }
  return undefined;
}

export class OpencodeAdapter implements Adapter {
  readonly kind = 'opencode' as const;
  readonly displayName = 'OpenCode';
  readonly capabilities = {
    streaming: { text: true, thinking: true, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: false,
    runtime: { source: 'local-server' as const, shared: true },
    history: { list: true, messages: true, resume: true },
    attachments: { images: false, maxCount: 0 },
    approval: {
      transport: 'native' as const,
      semantics: 'native' as const,
      policies: [] as const,
      choices: ['allow', 'allow_session', 'deny', 'cancel'] as const,
    },
    configuration: {
      model: true,
      modelSelection: 'freeform' as const,
      effortLevels: [] as const,
      permissionModes: [] as const,
      sandboxModes: [] as const,
      reviewers: [] as const,
    },
  };
  readonly history: AdapterHistoryProvider;
  private runtime: OpenCodeServerRuntime;

  constructor(private deps: OpencodeAdapterDeps) {
    this.runtime = new OpenCodeServerRuntime({
      adapterConfig: deps.adapterConfig,
      password: deps.password,
      username: deps.username,
    });
    this.history = {
      list: (limit, offset = 0) => this.listHistory(limit, offset),
      read: (resumeRef) => this.readHistory(resumeRef),
    };
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.runtime.binaryCompatibility();
    return result.state !== 'unavailable' && result.state !== 'incompatible';
  }

  compatibility() {
    return this.runtime.compatibility();
  }

  async detect(): Promise<AuthProfile> {
    // Server availability is independent of provider credentials. OpenCode may provide built-in
    // free models, while subscriptions/API keys remain entirely owned by OpenCode configuration.
    return { adapter: 'opencode', mode: 'none', hasCredentials: false };
  }

  async startSession(opts: SessionOpts): Promise<SessionHandle> {
    const session = new OpenCodeSession(this.runtime, {
      sessionId: opts.sessionId,
      resumeRef: opts.resumeRef,
      cwd: opts.cwd!,
      approvalTimeoutSec: this.deps.approvalTimeoutSec,
      model: opts.model ?? this.deps.adapterConfig.model,
    });
    try {
      await session.init();
    } catch (error) {
      await session.dispose().catch(() => {});
      throw error;
    }
    return session;
  }

  reconfigure(opts: { approvalTimeoutSec: number; adapterConfig: AdapterConfig }): void {
    // server ownership/address/bin are PC-local and cannot change through /config PATCH. Only
    // the model and approval timeout can change for future sessions here.
    this.deps = { ...this.deps, approvalTimeoutSec: opts.approvalTimeoutSec, adapterConfig: opts.adapterConfig };
  }

  private async discoverSessions(): Promise<OpenCodeSessionInfo[]> {
    const client = await this.runtime.client();
    const directories = new Set(this.runtime.directories());
    try {
      const path = await client.getPath();
      if (path.directory) directories.add(path.directory);
      if (path.worktree && path.worktree !== '/') directories.add(path.worktree);
    } catch (error) {
      log.warn('OpenCode current path discovery failed', { err: String(error) });
    }
    try {
      for (const project of await client.listProjects()) {
        // The global project reports '/', which does not identify its actual non-git cwd. That
        // cwd comes from /path, bound sessions, or observed Session.directory values.
        if (project.worktree && project.worktree !== '/') directories.add(project.worktree);
      }
    } catch (error) {
      log.warn('OpenCode project discovery failed', { err: String(error) });
    }

    const queried = new Set<string>();
    const sessions = new Map<string, OpenCodeSessionInfo>();
    const query = async (directory?: string) => {
      const key = directory ?? '<default>';
      if (queried.has(key)) return;
      queried.add(key);
      try {
        for (const session of await client.listSessions(directory)) {
          if (!session?.id) continue;
          const current = sessions.get(session.id);
          if (!current || (session.time?.updated ?? 0) > (current.time?.updated ?? 0)) sessions.set(session.id, session);
          if (session.directory) {
            directories.add(session.directory);
            this.runtime.rememberSession(session.id, session.directory);
          }
        }
      } catch (error) {
        log.warn('OpenCode directory history unavailable', { directory: directory ? 'configured' : 'default', err: String(error) });
      }
    };
    await query(undefined);
    // A discovered session may introduce another non-git directory. Iterate a bounded number of
    // times until the known-directory set stabilizes; no private database is consulted.
    for (let pass = 0; pass < 3; pass++) {
      const before = queried.size;
      await Promise.all([...directories].map((directory) => query(directory)));
      if (queried.size === before) break;
    }
    return [...sessions.values()];
  }

  private async listHistory(limit: number, offset: number) {
    const client = await this.runtime.client();
    const all = (await this.discoverSessions())
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0) || a.id.localeCompare(b.id));
    const selected = all.slice(offset, offset + limit);
    const messages = await Promise.allSettled(selected.map((session) =>
      client.listMessages(session.id, session.directory)));
    const items: AdapterHistoryItem[] = selected.map((session, index) => {
      const result = messages[index]!;
      const records = result.status === 'fulfilled' ? result.value : [];
      return {
        resumeRef: session.id,
        nativeSessionId: session.id,
        kind: 'opencode',
        title: session.title?.trim() || `OpenCode ${session.id.slice(0, 12)}`,
        cwd: session.directory,
        model: modelFrom(records) ?? this.deps.adapterConfig.model,
        updatedAt: new Date(session.time?.updated ?? session.time?.created ?? Date.now()).toISOString(),
        messageCount: normalizeOpenCodeMessages(records).length,
        resumable: true,
      };
    });
    return {
      items,
      nextOffset: offset + items.length,
      hasMore: offset + items.length < all.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private async readHistory(resumeRef: string): Promise<AdapterHistoryRecord | null> {
    if (!validResumeRef(resumeRef)) return null;
    const client = await this.runtime.client();
    let directory = this.runtime.directoryForSession(resumeRef);
    let info: OpenCodeSessionInfo | undefined;
    if (!directory) {
      info = (await this.discoverSessions()).find((session) => session.id === resumeRef);
      directory = info?.directory;
    }
    if (!directory) return null;
    try {
      info ??= await client.getSession(resumeRef, directory);
      if (!info || info.id !== resumeRef) return null;
      const records = await client.listMessages(resumeRef, directory);
      const messages = normalizeOpenCodeMessages(records);
      const item: AdapterHistoryItem = {
        resumeRef,
        nativeSessionId: resumeRef,
        kind: 'opencode',
        title: info.title?.trim() || `OpenCode ${resumeRef.slice(0, 12)}`,
        cwd: info.directory || directory,
        model: modelFrom(records) ?? this.deps.adapterConfig.model,
        updatedAt: new Date(info.time?.updated ?? info.time?.created ?? Date.now()).toISOString(),
        messageCount: messages.length,
        resumable: true,
      };
      this.runtime.rememberSession(resumeRef, item.cwd!);
      return {
        item,
        messages,
        resume: { cwd: item.cwd, displayModel: item.model },
      };
    } catch {
      return null;
    }
  }

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}

export function createOpencodeAdapter(deps: OpencodeAdapterDeps): OpencodeAdapter {
  return new OpencodeAdapter(deps);
}
