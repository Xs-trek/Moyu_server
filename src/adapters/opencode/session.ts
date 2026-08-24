import type {
  AdapterEvent,
  ApprovalDecision,
  ApprovalKind,
  Message,
  SessionHandle,
  Usage,
  UserInput,
} from '../types';
import { ApprovalTracker, toOpencode } from '../../approval/bridge';
import { categorizeError, log, safeStderrSummary, type SafeFailure } from '../../util/logger';
import {
  parseOpenCodeModel,
  type OpenCodeGlobalEvent,
  type OpenCodeMessageInfo,
  type OpenCodeMessageRecord,
  type OpenCodePart,
} from './client';
import type { OpenCodeServerRuntime } from './runtime';

const MAX_HISTORY_MESSAGES = 5_000;
const NOOP = (_event: AdapterEvent): void => {};

export interface OpenCodeSessionOpts {
  sessionId: string;
  resumeRef?: string;
  cwd: string;
  title?: string;
  approvalTimeoutSec: number;
  model?: string;
}

function iso(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : new Date().toISOString();
}

function upstreamErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const data = value.data as Record<string, unknown> | undefined;
    if (data && typeof data.message === 'string') return data.message;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.name === 'string') return value.name;
  }
  return 'OpenCode turn failed';
}

/** Convert an upstream failure to a stable phone-safe vocabulary. The original text is used
 * only for local redacted diagnostics and category selection; it is never placed in an event. */
function clientSafeError(error: unknown): SafeFailure {
  const raw = upstreamErrorText(error);
  const category = categorizeError(raw);
  log.warn('OpenCode upstream turn failure', { category, summary: safeStderrSummary(raw) });
  const summaries: Record<SafeFailure['category'], string> = {
    auth: 'OpenCode authentication failed',
    'rate-limit': 'OpenCode request was rate limited',
    network: 'OpenCode connection failed',
    'not-found': 'OpenCode resource is unavailable',
    parse: 'OpenCode protocol response was invalid',
    unknown: 'OpenCode turn failed',
  };
  return { category, summary: summaries[category] };
}

function contentMessage(record: OpenCodeMessageRecord): Omit<Message, 'seq'> | null {
  const text = record.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('');
  const thinking = record.parts
    .filter((part) => part.type === 'reasoning' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('');
  if (!text && !thinking) return null;
  return {
    sourceId: `opencode:${record.info.id}`,
    role: record.info.role,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    createdAt: iso(record.info.time?.created),
  };
}

function toolMessage(info: OpenCodeMessageInfo, part: OpenCodePart): Omit<Message, 'seq'> | null {
  if (part.type !== 'tool' || !part.callID) return null;
  const state = part.state ?? {};
  const output = typeof state.output === 'string' ? state.output
    : typeof state.error === 'string' ? state.error : undefined;
  return {
    sourceId: `opencode:${info.id}:tool:${part.callID}`,
    role: 'tool',
    toolCallId: part.callID,
    tool: part.tool ?? 'tool',
    toolInput: state.input ?? {},
    ...(output !== undefined ? { toolOutput: output } : {}),
    createdAt: iso(info.time?.created),
  };
}

export function normalizeOpenCodeMessages(records: readonly OpenCodeMessageRecord[]): Message[] {
  const messages: Array<Omit<Message, 'seq'>> = [];
  for (const record of records) {
    const content = contentMessage(record);
    if (content) messages.push(content);
    for (const part of record.parts) {
      const tool = toolMessage(record.info, part);
      if (tool) messages.push(tool);
    }
  }
  return messages.slice(-MAX_HISTORY_MESSAGES).map((message, index) => ({ ...message, seq: index + 1 }));
}

function eventProperties(event: OpenCodeGlobalEvent): Record<string, unknown> {
  return event.payload.properties ?? {};
}

function permissionKind(type: unknown): ApprovalKind {
  const value = String(type ?? '').toLowerCase();
  if (/edit|write|patch/.test(value)) return 'fileChange';
  if (/bash|shell|command|exec/.test(value)) return 'command';
  return 'permission';
}

export class OpenCodeSession implements SessionHandle {
  readonly sessionId: string;
  private nativeSessionId = '';
  get resumeRef(): string | undefined { return this.nativeSessionId || undefined; }
  get cliSessionRef(): string | undefined { return this.resumeRef; }
  get model(): string | undefined { return this.modelValue; }

  private modelValue?: string;
  private emit: (event: AdapterEvent) => void = NOOP;
  private buffered: AdapterEvent[] = [];
  private unsubscribeRuntime: (() => void) | null = null;
  private tracker: ApprovalTracker;
  private pendingApprovals = new Set<string>();
  private infos = new Map<string, OpenCodeMessageInfo>();
  private parts = new Map<string, Map<string, OpenCodePart>>();
  private toolStates = new Map<string, { status?: string; output?: string }>();
  private turnRunning = false;
  private moyuPending = false;
  private disposed = false;
  private completing: Promise<void> | null = null;
  private latestAssistant?: OpenCodeMessageInfo;

  constructor(private runtime: OpenCodeServerRuntime, private opts: OpenCodeSessionOpts) {
    this.sessionId = opts.sessionId;
    this.modelValue = opts.model;
    this.tracker = new ApprovalTracker(opts.approvalTimeoutSec, (approvalId, decision, timedOut) => {
      this.pendingApprovals.delete(approvalId);
      if (timedOut && this.nativeSessionId) {
        void this.runtime.client()
          .then((client) => client.replyPermission(this.nativeSessionId, approvalId, 'reject', this.opts.cwd))
          .catch(() => {});
      }
      this.emitEvent({ type: 'approval.resolved', approvalId, decision });
    });
  }

  async init(): Promise<void> {
    const client = await this.runtime.client();
    parseOpenCodeModel(this.modelValue);
    if (this.opts.resumeRef) {
      if (this.opts.resumeRef.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(this.opts.resumeRef)) {
        throw new Error('invalid OpenCode resume reference');
      }
      const session = await client.getSession(this.opts.resumeRef, this.opts.cwd);
      if (!session?.id || session.id !== this.opts.resumeRef) throw new Error('OpenCode session not found');
      this.nativeSessionId = session.id;
      if (session.directory) this.opts.cwd = session.directory;
    } else {
      const session = await client.createSession(this.opts.cwd, this.opts.title);
      if (!session?.id) throw new Error('OpenCode create session returned no id');
      this.nativeSessionId = session.id;
      if (session.directory) this.opts.cwd = session.directory;
    }
    this.runtime.rememberSession(this.nativeSessionId, this.opts.cwd);
    this.unsubscribeRuntime = this.runtime.subscribe(this.nativeSessionId, {
      directory: this.opts.cwd,
      onEvent: (event) => this.onOpenCodeEvent(event),
      onReconnect: () => {
        void this.reconcile().catch((error) => this.failTurnIfRunning(error));
      },
    });
    await this.reconcile();
  }

  private emitEvent(event: AdapterEvent): void {
    if (this.disposed) return;
    if (this.emit === NOOP) {
      if (this.buffered.length < 256) this.buffered.push(event);
      return;
    }
    this.emit(event);
  }

  private cachePart(part: OpenCodePart): void {
    let parts = this.parts.get(part.messageID);
    if (!parts) this.parts.set(part.messageID, parts = new Map());
    parts.set(part.id, part);
  }

  private emitCachedMessage(messageId: string): void {
    const info = this.infos.get(messageId);
    if (!info) return;
    const record: OpenCodeMessageRecord = { info, parts: [...(this.parts.get(messageId)?.values() ?? [])] };
    const content = contentMessage(record);
    if (content) this.emitEvent({ type: 'message.upsert', message: content });
    for (const part of record.parts) {
      const tool = toolMessage(info, part);
      if (tool) this.emitEvent({ type: 'message.upsert', message: tool });
    }
  }

  private ensureTurnStarted(): void {
    if (this.turnRunning) return;
    this.turnRunning = true;
    this.emitEvent({ type: 'turn.started' });
  }

  private onOpenCodeEvent(event: OpenCodeGlobalEvent): void {
    const type = event.payload.type;
    const properties = eventProperties(event);
    if (type === 'message.updated') {
      const info = properties.info as unknown as OpenCodeMessageInfo | undefined;
      if (!info?.id || info.sessionID !== this.nativeSessionId) return;
      this.infos.set(info.id, info);
      if (info.role === 'assistant') {
        this.latestAssistant = info;
        this.ensureTurnStarted();
      }
      this.emitCachedMessage(info.id);
      if (info.error) {
        this.failTurn(info.error);
      }
      return;
    }
    if (type === 'message.part.updated') {
      const part = properties.part as unknown as OpenCodePart | undefined;
      if (!part?.id || part.sessionID !== this.nativeSessionId) return;
      this.cachePart(part);
      const info = this.infos.get(part.messageID);
      if (info?.role === 'assistant') {
        this.ensureTurnStarted();
        const delta = typeof properties.delta === 'string' ? properties.delta : undefined;
        if (delta && part.type === 'text') this.emitEvent({ type: 'text.delta', text: delta });
        if (delta && part.type === 'reasoning') this.emitEvent({ type: 'thinking.delta', text: delta });
      }
      if (part.type === 'tool' && part.callID) this.emitToolPart(part);
      this.emitCachedMessage(part.messageID);
      return;
    }
    if (type === 'permission.updated') {
      if (properties.sessionID !== this.nativeSessionId || typeof properties.id !== 'string') return;
      const approvalId = properties.id;
      if (this.tracker.has(approvalId)) return;
      this.pendingApprovals.add(approvalId);
      this.tracker.register(approvalId, () => {});
      this.emitEvent({
        type: 'approval.request',
        approvalId,
        kind: permissionKind(properties.type),
        tool: typeof properties.type === 'string' ? properties.type : undefined,
        input: properties.metadata ?? properties.pattern,
        summary: typeof properties.title === 'string' ? properties.title : `OpenCode permission: ${String(properties.type ?? 'request')}`,
        choices: ['allow', 'allow_session', 'deny', 'cancel'],
      });
      return;
    }
    if (type === 'permission.replied') {
      if (properties.sessionID !== this.nativeSessionId || typeof properties.permissionID !== 'string') return;
      const decision = properties.response === 'always' ? 'allow_session'
        : properties.response === 'once' ? 'allow' : 'deny';
      this.tracker.resolve(properties.permissionID, decision);
      return;
    }
    if (type === 'session.status') {
      if (properties.sessionID !== this.nativeSessionId) return;
      const status = properties.status as Record<string, unknown> | undefined;
      if (status?.type === 'busy') this.ensureTurnStarted();
      if (status?.type === 'idle') this.scheduleCompleteTurn();
      return;
    }
    if (type === 'session.idle') {
      if (properties.sessionID === this.nativeSessionId) this.scheduleCompleteTurn();
      return;
    }
    if (type === 'session.error') {
      if (properties.sessionID !== this.nativeSessionId) return;
      this.failTurn(properties.error);
    }
  }

  private emitToolPart(part: OpenCodePart): void {
    const callId = part.callID!;
    const status = part.state?.status;
    const output = typeof part.state?.output === 'string' ? part.state.output
      : typeof part.state?.error === 'string' ? part.state.error : undefined;
    const previous = this.toolStates.get(callId);
    if (!previous && (status === 'pending' || status === 'running' || status === 'completed' || status === 'error')) {
      this.emitEvent({ type: 'tool.start', toolCallId: callId, tool: part.tool ?? 'tool', input: part.state?.input ?? {} });
    }
    if (output !== undefined && output !== previous?.output) {
      this.emitEvent({ type: 'tool.output', toolCallId: callId, text: output });
    }
    if ((status === 'completed' || status === 'error') && status !== previous?.status) {
      this.emitEvent({ type: 'tool.done', toolCallId: callId, isError: status === 'error' });
    }
    this.toolStates.set(callId, { status, output });
  }

  private async completeTurn(): Promise<void> {
    if (this.completing) return this.completing;
    this.completing = (async () => {
      try {
        await this.reconcile();
      } catch (error) {
        this.failTurn(error);
        return;
      }
      if (!this.turnRunning && !this.moyuPending) return;
      const assistant = this.latestAssistant;
      const usage: Usage | undefined = assistant?.tokens ? {
        inputTokens: assistant.tokens.input,
        outputTokens: assistant.tokens.output,
        cacheReadTokens: assistant.tokens.cache?.read,
        cacheWriteTokens: assistant.tokens.cache?.write,
      } : undefined;
      const model = assistant?.providerID && assistant.modelID
        ? `${assistant.providerID}/${assistant.modelID}` : this.modelValue;
      this.emitEvent({ type: 'turn.completed', usage, costUsd: assistant?.cost, model });
      this.turnRunning = false;
      this.moyuPending = false;
    })().finally(() => { this.completing = null; });
    return this.completing;
  }

  private scheduleCompleteTurn(): void {
    void this.completeTurn().catch((error) => this.failTurn(error));
  }

  private failTurnIfRunning(error: unknown): void {
    if (this.turnRunning || this.moyuPending) this.failTurn(error);
    else log.warn('OpenCode history reconciliation failed', { summary: safeStderrSummary(upstreamErrorText(error)) });
  }

  private failTurn(error: unknown): void {
    if (!this.turnRunning && !this.moyuPending) return;
    this.emitEvent({ type: 'turn.failed', ...clientSafeError(error) });
    this.turnRunning = false;
    this.moyuPending = false;
  }

  async reconcile(): Promise<void> {
    if (!this.nativeSessionId || this.disposed) return;
    const client = await this.runtime.client();
    const records = await client.listMessages(this.nativeSessionId, this.opts.cwd);
    for (const record of records) {
      this.infos.set(record.info.id, record.info);
      const parts = new Map<string, OpenCodePart>();
      for (const part of record.parts) parts.set(part.id, part);
      this.parts.set(record.info.id, parts);
      if (record.info.role === 'assistant') this.latestAssistant = record.info;
    }
    for (const message of normalizeOpenCodeMessages(records)) {
      const { seq: _seq, ...value } = message;
      this.emitEvent({ type: 'message.upsert', message: value });
    }
  }

  async send(input: UserInput): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.moyuPending) throw new Error('OpenCode session already has a Moyu turn in flight');
    if (input.attachments?.length) throw new Error('OpenCode image input is not enabled in v0.0.4');
    const client = await this.runtime.client();
    const model = parseOpenCodeModel(this.modelValue);
    this.moyuPending = true;
    try {
      await client.promptAsync(this.nativeSessionId, this.opts.cwd, input, model);
    } catch (error) {
      this.moyuPending = false;
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const client = await this.runtime.client();
    await client.abort(this.nativeSessionId, this.opts.cwd);
    if (this.moyuPending || this.turnRunning) {
      this.emitEvent({ type: 'turn.failed', category: 'unknown', summary: 'OpenCode turn interrupted' });
    }
    this.moyuPending = false;
    this.turnRunning = false;
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.tracker.has(approvalId)) throw new Error('approval is not pending');
    const client = await this.runtime.client();
    await client.replyPermission(this.nativeSessionId, approvalId, toOpencode(decision), this.opts.cwd);
    this.tracker.resolve(approvalId, decision);
  }

  async history(afterSeq = 0): Promise<Message[]> {
    const client = await this.runtime.client();
    return normalizeOpenCodeMessages(await client.listMessages(this.nativeSessionId, this.opts.cwd))
      .filter((message) => message.seq > afterSeq);
  }

  onEvent(cb: (event: AdapterEvent) => void): () => void {
    this.emit = cb;
    const buffered = this.buffered;
    this.buffered = [];
    for (const event of buffered) cb(event);
    return () => { if (this.emit === cb) this.emit = NOOP; };
  }

  async setModel(model?: string): Promise<void> {
    if (this.moyuPending || this.turnRunning) throw new Error('cannot change model while a turn is running');
    parseOpenCodeModel(model);
    this.modelValue = model?.trim() || undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    // Cleanup must never start/re-attach a server merely to reject stale approvals.
    const client = this.nativeSessionId && this.pendingApprovals.size
      ? this.runtime.readyClient() : null;
    if (client) {
      await Promise.allSettled([...this.pendingApprovals].map((id) =>
        client.replyPermission(this.nativeSessionId, id, 'reject', this.opts.cwd)));
    }
    this.disposed = true;
    this.tracker.clear();
    this.buffered = [];
    this.emit = NOOP;
  }
}
