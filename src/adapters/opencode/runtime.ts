// One OpenCode Server per Moyu gateway. Sessions are lightweight bindings to this runtime;
// disposing a session never owns or terminates the shared server.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { AdapterCompatibility } from '../types';
import type { AdapterConfig } from '../../config/schema';
import { categorizeError, log, registerEnvSecrets, registerSecrets, safeStderrSummary } from '../../util/logger';
import { getArch, getPlatform, isWindows } from '../../util/platform';
import { scrubMoyuEnv } from '../../util/runtime';
import { probeVersion, which } from '../../util/spawn';
import { normalizeLoopbackServerUrl, OpenCodeClient, type OpenCodeGlobalEvent } from './client';

export interface OpenCodeRuntimeOptions {
  adapterConfig: AdapterConfig;
  password?: string;
  username?: string;
}

const MIN_SUPPORTED = [1, 17, 9] as const;
const MAX_EXCLUSIVE = [1, 19, 0] as const;

function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** v0.0.4 is fixture- and real-smoke-bound to the 1.17.9..1.18.x Server contract. */
export function supportedOpenCodeVersion(value: string | undefined): boolean {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\b|$)/.exec(value ?? '');
  if (!match) return false;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])];
  return compareVersion(parsed, MIN_SUPPORTED) >= 0 && compareVersion(parsed, MAX_EXCLUSIVE) < 0;
}

export interface OpenCodeRuntimeDeps {
  spawn?: typeof spawn;
  resolveBinary?: typeof resolveOpenCodeBinary;
  probeVersion?: typeof probeVersion;
}

interface Listener {
  directory: string;
  onEvent: (event: OpenCodeGlobalEvent) => void;
  onReconnect: () => void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function resolveOpenCodeBinary(configured?: string): string | null {
  const located = configured ? (which(configured) ?? configured) : which('opencode');
  if (!located) return null;
  if (!/\.(cmd|bat)$/i.test(located)) return located;
  if (!isWindows) return null;
  const root = dirname(located);
  const modulesRoot = basename(root).toLowerCase() === '.bin'
    && basename(dirname(root)).toLowerCase() === 'node_modules'
    ? dirname(root)
    : undefined;
  const packageName = getArch() === 'arm64' ? 'opencode-windows-arm64' : 'opencode-windows-x64';
  const candidates = [
    join(root, 'node_modules', packageName, 'bin', 'opencode.exe'),
    join(root, 'node_modules', 'opencode-ai', 'node_modules', packageName, 'bin', 'opencode.exe'),
    ...(modulesRoot ? [
      join(modulesRoot, packageName, 'bin', 'opencode.exe'),
      join(modulesRoot, 'opencode-ai', 'node_modules', packageName, 'bin', 'opencode.exe'),
    ] : []),
  ];
  return candidates.find(existsSync) ?? null;
}

function eventSessionId(event: OpenCodeGlobalEvent): string | undefined {
  const properties = event.payload.properties;
  if (!properties) return undefined;
  const direct = properties.sessionID;
  if (typeof direct === 'string') return direct;
  const info = properties.info as Record<string, unknown> | undefined;
  if (info && typeof info.sessionID === 'string') return info.sessionID;
  if (event.payload.type.startsWith('session.') && info && typeof info.id === 'string') return info.id;
  const part = properties.part as Record<string, unknown> | undefined;
  if (part && typeof part.sessionID === 'string') return part.sessionID;
  return undefined;
}

export class OpenCodeServerRuntime {
  private child: ChildProcess | null = null;
  private childOwned = false;
  private stderr = '';
  private clientValue: OpenCodeClient | null = null;
  private initPromise: Promise<OpenCodeClient> | null = null;
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private disposed = false;
  private listeners = new Map<string, Set<Listener>>();
  private knownDirectories = new Set<string>([homedir()]);
  private sessionDirectories = new Map<string, string>();
  private compatibilityValue: AdapterCompatibility = {
    state: 'unknown',
    protocol: 'opencode-server-api',
  };

  constructor(private opts: OpenCodeRuntimeOptions, private runtimeDeps: OpenCodeRuntimeDeps = {}) {}

  private resolveBinary(configured?: string): string | null {
    return (this.runtimeDeps.resolveBinary ?? resolveOpenCodeBinary)(configured);
  }

  private mode(): 'managed' | 'attach' {
    return this.opts.adapterConfig.serverMode === 'attach' ? 'attach' : 'managed';
  }

  async binaryCompatibility(): Promise<AdapterCompatibility> {
    if (this.mode() === 'attach') return this.compatibility();
    const bin = this.resolveBinary(this.opts.adapterConfig.bin);
    if (!bin) {
      return { state: 'unavailable', protocol: 'opencode-server-api', reason: 'OpenCode executable for managed Server mode is unavailable' };
    }
    const result = await (this.runtimeDeps.probeVersion ?? probeVersion)(bin);
    return result.ok
      ? { state: 'unknown', protocol: 'opencode-server-api', version: result.version }
      : { state: 'unavailable', protocol: 'opencode-server-api', reason: 'OpenCode managed Server executable version probe failed' };
  }

  async compatibility(): Promise<AdapterCompatibility> {
    try {
      await this.ensureReady();
      return this.compatibilityValue;
    } catch (error) {
      return {
        ...this.compatibilityValue,
        state: this.compatibilityValue.state === 'incompatible' ? 'incompatible' : 'unavailable',
        reason: error instanceof Error ? error.message : 'OpenCode server is unavailable',
      };
    }
  }

  async ensureReady(): Promise<OpenCodeClient> {
    if (this.disposed) throw new Error('OpenCode runtime is disposed');
    if (this.clientValue) {
      try {
        const health = await this.clientValue.health();
        if (health.healthy) return this.clientValue;
      } catch {
        await this.stopEventLoop();
        this.clientValue = null;
      }
    }
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  client(): Promise<OpenCodeClient> {
    return this.ensureReady();
  }

  /** Return the current bridge without starting/restarting a managed or attached server. Used
   * only by best-effort session cleanup, where reconnecting would violate process ownership. */
  readyClient(): OpenCodeClient | null {
    return this.clientValue;
  }

  rememberDirectory(directory: string): void {
    if (directory) this.knownDirectories.add(directory);
  }

  directories(): string[] {
    return [...this.knownDirectories];
  }

  rememberSession(sessionId: string, directory: string): void {
    this.rememberDirectory(directory);
    if (sessionId && directory) this.sessionDirectories.set(sessionId, directory);
  }

  directoryForSession(sessionId: string): string | undefined {
    return this.sessionDirectories.get(sessionId);
  }

  private async initialize(): Promise<OpenCodeClient> {
    const username = this.opts.username ?? this.opts.adapterConfig.serverUsername
      ?? process.env.OPENCODE_SERVER_USERNAME ?? 'opencode';
    const password = this.opts.password ?? this.opts.adapterConfig.serverPassword
      ?? process.env.OPENCODE_SERVER_PASSWORD;
    let baseUrl: string;
    if (this.mode() === 'attach') {
      baseUrl = this.opts.adapterConfig.serverUrl ?? 'http://127.0.0.1:4096';
    } else {
      const bin = this.resolveBinary(this.opts.adapterConfig.bin);
    if (!bin) throw new Error('OpenCode executable not found for managed Server mode; set adapters.opencode.bin, install OpenCode, or use attach mode');
      baseUrl = normalizeLoopbackServerUrl(this.opts.adapterConfig.serverUrl ?? 'http://127.0.0.1:4096');
      const parsed = new URL(baseUrl);
      const port = Number(parsed.port || 80);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid OpenCode managed server port');
      await this.startManaged(bin, port, username, password);
    }
    const client = new OpenCodeClient(baseUrl, username, password);
    const deadline = Date.now() + 15_000;
    let healthVersion: string | undefined;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const health = await client.health();
        if (health.healthy) {
          healthVersion = health.version;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(150);
    }
    if (!healthVersion) {
      if (this.childOwned) await this.stopOwnedChild();
      throw new Error(`OpenCode server did not become ready${lastError ? `: ${String(lastError)}` : ''}`);
    }
    // Close the narrow bind-race window: a child that lost its port can briefly coexist with a
    // healthy unrelated server before its asynchronous exit notification is delivered.
    if (this.childOwned) await delay(100);
    if (this.childOwned && (!this.child || this.child.exitCode !== null)) {
      await this.stopOwnedChild();
      throw new Error('OpenCode managed child exited before ownership was established');
    }
    if (!supportedOpenCodeVersion(healthVersion)) {
      this.compatibilityValue = {
        state: 'incompatible',
        protocol: 'opencode-server-api',
        version: healthVersion,
        reason: 'Moyu v0.0.4 supports OpenCode Server 1.17.9 through 1.18.x',
      };
      if (this.childOwned) await this.stopOwnedChild();
      throw new Error('unsupported OpenCode Server version');
    }
    // Required-route smoke is the compatibility gate. An upstream route change fails this
    // adapter closed without changing SessionManager, REST, Android, or Web UI.
    try {
      const sessions = await client.listSessions(homedir());
      if (!Array.isArray(sessions)) throw new Error('session list response is not an array');
      const projects = await client.listProjects();
      if (!Array.isArray(projects)) throw new Error('project list response is not an array');
    } catch (error) {
      this.compatibilityValue = {
        state: 'incompatible',
        protocol: 'opencode-server-api',
        version: healthVersion,
        reason: 'required OpenCode Session API is unavailable',
      };
      if (this.childOwned) await this.stopOwnedChild();
      throw error;
    }
    this.clientValue = client;
    this.compatibilityValue = {
      state: 'compatible',
      protocol: 'opencode-server-api',
      version: healthVersion,
    };
    this.startEventLoop();
    log.info('shared OpenCode server ready', {
      mode: this.mode(),
      version: healthVersion,
      url: client.baseUrl,
      ownership: this.childOwned ? 'moyu' : 'external',
    });
    return client;
  }

  private async startManaged(bin: string, port: number, username: string, password?: string): Promise<void> {
    if (this.child) return;
    const env = scrubMoyuEnv(process.env, undefined, homedir());
    if (username) env.OPENCODE_SERVER_USERNAME = username;
    if (password) env.OPENCODE_SERVER_PASSWORD = password;
    registerEnvSecrets(env);
    if (password) registerSecrets(password);
    this.stderr = '';
    const child = (this.runtimeDeps.spawn ?? spawn)(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: homedir(),
      env,
      windowsHide: true,
    });
    this.child = child;
    this.childOwned = true;
    child.stderr?.on('data', (data: Buffer) => {
      if (this.stderr.length < 2 * 1024 * 1024) this.stderr += data.toString('utf8');
    });
    child.on('error', (error) => {
      log.warn('OpenCode managed server spawn error', { err: String(error) });
    });
    child.on('close', (code) => {
      if (this.stderr.trim()) {
        log.warn('OpenCode managed server stderr summary', {
          code,
          category: categorizeError(this.stderr),
          summary: safeStderrSummary(this.stderr),
        });
      } else {
        log.info('OpenCode managed server exited', { code });
      }
      if (this.child === child) {
        this.child = null;
        this.clientValue = null;
        this.streamAbort?.abort();
      }
    });
  }

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, set = new Set());
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  private startEventLoop(): void {
    if (this.streamTask || !this.clientValue || this.disposed) return;
    const ctrl = new AbortController();
    this.streamAbort = ctrl;
    const client = this.clientValue;
    this.streamTask = (async () => {
      let connectedOnce = false;
      let retryMs = 200;
      while (!ctrl.signal.aborted && !this.disposed) {
        try {
          await client.globalEvents(
            ctrl.signal,
            (event) => this.dispatch(event),
            () => {
              retryMs = 200;
              if (connectedOnce) {
                for (const listeners of this.listeners.values()) {
                  for (const listener of listeners) void Promise.resolve().then(listener.onReconnect);
                }
              }
              connectedOnce = true;
            },
          );
          if (!ctrl.signal.aborted) throw new Error('OpenCode global event stream ended');
        } catch (error) {
          if (ctrl.signal.aborted) break;
          log.warn('OpenCode global event stream reconnecting', { err: String(error), retryMs });
          await delay(retryMs);
          retryMs = Math.min(5_000, retryMs * 2);
        }
      }
    })().finally(() => {
      if (this.streamAbort === ctrl) this.streamAbort = null;
      this.streamTask = null;
    });
  }

  private dispatch(event: OpenCodeGlobalEvent): void {
    const sessionId = eventSessionId(event);
    if (!sessionId) return;
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      // Session ids are globally opaque and stable. Directory is an additional isolation check
      // when the server reports one; path spelling differences do not suppress the event.
      if (event.directory && listener.directory && event.directory !== listener.directory) {
        log.debug('OpenCode event directory differs from bound cwd', { sessionId });
      }
      try { listener.onEvent(event); } catch (error) {
        log.warn('OpenCode session event listener failed', { sessionId, err: String(error) });
      }
    }
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child || !this.childOwned) return;
    this.child = null;
    this.childOwned = false;
    const closed = child.exitCode === null
      ? new Promise<void>((resolve) => child.once('close', () => resolve()))
      : Promise.resolve();
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
    await Promise.race([
      closed,
      delay(1_500),
    ]);
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }
  }

  private async stopEventLoop(): Promise<void> {
    const task = this.streamTask;
    this.streamAbort?.abort();
    if (task) await task.catch(() => {});
    this.streamAbort = null;
    this.streamTask = null;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.sessionDirectories.clear();
    await this.stopEventLoop();
    this.clientValue = null;
    // Attach mode owns no process and must never terminate the external Desktop backend.
    await this.stopOwnedChild();
  }
}

export function openCodeRuntimePlatform(): string {
  return `${getPlatform()}-${getArch()}`;
}
