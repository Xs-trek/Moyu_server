// Codex session: one version-bound codex exec --json subprocess per turn plus a
// localhost PreToolUse command hook. Provider traffic and credentials remain inside
// the user's Codex CLI; this backend only handles CLI JSONL and local approval events.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AdapterEvent,
  ApprovalDecision,
  ApprovalKind,
  Message,
  SessionHandle,
  UserInput,
  ReasoningEffort,
} from '../types';
import type { HookRegistry } from '../../api/hooks';
import type { CodexHookResponse } from '../../approval/bridge';
import { ApprovalTracker, toCodexHook } from '../../approval/bridge';
import { readLines, which } from '../../util/spawn';
import { log, registerEnvSecrets, categorizeError, safeStderrSummary, safeFailure } from '../../util/logger';
import { isWindows } from '../../util/platform';
import { terminateProcessTree } from '../../util/process';
import type { ApprovalPolicy, SandboxMode, ApprovalsReviewer } from '../../config/schema';
import {
  buildCodexExecInvocation,
  buildCodexSpawnEnv,
  decodeCodexLine,
  relayTimeoutSecFor,
  type NormalizedCodexItem,
} from './protocol';

export { buildCodexExecArgs, buildCodexSpawnEnv } from './protocol';

export interface CodexSessionOpts {
  sessionId: string;
  cliSessionRef: string;
  cwd?: string;
  extraDirs?: string[];
  port: number;
  hooks: HookRegistry;
  approvalTimeoutSec: number;
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
  profileEnv?: Record<string, string>;
  /** @internal test-only: override CLI binary. */
  spawnBin?: string;
  /** @internal test-only: replace the protocol argv for a JSONL mock. */
  spawnArgs?: string[];
}

function toolToKind(tool: string): ApprovalKind {
  const value = tool.toLowerCase();
  if (value === 'shell' || value === 'bash' || value === 'exec') return 'command';
  if (value.includes('edit') || value.includes('write') || value.includes('file') || value.includes('patch')) {
    return 'fileChange';
  }
  return 'permission';
}

function summarize(tool: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const value = input as Record<string, unknown>;
    if (typeof value.command === 'string') return '$ ' + value.command.slice(0, 200);
    if (typeof value.path === 'string') return tool + ' ' + value.path;
    if (typeof value.file_path === 'string') return tool + ' ' + value.file_path;
  }
  return tool;
}

const CHOICES = ['allow', 'allow_session', 'deny', 'cancel'] as const;
const STDERR_CAP = 64 * 1024;
const MAX_PENDING_INPUTS = 32;
const MAX_STREAM_TEXT_CHARS = 256 * 1024;

function capStreamText(text: string): string {
  return text.length <= MAX_STREAM_TEXT_CHARS
    ? text
    : text.slice(0, MAX_STREAM_TEXT_CHARS) + '…[truncated]';
}

export class CodexSession implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef: string;
  get model(): string | undefined { return this.opts.model; }
  get effort(): ReasoningEffort | undefined { return this.opts.effort; }
  private emit: (event: AdapterEvent) => void = () => {};
  private child: ChildProcess | null = null;
  private tracker: ApprovalTracker;
  private autoAllow = new Set<string>();
  private disposed = false;
  private busy = false;
  private queue: UserInput[] = [];
  private threadId: string | null = null;
  private hasThread = false;
  private turnCompleted = false;
  private interrupted = false;
  private itemTools = new Map<string, string>();
  private itemOutput = new Map<string, string>();
  private messageBuf = '';
  private thinkingBuf = '';
  private thinkingActive = false;
  private stderrBuf = '';
  private hookSecret: string;
  private hookConfigPath: string | null = null;
  private turnDispatchAt = 0;
  private firstVisibleEvent = false;

  constructor(private opts: CodexSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cliSessionRef = opts.cliSessionRef;
    this.hookSecret = randomBytes(32).toString('hex');
    this.tracker = new ApprovalTracker(opts.approvalTimeoutSec, (approvalId, decision) => {
      this.emit({ type: 'approval.resolved', approvalId, decision });
    });
  }

  private flushMessage(): void {
    if (!this.messageBuf) return;
    this.emit({ type: 'text.done', text: this.messageBuf });
    this.messageBuf = '';
  }

  private flushThinking(): void {
    if (!this.thinkingActive) return;
    this.emit({ type: 'thinking.done' });
    this.thinkingBuf = '';
    this.thinkingActive = false;
  }

  private appendStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > STDERR_CAP) this.stderrBuf = this.stderrBuf.slice(-STDERR_CAP);
  }

  async init(): Promise<void> {
    const bin = this.opts.spawnBin ?? which('codex');
    if (!bin) throw new Error('codex CLI not found');
    registerEnvSecrets(process.env);
    const dir = mkdtempSync(join(tmpdir(), 'moyu-codex-hook-'));
    this.hookConfigPath = join(dir, 'relay.json');
    writeFileSync(
      this.hookConfigPath,
      JSON.stringify({
        port: this.opts.port,
        timeoutMs: relayTimeoutSecFor(this.opts.approvalTimeoutSec) * 1000,
        secret: this.hookSecret,
        sessionId: this.sessionId,
      }),
      { mode: 0o600 },
    );
    this.opts.hooks.register(
      this.sessionId,
      this.sessionId,
      (payload) => this.handleHook(payload),
      this.hookSecret,
    );
  }

  /** Accept input without waiting for the CLI turn to finish. Events carry completion. */
  async send(input: UserInput): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy) {
      if (this.queue.length >= MAX_PENDING_INPUTS) throw new Error('session input queue full');
      this.queue.push(input);
      return;
    }
    void this.runTurn(input);
  }

  async setEffort(effort?: ReasoningEffort): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy || this.queue.length) throw new Error('cannot change effort while a turn is running');
    if (effort && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) {
      throw new Error('unsupported Codex effort');
    }
    this.opts.effort = effort;
  }

  private resetTurnState(): void {
    this.turnCompleted = false;
    this.interrupted = false;
    this.stderrBuf = '';
    this.itemTools.clear();
    this.itemOutput.clear();
    this.messageBuf = '';
    this.thinkingBuf = '';
    this.thinkingActive = false;
    this.firstVisibleEvent = false;
  }

  private drainNext(): void {
    this.busy = false;
    if (this.disposed || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (next) void this.runTurn(next);
  }

  private async runTurn(input: UserInput): Promise<void> {
    const dispatchStartedAt = Date.now();
    this.busy = true;
    this.resetTurnState();
    let child: ChildProcess | null = null;

    try {
      const bin = this.opts.spawnBin ?? which('codex');
      if (!bin) throw new Error('codex CLI not found');
      if (/\.(cmd|bat)$/i.test(bin)) {
        throw new Error('codex binary is a command shim; configure the native codex executable');
      }

      const externalThread = this.cliSessionRef !== this.sessionId ? this.cliSessionRef : null;
      const threadId = externalThread ?? (this.hasThread ? this.threadId : null);
      const invocation = buildCodexExecInvocation(
        {
          cwd: this.opts.cwd,
          extraDirs: this.opts.extraDirs,
          model: this.opts.model,
          effort: this.opts.effort,
          approvalPolicy: this.opts.approvalPolicy,
          sandbox: this.opts.sandbox,
          approvalsReviewer: this.opts.approvalsReviewer,
          approvalTimeoutSec: this.opts.approvalTimeoutSec,
          hookConfigPath: this.hookConfigPath!,
        },
        input,
        threadId,
      );
      const args = this.opts.spawnArgs ?? invocation.args;
      const env = buildCodexSpawnEnv(this.opts.profileEnv);
      registerEnvSecrets(env);

      this.emit({ type: 'turn.started' });
      log.debug('codex exec spawn', { threadId, hasThread: this.hasThread, cwd: this.opts.cwd });
      child = spawn(bin, args, {
        cwd: this.opts.cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: !isWindows,
      });
      this.child = child;
      child.stdin?.once('error', () => {});
      child.stdin?.end(input.text);
      this.turnDispatchAt = Date.now();
      this.emit({
        type: 'transport.metrics',
        metrics: { backendCliDispatchMs: this.turnDispatchAt - dispatchStartedAt, observedAt: new Date().toISOString() },
      });
      child.stderr?.on('data', (data: Buffer) => this.appendStderr(data.toString('utf8')));

      let spawnError: unknown;
      const exit = new Promise<number | null>((resolve) => {
        let settled = false;
        const finish = (code: number | null, error?: unknown): void => {
          if (settled) return;
          settled = true;
          spawnError = error;
          resolve(code);
        };
        child?.once('close', (code) => finish(code));
        child?.once('error', (error) => finish(null, error));
      });

      if (child.stdout) {
        for await (const line of readLines(child.stdout)) {
          if (this.disposed) break;
          const decoded = decodeCodexLine(line);
          if (
            !this.firstVisibleEvent &&
            decoded &&
            decoded.type !== 'thread.started' &&
            decoded.type !== 'turn.started'
          ) {
            this.firstVisibleEvent = true;
            this.emit({
              type: 'transport.metrics',
              metrics: { cliFirstEventMs: Date.now() - this.turnDispatchAt, observedAt: new Date().toISOString() },
            });
          }
          this.handleLine(line);
        }
      }
      const code = await exit;
      if (this.child === child) this.child = null;

      if (this.stderrBuf.trim()) {
        log.warn('codex exec stderr summary', {
          code,
          category: categorizeError(this.stderrBuf),
          summary: safeStderrSummary(this.stderrBuf),
        });
      } else {
        log.info('codex exec exited', { code });
      }
      if (!this.turnCompleted && !this.disposed) {
        const detail = spawnError ? ' (spawn failed)' : '';
        this.emit({
          type: 'turn.failed',
          ...safeFailure(this.interrupted ? 'interrupted' : 'codex exited without turn.completed' + detail),
        });
      }
      this.hasThread = this.threadId !== null;
    } catch (error) {
      if (child && child.exitCode === null && child.signalCode === null) {
        await terminateProcessTree(child, { processGroup: !isWindows });
      }
      if (child && this.child === child) this.child = null;
      if (!this.disposed) this.emit({ type: 'turn.failed', ...safeFailure(error, 'codex turn failed') });
    } finally {
      this.drainNext();
    }
  }

  private applyTextSnapshot(text: string): void {
    text = capStreamText(text);
    if (text.startsWith(this.messageBuf) && text.length > this.messageBuf.length) {
      this.emit({ type: 'text.delta', text: text.slice(this.messageBuf.length) });
    } else if (text && !this.messageBuf) {
      this.emit({ type: 'text.delta', text });
    }
    this.messageBuf = text;
  }

  private applyThinkingSnapshot(text: string): void {
    text = capStreamText(text);
    if (!this.thinkingActive) this.thinkingActive = true;
    if (text.startsWith(this.thinkingBuf) && text.length > this.thinkingBuf.length) {
      this.emit({ type: 'thinking.delta', text: text.slice(this.thinkingBuf.length) });
    } else if (text && !this.thinkingBuf) {
      this.emit({ type: 'thinking.delta', text });
    }
    this.thinkingBuf = text;
  }

  private handleLine(line: string): void {
    const event = decodeCodexLine(line);
    if (!event) return;
    switch (event.type) {
      case 'thread.started':
        if (event.threadId) this.threadId = event.threadId;
        break;
      case 'turn.started':
      case 'task.started':
        break;
      case 'turn.completed':
      case 'task.completed':
        this.flushThinking();
        this.flushMessage();
        this.turnCompleted = true;
        this.emit({ type: 'turn.completed', usage: event.usage, model: this.opts.model, effort: this.opts.effort });
        break;
      case 'turn.failed':
        this.flushThinking();
        this.flushMessage();
        this.turnCompleted = true;
        this.emit({ type: 'turn.failed', ...safeFailure(event.errorText, 'codex turn failed') });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.handleItem(event.item, event.type);
        break;
      case 'error':
        log.warn('codex exec error event', { category: categorizeError(event.errorText ?? 'codex event error') });
        break;
      default:
        log.debug('codex exec event unhandled', { type: event.type });
    }
  }

  private ensureTool(itemKey: string, tool: string, input: unknown): string {
    const existing = this.itemTools.get(itemKey);
    if (existing) return existing;
    this.flushThinking();
    this.flushMessage();
    const toolCallId = randomUUID();
    this.itemTools.set(itemKey, toolCallId);
    this.itemOutput.set(itemKey, '');
    this.emit({ type: 'tool.start', toolCallId, tool, input });
    return toolCallId;
  }

  private emitToolOutput(itemKey: string, toolCallId: string, output: string): void {
    output = capStreamText(output);
    const previous = this.itemOutput.get(itemKey) ?? '';
    if (output.startsWith(previous) && output.length > previous.length) {
      this.emit({ type: 'tool.output', toolCallId, text: output.slice(previous.length) });
    } else if (output && !previous) {
      this.emit({ type: 'tool.output', toolCallId, text: output });
    }
    this.itemOutput.set(itemKey, output);
  }

  private finishTool(itemKey: string, toolCallId: string, isError: boolean): void {
    this.emit({ type: 'tool.done', toolCallId, isError });
    this.itemTools.delete(itemKey);
    this.itemOutput.delete(itemKey);
  }

  private handleItem(item: NormalizedCodexItem | undefined, phase: string): void {
    if (!item) return;
    if (item.kind === 'agent_message') {
      this.flushThinking();
      this.applyTextSnapshot(item.text);
      if (phase === 'item.completed') this.flushMessage();
      return;
    }
    if (item.kind === 'reasoning') {
      this.flushMessage();
      this.applyThinkingSnapshot(item.text);
      if (phase === 'item.completed') this.flushThinking();
      return;
    }
    if (item.kind === 'command_execution') {
      const key = item.id || 'command_execution';
      const toolCallId = this.ensureTool(key, 'Bash', { command: item.command });
      this.emitToolOutput(key, toolCallId, item.output);
      if (phase === 'item.completed') {
        this.finishTool(key, toolCallId, item.status === 'failed' || item.status === 'declined');
      }
      return;
    }
    if (item.kind === 'file_change') {
      const key = item.id || 'file_change';
      const toolCallId = this.ensureTool(key, 'Edit', { changes: item.changes });
      if (phase === 'item.completed') this.finishTool(key, toolCallId, item.status === 'failed');
      return;
    }
    if (item.kind === 'mcp_tool_call') {
      const key = item.id || 'mcp_tool_call';
      const name = 'MCP:' + item.server + '/' + item.tool;
      const toolCallId = this.ensureTool(key, name, item.input);
      if (item.output) this.emitToolOutput(key, toolCallId, item.output);
      if (phase === 'item.completed') this.finishTool(key, toolCallId, item.status === 'failed');
    }
  }

  private async handleHook(payload: unknown): Promise<CodexHookResponse> {
    const value = (payload ?? {}) as { tool_name?: string; tool_input?: unknown };
    const tool = value.tool_name ?? 'unknown';
    const toolInput = value.tool_input;
    if (toolInput === undefined) {
      log.warn('codex hook payload missing tool_input -> deny', { tool });
      return toCodexHook('deny', undefined);
    }
    if (this.opts.approvalPolicy === 'never' || this.autoAllow.has(tool)) {
      return toCodexHook('allow', toolInput);
    }

    const kind = toolToKind(tool);
    const displayTool = kind === 'command' ? 'Bash' : tool;
    const approvalId = randomUUID();
    this.emit({
      type: 'approval.request',
      approvalId,
      kind,
      tool: displayTool,
      input: toolInput,
      summary: summarize(displayTool, toolInput),
      choices: [...CHOICES],
    });
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.tracker.register(approvalId, resolve);
    });
    if (decision === 'allow_session') this.autoAllow.add(tool);
    return toCodexHook(decision, toolInput);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.tracker.clear();
    const child = this.child;
    if (!child) return;
    await terminateProcessTree(child, {
      gracefulSignal: 'SIGINT',
      graceMs: 3_000,
      hardMs: 5_000,
      processGroup: !isWindows,
    });
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.tracker.resolve(approvalId, decision)) throw new Error('approval is not pending');
  }

  history(_afterSeq?: number): Promise<Message[]> {
    return Promise.resolve([]);
  }

  onEvent(cb: (event: AdapterEvent) => void): () => void {
    this.emit = cb;
    return () => {
      if (this.emit === cb) this.emit = () => {};
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue = [];
    this.tracker.clear();
    try {
      this.opts.hooks.unregister(this.sessionId, this.sessionId);
    } catch {
      // Best-effort cleanup.
    }
    if (this.hookConfigPath) {
      try {
        rmSync(dirname(this.hookConfigPath), { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
      this.hookConfigPath = null;
    }
    const child = this.child;
    if (!child) return;
    await terminateProcessTree(child, { processGroup: !isWindows });
    if (this.child === child) this.child = null;
  }
}
