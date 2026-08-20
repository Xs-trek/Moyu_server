// SessionManager: session lifecycle, incremental history (by seq, I2), and event
// fan-out to WS subscribers (I10). Each session binds one adapter SessionHandle.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  AdapterEvent,
  AdapterKind,
  ApprovalDecision,
  Message,
  SessionHandle,
  TransportMetrics,
  UserInput,
  ReasoningEffort,
  PermissionMode,
  ArtifactRef,
} from '../adapters/types';
import type { AdapterManager } from '../adapters/manager';
import { log } from '../util/logger';
import type { ArtifactStore } from '../artifacts/store';

export interface WsEventEnvelope {
  type: 'event';
  seq: number;
  sessionId: string;
  event: AdapterEvent;
}
export type Subscriber = (e: WsEventEnvelope) => void;

// Memory bounds (review P2: messages[] + toolOutput grew unbounded per session). A single
// long-running session could otherwise accumulate megabytes of tool output in memory. Drop the
// oldest messages beyond the cap (incremental history is seq-based, so old drops are safe) and
// truncate any single tool output beyond its byte cap. Disk-spill hot-window is a future option.
const MAX_MESSAGES_PER_SESSION = 1000;
const MAX_TOOL_OUTPUT_CHARS = 256 * 1024;
const MAX_TEXT_CHARS = 256 * 1024; // user/assistant text cap (review P2: msg count alone didn't bound text size)
// §6: per-session bounded event ring buffer for reconnect replay. Holds full WsEventEnvelope.
// On overflow the oldest is dropped (pending approvals + last terminal turn are retained
// separately, so the critical events approval.request / turn.failed / turn.completed are never
// lost to ring overflow). 256 comfortably covers multiple turns between a disconnect and replay.
const MAX_EVENT_RING = 256;
const MAX_EVENT_RING_CHARS = 2 * 1024 * 1024;
const MAX_EVENT_FIELD_CHARS = 256 * 1024;
const MAX_MESSAGE_STORE_CHARS = 8 * 1024 * 1024;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_SYNC_PAGE = 256;

interface SessionRecord {
  sessionId: string;
  kind: AdapterKind;
  handle: SessionHandle;
  messages: Message[];
  seq: number;
  createdAt: string;
  title?: string;
  unsub: () => void;
  subscribers: Set<Subscriber>;
  /** §6: bounded ring of recent event envelopes (replay source for reconnect afterSeq). */
  eventRing: WsEventEnvelope[];
  eventRingChars: number;
  /** §6: pending (unresolved) approval requests keyed by approvalId. Retained independent of
   *  the ring so a reconnecting client never loses an approval it still must act on; cleared on
   *  approval.resolved. */
  pendingApprovals: Map<string, WsEventEnvelope>;
  /** §6: most recent terminal turn event (turn.failed/turn.completed). Retained so a client
   *  that disconnected mid-turn always learns the turn ended (never lost to ring overflow). */
  lastTerminalTurn: WsEventEnvelope | null;
  /** §9 I6: normalized absolute cwd the session operates in (source for the diff endpoint). */
  cwd: string;
  profileId?: string;
  model?: string;
  requestedModel?: string;
  runtimeModel?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  updatedAt: string;
  turnState: 'idle' | 'running' | 'completed' | 'failed';
  /** Local wall-clock observation from accepted user input through terminal completion. It is
   * never exposed except as the bounded elapsed duration added to turn.completed. */
  turnStartedAtMs?: number;
  transport: TransportMetrics;
  pendingInputAt: Array<{ acceptedAt: number }>;
  eventDroppedThroughSeq: number;
  messageDroppedThroughSeq: number;
}

export interface SessionSummary {
  sessionId: string;
  kind: AdapterKind;
  createdAt: string;
  title?: string;
  messageCount: number;
  latestSeq: number;
  updatedAt: string;
  cwd: string;
  cliSessionRef?: string;
  profileId?: string;
  model?: string;
  requestedModel?: string;
  runtimeModel?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  turnState: 'idle' | 'running' | 'completed' | 'failed';
  transport: TransportMetrics;
}

export interface CreateSessionOpts {
  cwd?: string;
  cliSessionRef?: string;
  title?: string;
  extraDirs?: string[];
  /** v3: resolved env from the active account profile (claude injects; codex ignores). */
  profileEnv?: Record<string, string>;
  profileId?: string;
  model?: string;
  /** Effective native model for display only. Unlike `model`, this value is never forwarded to
   * the adapter as a CLI override. Runtime turn metadata may replace it later. */
  displayModel?: string;
  effort?: ReasoningEffort;
  permissionMode?: PermissionMode;
  /** Read-only native history normalized before resuming an existing CLI session. */
  seedMessages?: Message[];
}

export interface SessionSyncSnapshot {
  session: SessionSummary;
  requestedAfterSeq: number;
  requestedMessageAfterSeq: number;
  latestSeq: number;
  oldestAvailableEventSeq: number | null;
  eventGap: boolean;
  events: WsEventEnvelope[];
  hasMoreEvents: boolean;
  nextAfterSeq: number;
  messages: Message[];
  hasMoreMessages: boolean;
  nextMessageAfterSeq: number;
  messagesTruncatedBeforeSeq: number;
  generatedAt: string;
}

/**
 * Choose the native CLI working directory without inheriting the daemon launch directory.
 *
 * The gateway may have been started from its install/source tree. Passing an undefined `cwd`
 * to child_process.spawn would expose that product-owned path to the native CLI, its tools and
 * potentially the transcript. A normal headless invocation still needs a deterministic working
 * directory, so an omitted/empty client value uses the user's home directory. Explicit user
 * choices (including native-history resume cwd) remain unchanged apart from normalization.
 */
export function resolveSessionWorkingDirectory(cwd?: string): string {
  return resolve(cwd === undefined || cwd === '' ? homedir() : cwd);
}

function serializedChars(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_EVENT_FIELD_CHARS;
  }
}

function capEventText(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= MAX_EVENT_FIELD_CHARS) return text;
  return text.slice(0, MAX_EVENT_FIELD_CHARS) + '…[truncated]';
}

function boundUnknown(value: unknown): unknown {
  if (serializedChars(value) <= MAX_EVENT_FIELD_CHARS) return value;
  let preview = '';
  try {
    preview = JSON.stringify(value).slice(0, MAX_EVENT_FIELD_CHARS);
  } catch {
    preview = '[unserializable]';
  }
  return { truncated: true, preview };
}

/** Keep the replay ring useful without allowing one CLI event to dominate process memory. */
function boundAdapterEvent(event: AdapterEvent): AdapterEvent {
  switch (event.type) {
    case 'thinking.delta':
    case 'text.delta':
    case 'text.done':
      return { ...event, text: capEventText(event.text)! };
    case 'tool.start':
      return { ...event, input: boundUnknown(event.input) };
    case 'tool.output':
      return { ...event, text: capEventText(event.text), base64: capEventText(event.base64) };
    case 'approval.request':
      return { ...event, summary: capEventText(event.summary)!, input: boundUnknown(event.input) };
    case 'turn.failed':
      return { ...event, summary: capEventText(event.summary)! };
    default:
      return event;
  }
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();

  constructor(
    private adapters: AdapterManager,
    private artifacts?: ArtifactStore,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async create(kind: AdapterKind, opts: CreateSessionOpts = {}): Promise<string> {
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) throw new Error('active session limit reached');
    const effortLevels = this.adapters.get(kind)?.capabilities.configuration.effortLevels ?? [];
    if (opts.effort && !effortLevels.includes(opts.effort)) throw new Error(`unsupported effort for ${kind}`);
    const permissionModes = this.adapters.get(kind)?.capabilities.configuration.permissionModes ?? [];
    if (opts.permissionMode && !permissionModes.includes(opts.permissionMode)) throw new Error(`unsupported permission mode for ${kind}`);
    const sessionId = randomUUID();
    const cwd = resolveSessionWorkingDirectory(opts.cwd);
    const handle = await this.adapters.startSession(kind, {
      sessionId,
      cliSessionRef: opts.cliSessionRef ?? sessionId,
      cwd,
      extraDirs: opts.extraDirs,
      profileEnv: opts.profileEnv,
      model: opts.model,
      effort: opts.effort,
      permissionMode: opts.permissionMode,
    });
    const seededMessages = (opts.seedMessages ?? []).map((message, index) => ({
      ...message,
      seq: index + 1,
      createdAt: message.createdAt || new Date().toISOString(),
    }));
    const record: SessionRecord = {
      sessionId,
      kind,
      handle,
      messages: seededMessages,
      seq: seededMessages.at(-1)?.seq ?? 0,
      createdAt: new Date().toISOString(),
      title: opts.title,
      subscribers: new Set(),
      unsub: () => {},
      eventRing: [],
      eventRingChars: 0,
      pendingApprovals: new Map(),
      lastTerminalTurn: null,
      cwd,
      profileId: opts.profileId,
      model: opts.displayModel ?? handle.model ?? opts.model,
      requestedModel: handle.model ?? opts.model,
      effort: handle.effort ?? opts.effort,
      permissionMode: handle.permissionMode ?? opts.permissionMode,
      updatedAt: new Date().toISOString(),
      turnState: 'idle',
      transport: { observedAt: new Date().toISOString() },
      pendingInputAt: [],
      eventDroppedThroughSeq: 0,
      messageDroppedThroughSeq: 0,
    };
    this.enforceMessageBounds(record);
    record.unsub = handle.onEvent((ev) => this.onAdapterEvent(record, ev));
    this.sessions.set(sessionId, record);
    log.info('session created', { sessionId, kind });
    return sessionId;
  }

  private onAdapterEvent(r: SessionRecord, ev: AdapterEvent): void {
    if (ev.type === 'tool.output' && ev.base64) {
      try {
        if (!this.artifacts || !ev.mime) throw new Error('artifact store or mime unavailable');
        const stored = this.artifacts.putBase64(ev.base64, ev.mime, ev.name);
        ev = { type: 'tool.output', toolCallId: ev.toolCallId, text: ev.text, artifact: stored.ref };
      } catch (error) {
        log.warn('tool image omitted', { sessionId: r.sessionId, err: String(error) });
        ev = {
          type: 'tool.output',
          toolCallId: ev.toolCallId,
          text: (ev.text ?? '') + (ev.text ? '\n' : '') + '[image output unavailable]',
        };
      }
    }
    ev = boundAdapterEvent(ev);
    const now = this.nowMs();
    r.updatedAt = new Date(now).toISOString();
    if (ev.type === 'turn.started') {
      r.turnState = 'running';
      const pending = r.pendingInputAt.shift();
      // The accepted timestamp also covers adapter queueing and pre-spawn safety checks. This
      // makes the reported duration match what the remote user actually waited for.
      r.turnStartedAtMs = pending?.acceptedAt ?? now;
      this.publish(r, ev);
      if (pending) {
        this.publish(r, {
          type: 'transport.metrics',
          metrics: { backendCliQueueMs: Math.max(0, now - pending.acceptedAt), observedAt: r.updatedAt },
        });
      }
      return;
    } else if (ev.type === 'turn.completed') {
      r.turnState = 'completed';
      if (ev.model?.trim()) {
        r.runtimeModel = ev.model.trim();
        if (!r.requestedModel) r.model = r.runtimeModel;
      }
      // Compatibility adapters may only expose a terminal event. Fall back to the accepted
      // input timestamp rather than dropping timing or leaving the queue misaligned.
      const observedStart = r.turnStartedAtMs ?? r.pendingInputAt.shift()?.acceptedAt;
      if (observedStart !== undefined) {
        ev = {
          ...ev,
          performance: { observedDurationMs: Math.max(0, Math.round(now - observedStart)) },
        };
      }
      r.turnStartedAtMs = undefined;
    } else if (ev.type === 'turn.failed') {
      r.turnState = 'failed';
      // A pre-start guard/spawn failure still consumes exactly one accepted input. Removing it
      // here prevents the next healthy turn from inheriting the failed turn's start time.
      if (r.turnStartedAtMs === undefined) r.pendingInputAt.shift();
      r.turnStartedAtMs = undefined;
    }
    r.permissionMode = r.handle.permissionMode ?? r.permissionMode;
    this.publish(r, ev);
  }

  private publish(r: SessionRecord, ev: AdapterEvent): void {
    if (ev.type === 'transport.metrics') r.transport = { ...r.transport, ...ev.metrics };
    r.seq += 1;
    this.persist(r, ev);
    const env: WsEventEnvelope = { type: 'event', seq: r.seq, sessionId: r.sessionId, event: ev };
    // §6: retain for reconnect replay. Ring first; then critical-event retention so the
    // bounded ring can never lose an approval the client still owes a decision on, nor the
    // fact that a turn ended.
    this.pushRing(r, env);
    if (ev.type === 'approval.request') {
      r.pendingApprovals.set(ev.approvalId, env);
    } else if (ev.type === 'approval.resolved') {
      r.pendingApprovals.delete(ev.approvalId);
    } else if (ev.type === 'turn.failed' || ev.type === 'turn.completed') {
      r.lastTerminalTurn = env;
    }
    for (const sub of r.subscribers) {
      try {
        sub(env);
      } catch (e) {
        log.warn('subscriber threw', { err: String(e) });
      }
    }
  }

  /** §6: push an envelope onto the bounded per-session ring, dropping the oldest on overflow. */
  private pushRing(r: SessionRecord, env: WsEventEnvelope): void {
    r.eventRing.push(env);
    r.eventRingChars += serializedChars(env);
    while (r.eventRing.length > MAX_EVENT_RING || r.eventRingChars > MAX_EVENT_RING_CHARS) {
      const dropped = r.eventRing.shift();
      // Pending approvals + last terminal turn are retained separately, so this drop never
      // loses a critical event. Log the seq (no event content) for diagnostics.
      if (dropped) log.debug('event ring overflow, dropped oldest', { sessionId: r.sessionId, seq: dropped.seq });
      if (dropped) {
        r.eventRingChars = Math.max(0, r.eventRingChars - serializedChars(dropped));
        r.eventDroppedThroughSeq = Math.max(r.eventDroppedThroughSeq, dropped.seq);
      }
    }
  }

  private msg(r: SessionRecord, partial: Omit<Message, 'seq' | 'createdAt'>): Message[] {
    let text = partial.text;
    if (text !== undefined && text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + '…[truncated]';
    }
    r.messages.push({ ...partial, text, seq: r.seq, createdAt: new Date().toISOString() });
    return this.enforceMessageBounds(r);
  }

  private enforceMessageBounds(r: SessionRecord): Message[] {
    let chars = r.messages.reduce((sum, message) => sum + serializedChars(message), 0);
    const dropped: Message[] = [];
    while (r.messages.length > MAX_MESSAGES_PER_SESSION || chars > MAX_MESSAGE_STORE_CHARS) {
      const message = r.messages.shift();
      if (!message) break;
      dropped.push(message);
      chars = Math.max(0, chars - serializedChars(message));
      r.messageDroppedThroughSeq = Math.max(r.messageDroppedThroughSeq, message.seq);
    }
    return dropped;
  }

  private persist(r: SessionRecord, ev: AdapterEvent): void {
    switch (ev.type) {
      case 'text.done':
        this.msg(r, { role: 'assistant', text: ev.text });
        if (!r.title) r.title = ev.text.slice(0, 60);
        break;
      case 'tool.start':
        this.msg(r, { role: 'tool', toolCallId: ev.toolCallId, tool: ev.tool, toolInput: ev.input });
        break;
      case 'tool.output': {
        const last = [...r.messages].reverse().find((m) => m.toolCallId === ev.toolCallId);
        const chunk = ev.text ?? '';
        if (last) {
          const next = (last.toolOutput ?? '') + chunk;
          last.toolOutput =
            next.length > MAX_TOOL_OUTPUT_CHARS ? next.slice(0, MAX_TOOL_OUTPUT_CHARS) + '…[truncated]' : next;
          // Bump the existing tool message to the current seq so a client that recorded the
          // tool.start seq and later calls /messages?after=<seq> sees the updated output.
          // Without this the mutation keeps the old seq and the streamed output is invisible
          // to incremental history backfill after a reconnect.
          last.seq = r.seq;
          if (ev.artifact) {
            const artifacts: ArtifactRef[] = last.artifacts ?? [];
            if (!artifacts.some((artifact) => artifact.artifactId === ev.artifact!.artifactId)) artifacts.push(ev.artifact);
            last.artifacts = artifacts;
          }
          this.enforceMessageBounds(r);
        } else {
          const truncated =
            chunk.length > MAX_TOOL_OUTPUT_CHARS ? chunk.slice(0, MAX_TOOL_OUTPUT_CHARS) + '…[truncated]' : chunk;
          this.msg(r, { role: 'tool', toolCallId: ev.toolCallId, toolOutput: truncated, artifacts: ev.artifact ? [ev.artifact] : undefined });
        }
        break;
      }
      default:
        break;
    }
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((r) => ({
      sessionId: r.sessionId,
      kind: r.kind,
      createdAt: r.createdAt,
      title: r.title,
      messageCount: r.messages.length,
      latestSeq: r.seq,
      updatedAt: r.updatedAt,
      cwd: r.cwd,
      cliSessionRef: r.handle.cliSessionRef,
      profileId: r.profileId,
      model: r.model,
      requestedModel: r.requestedModel,
      runtimeModel: r.runtimeModel,
      effort: r.effort,
      permissionMode: r.permissionMode,
      turnState: r.turnState,
      transport: { ...r.transport },
    })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** Single-session summary (mirrors `claude --resume <id>` "view a session" without the
   *  full message list). The frontend fetches messages separately via /messages?after=N. */
  summary(sessionId: string): SessionSummary | null {
    const r = this.sessions.get(sessionId);
    if (!r) return null;
    return this.list().find((session) => session.sessionId === sessionId) ?? null;
  }

  /** Change only the native CLI effort argument used by subsequent turns. This is deliberately
   * session-scoped: it never edits Claude/Codex config files and never becomes model input. */
  async setEffort(sessionId: string, effort?: ReasoningEffort): Promise<SessionSummary> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    if (r.turnState === 'running') throw new Error('cannot change effort while a turn is running');
    const supported = this.adapters.get(r.kind)?.capabilities.configuration.effortLevels ?? [];
    if (effort && !supported.includes(effort)) throw new Error(`unsupported effort for ${r.kind}`);
    if (!r.handle.setEffort) throw new Error(`effort is not configurable for ${r.kind}`);
    await r.handle.setEffort(effort);
    r.effort = effort;
    r.updatedAt = new Date().toISOString();
    return this.summary(sessionId)!;
  }

  async setModel(sessionId: string, model?: string): Promise<SessionSummary> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    if (r.turnState === 'running') throw new Error('cannot change model while a turn is running');
    if (!r.handle.setModel) throw new Error(`model is not configurable for ${r.kind}`);
    const normalized = model?.trim();
    if (normalized && normalized.length > 128) throw new Error('invalid model');
    await r.handle.setModel(normalized || undefined);
    r.requestedModel = normalized || undefined;
    r.model = r.requestedModel ?? r.runtimeModel;
    r.updatedAt = new Date().toISOString();
    return this.summary(sessionId)!;
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    if (r.turnState === 'running') throw new Error('cannot change permission mode while a turn is running');
    const supported = this.adapters.get(r.kind)?.capabilities.configuration.permissionModes ?? [];
    if (!supported.includes(mode) || !r.handle.setPermissionMode) throw new Error(`unsupported permission mode for ${r.kind}`);
    await r.handle.setPermissionMode(mode);
    r.permissionMode = mode;
    r.updatedAt = new Date().toISOString();
    return this.summary(sessionId)!;
  }

  listSnapshot(cursor: string | undefined, limit = 50): { items: SessionSummary[]; nextCursor: string | null; generatedAt: string } {
    const all = this.list();
    const start = cursor ? Math.max(0, all.findIndex((item) => item.sessionId === cursor) + 1) : 0;
    const size = Math.min(Math.max(1, limit), 100);
    const items = all.slice(start, start + size);
    const nextCursor = start + size < all.length ? items.at(-1)?.sessionId ?? null : null;
    return { items, nextCursor, generatedAt: new Date().toISOString() };
  }

  sync(sessionId: string, afterSeq = 0, limit = MAX_SYNC_PAGE, messageAfterSeq?: number): SessionSyncSnapshot {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    const size = Math.min(Math.max(1, limit), MAX_SYNC_PAGE);
    const retained = this.replayEvents(r, afterSeq);
    const eventGap = afterSeq < r.eventDroppedThroughSeq;
    const events = retained.slice(0, size);
    const hasMoreEvents = retained.length > events.length;
    const nextAfterSeq = hasMoreEvents ? (events.at(-1)?.seq ?? afterSeq) : r.seq;
    const messageAfter = messageAfterSeq ?? (eventGap ? 0 : afterSeq);
    const matchingMessages = r.messages
      .filter((message) => message.seq > messageAfter)
      .sort((a, b) => a.seq - b.seq);
    const messages = matchingMessages.slice(0, size);
    const hasMoreMessages = matchingMessages.length > messages.length;
    return {
      session: this.summary(sessionId)!,
      requestedAfterSeq: afterSeq,
      requestedMessageAfterSeq: messageAfter,
      latestSeq: r.seq,
      oldestAvailableEventSeq: r.eventRing[0]?.seq ?? null,
      eventGap,
      events,
      hasMoreEvents,
      nextAfterSeq,
      messages,
      hasMoreMessages,
      nextMessageAfterSeq: messages.at(-1)?.seq ?? messageAfter,
      messagesTruncatedBeforeSeq: r.messageDroppedThroughSeq,
      generatedAt: new Date().toISOString(),
    };
  }

  history(sessionId: string, afterSeq = 0): Message[] {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    // Sort by seq: tool.output mutates an existing tool message and bumps its seq forward
    // (see persist), so push order is not always seq order. Incremental backfill clients
    // depend on seq-ordered results.
    return r.messages.filter((m) => m.seq > afterSeq).sort((a, b) => a.seq - b.seq);
  }

  /** §9 I6: normalized absolute cwd for a session, for the diff endpoint. Null if the session
   *  doesn't exist (caller returns 404, never 500). Does not expose the internal record. */
  getCwd(sessionId: string): string | null {
    const r = this.sessions.get(sessionId);
    return r ? r.cwd : null;
  }

  /**
   * §6: subscribe to live events for a session, replaying unacked events first. `afterSeq` is
   * the client's last acked seq (sent on reconnect); the returned `replay` contains every
   * envelope with seq > afterSeq from the ring, PLUS any still-pending approvals and the last
   * terminal turn event (retained outside the ring so they're never lost to overflow). The
   * subscriber is registered before returning so no live event between snapshot and
   * registration is missed (subscribe + send are synchronous; live events arrive on later ticks).
   */
  subscribe(sessionId: string, sub: Subscriber, afterSeq = 0): { replay: WsEventEnvelope[]; unsub: () => void } {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    const replay = this.replayEvents(r, afterSeq);
    r.subscribers.add(sub);
    return { replay, unsub: () => r.subscribers.delete(sub) };
  }

  replayStatus(sessionId: string, afterSeq = 0): { gap: boolean; latestSeq: number; oldestAvailableSeq: number | null } {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    return {
      gap: afterSeq < r.eventDroppedThroughSeq,
      latestSeq: r.seq,
      oldestAvailableSeq: r.eventRing[0]?.seq ?? null,
    };
  }

  private replayEvents(r: SessionRecord, afterSeq: number): WsEventEnvelope[] {
    const replay: WsEventEnvelope[] = [];
    const seen = new Set<number>();
    for (const env of r.eventRing) {
      if (env.seq > afterSeq && !seen.has(env.seq)) {
        replay.push(env);
        seen.add(env.seq);
      }
    }
    // Pending approvals: retained independent of the ring, replayed if unacked.
    for (const env of r.pendingApprovals.values()) {
      if (env.seq > afterSeq && !seen.has(env.seq)) {
        replay.push(env);
        seen.add(env.seq);
      }
    }
    // Last terminal turn: retained independent of the ring, replayed if unacked.
    if (r.lastTerminalTurn && r.lastTerminalTurn.seq > afterSeq && !seen.has(r.lastTerminalTurn.seq)) {
      replay.push(r.lastTerminalTurn);
      seen.add(r.lastTerminalTurn.seq);
    }
    replay.sort((a, b) => a.seq - b.seq);
    return replay;
  }

  async send(sessionId: string, input: UserInput): Promise<number> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    const pending = { acceptedAt: this.nowMs() };
    const previousDroppedThroughSeq = r.messageDroppedThroughSeq;
    r.pendingInputAt.push(pending);
    r.seq += 1;
    const inputSeq = r.seq;
    const dropped = this.msg(r, {
      role: 'user',
      text: input.text,
      artifacts: input.attachments?.map(({ path: _path, ...artifact }) => artifact),
    });
    try {
      await r.handle.send(input);
      r.updatedAt = new Date().toISOString();
      return inputSeq;
    } catch (error) {
      const pendingIndex = r.pendingInputAt.indexOf(pending);
      if (pendingIndex >= 0) r.pendingInputAt.splice(pendingIndex, 1);
      // Adapter rejection means the input was not accepted (disposed/full queue). Remove the
      // optimistic history entry; sequence gaps are valid and preserve monotonicity.
      const index = r.messages.findIndex((message) => message.seq === inputSeq && message.role === 'user');
      if (index >= 0) r.messages.splice(index, 1);
      if (dropped.length > 0) r.messages.unshift(...dropped);
      r.messageDroppedThroughSeq = previousDroppedThroughSeq;
      throw error;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    await r.handle.interrupt();
  }

  async resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const r = this.sessions.get(sessionId);
    if (!r) throw new Error('session not found');
    if (!r.pendingApprovals.has(approvalId)) throw new Error('approval is not pending');
    await r.handle.resolveApproval(approvalId, decision);
  }

  async dispose(sessionId: string): Promise<void> {
    const r = this.sessions.get(sessionId);
    if (!r) return;
    r.unsub();
    r.subscribers.clear();
    // §6: drop replay buffers so a re-created session id (uuid reuse is astronomically unlikely,
    // but still) never serves stale events from a prior record.
    r.eventRing = [];
    r.eventRingChars = 0;
    r.pendingApprovals.clear();
    r.lastTerminalTurn = null;
    try {
      await r.handle.dispose();
    } catch (e) {
      log.warn('session dispose error', { sessionId, err: String(e) });
    }
    this.sessions.delete(sessionId);
    log.info('session disposed', { sessionId });
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.dispose(id)));
  }
}
