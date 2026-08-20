// Claude session (A1): spawns `claude -p --output-format stream-json` per turn,
// resumes via --session-id/--resume, parses NDJSON, and bridges PreToolUse command-hook
// approvals. 0-perception: no CLAUDE_CODE_REMOTE/BRIDGE_SESSION_ID; hook via --settings.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AdapterEvent,
  ApprovalDecision,
  ApprovalChoice,
  ApprovalKind,
  Message,
  SessionHandle,
  UserInput,
  ReasoningEffort,
  PermissionMode,
} from '../types';
import type { ClaudeHookPayload, HookRegistry } from '../../api/hooks';
import type { ApprovalPolicy } from '../../config/schema';
import { ApprovalTracker, toClaude, type ClaudeHookResponse } from '../../approval/bridge';
import { ClaudeStreamParser } from './parser';
import { readLines, run } from '../../util/spawn';
import { log, registerSecrets, registerEnvSecrets, categorizeError, safeStderrSummary, safeFailure } from '../../util/logger';
import { scrubMoyuEnv } from '../../util/runtime';
import { isWindows } from '../../util/platform';
import { terminateProcessTree } from '../../util/process';
import { createPrivateRuntimeSubdirectory, writeFileInPrivateDirectory } from '../../util/private-file';
import { hookRelayExec, relayTimeoutSecFor } from '../../approval/hook-command';

export interface ClaudeSessionOpts {
  sessionId: string;
  cliSessionRef: string;
  cwd?: string;
  extraDirs?: string[];
  port: number;
  approvalTimeoutSec: number;
  hooks: HookRegistry;
  approvalPolicy: ApprovalPolicy; // 'never' => hook auto-allows; else ask-every-tool (matcher:'*')
  model?: string;
  effort?: ReasoningEffort;
  permissionMode: PermissionMode;
  /** v3: env vars resolved from the active account profile (subscription switching).
   *  Injected verbatim into the spawn env; holds credentials, NEVER echoed in events (S6). */
  profileEnv?: Record<string, string>;
  /** True only for a selected, non-native *.env profile. Native sessions preserve the user's
   * complete process environment, including native Claude credentials. */
  isolateProfileAuthEnv?: boolean;
  bin: string; // resolved claude binary path (native exe or legacy cli.js)
}

function toolToKind(tool: string): ApprovalKind {
  if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return 'userInput';
  if (tool === 'Bash') return 'command';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool)) return 'fileChange';
  if (tool.startsWith('mcp__')) return 'mcpElicit';
  return 'permission';
}

function summarize(tool: string, input: unknown): string {
  try {
    if (typeof input === 'object' && input !== null) {
      const i = input as Record<string, unknown>;
      if (tool === 'AskUserQuestion' && Array.isArray(i.questions)) {
        const first = i.questions[0];
        if (first && typeof first === 'object' && typeof (first as { question?: unknown }).question === 'string') {
          return String((first as { question: string }).question).slice(0, 200);
        }
      }
      if (tool === 'Bash' && typeof i.command === 'string') return `$ ${i.command.slice(0, 200)}`;
      if (typeof i.file_path === 'string') return `${tool} ${i.file_path}`;
      if (typeof i.path === 'string') return `${tool} ${i.path}`;
    }
  } catch {
    // best-effort
  }
  return tool;
}

const CHOICES = ['allow', 'allow_session', 'deny', 'cancel'] as const;
const USER_INPUT_CHOICES: ApprovalChoice[] = ['allow', 'deny', 'cancel'];
const QUESTION_CHOICES: ApprovalChoice[] = ['deny', 'cancel'];

interface ClaudeQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** Validate the native AskUserQuestion shape and merge only bounded answers into a fresh copy of
 * the original questions. The phone can answer questions but cannot replace arbitrary tool args. */
export function mergeAskUserQuestionAnswers(input: unknown, decision: ApprovalDecision): unknown {
  if (typeof decision === 'string') throw new Error('AskUserQuestion requires structured answers');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid AskUserQuestion input');
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error('invalid AskUserQuestion questions');
  }
  const questions: ClaudeQuestion[] = [];
  const seen = new Set<string>();
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid AskUserQuestion question');
    const source = raw as Record<string, unknown>;
    const question = boundedText(source.question, 2_000);
    if (!question || seen.has(question)) throw new Error('invalid AskUserQuestion question');
    seen.add(question);
    const normalized: ClaudeQuestion = { question };
    if (source.header !== undefined) {
      const header = boundedText(source.header, 128);
      if (!header) throw new Error('invalid AskUserQuestion header');
      normalized.header = header;
    }
    if (source.multiSelect !== undefined) {
      if (typeof source.multiSelect !== 'boolean') throw new Error('invalid AskUserQuestion multiSelect');
      normalized.multiSelect = source.multiSelect;
    }
    if (source.options !== undefined) {
      if (!Array.isArray(source.options) || source.options.length > 20) throw new Error('invalid AskUserQuestion options');
      normalized.options = source.options.map((option) => {
        if (!option || typeof option !== 'object' || Array.isArray(option)) throw new Error('invalid AskUserQuestion option');
        const rawOption = option as Record<string, unknown>;
        const label = boundedText(rawOption.label, 256);
        if (!label) throw new Error('invalid AskUserQuestion option label');
        const normalizedOption: { label: string; description?: string } = { label };
        if (rawOption.description !== undefined) {
          const description = boundedText(rawOption.description, 1_000);
          if (!description) throw new Error('invalid AskUserQuestion option description');
          normalizedOption.description = description;
        }
        return normalizedOption;
      });
    }
    questions.push(normalized);
  }

  const supplied = decision.allowWithModification.answers;
  const answerEntries = Object.entries(supplied);
  if (answerEntries.length !== questions.length) throw new Error('AskUserQuestion requires every answer');
  const answers: Record<string, string> = {};
  for (const question of questions) {
    if (!Object.prototype.hasOwnProperty.call(supplied, question.question)) throw new Error('AskUserQuestion answer mismatch');
    const answer = supplied[question.question];
    if (question.multiSelect) {
      if (!Array.isArray(answer) || answer.length < 1 || answer.length > 20) throw new Error('invalid AskUserQuestion multi-select answer');
      answers[question.question] = answer.map((selected) => {
        const value = boundedText(selected, 2_000);
        if (!value) throw new Error('invalid AskUserQuestion answer');
        return value;
      }).join(', ');
    } else {
      const value = boundedText(answer, 2_000);
      if (!value) throw new Error('invalid AskUserQuestion answer');
      answers[question.question] = value;
    }
  }
  for (const key of Object.keys(supplied)) if (!seen.has(key)) throw new Error('AskUserQuestion answer mismatch');
  return { ...(input as Record<string, unknown>), questions, answers };
}

// #6: fixed cap on accumulated subprocess stderr. A long/verbose turn can emit unbounded
// stderr before the close handler emits its redacted summary; cap at collection time so memory
// stays bounded. safeStderrSummary() further truncates for the log line.
const STDERR_CAP = 64 * 1024; // 64KB
const MAX_PENDING_INPUTS = 32;
const CLAUDE_PROFILE_CONFLICT_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/** Build the Claude child environment. A selected *.env profile is an account boundary: only
 * Claude's auth/base-URL/provider selectors are cleared before the profile is overlaid. Native
 * sessions are untouched, and provider-specific AWS/GCP variables plus normal CLI settings,
 * skills and MCP environment remain inherited. */
export function buildClaudeSpawnEnv(
  profileEnv: Record<string, string> | undefined,
  isolateProfileAuthEnv: boolean,
  inherited: NodeJS.ProcessEnv = process.env,
  childCwd?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  if (isolateProfileAuthEnv) {
    for (const key of CLAUDE_PROFILE_CONFLICT_KEYS) delete env[key];
  }
  Object.assign(env, profileEnv ?? {});
  return scrubMoyuEnv(env, undefined, childCwd);
}
// A tool_result may carry up to four in-band images in one JSONL event. Four 8 MiB binaries
// occupy roughly 42.7 MiB as base64; keep the 48 MiB allowance local to Claude while the
// shared reader remains at 2 MiB.
export const CLAUDE_MAX_JSONL_LINE_CHARS = 48 * 1024 * 1024;

export interface ClaudePrintInvocation {
  args: string[];
  stdin: string;
}

export interface ClaudeHookSettings {
  disableAllHooks: false;
  hooks: {
    SessionStart: Array<{
      matcher: 'startup';
      hooks: Array<{
        type: 'command';
        command: string;
        args: string[];
        timeout: number;
      }>;
    }>;
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{
        type: 'command';
        command: string;
        args: string[];
        timeout: number;
      }>;
    }>;
  };
}

/** Build a local exec-form hook. The relay exits 2 for every invalid request/response,
 * transport error or timeout; Claude treats exit 2 from PreToolUse as a blocking result. */
export function buildClaudeHookSettings(configPath: string, approvalTimeoutSec: number): ClaudeHookSettings {
  const relay = hookRelayExec(configPath);
  const relayTimeoutSec = relayTimeoutSecFor(approvalTimeoutSec);
  return {
    // Command-line settings outrank user/project/local scalar settings. Managed policy remains
    // authoritative; the init-only SessionStart canary below detects when it suppresses hooks.
    disableAllHooks: false,
    hooks: {
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [
            {
              type: 'command',
              command: relay.command,
              args: relay.args,
              timeout: 15,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: relay.command,
              args: relay.args,
              // The relay owns the timeout and exits 2 first. This is only a backstop.
              timeout: relayTimeoutSec + 20,
            },
          ],
        },
      ],
    },
  };
}

/** Build the native print-mode invocation. Plain text keeps Claude's ordinary text stdin
 * protocol. Attachments use Claude's documented stream-json user-message/image blocks; no
 * synthetic path label or other gateway-authored text is added to the user's prompt. */
export function buildClaudePrintInvocation(
  opts: Pick<ClaudeSessionOpts, 'sessionId' | 'cliSessionRef' | 'extraDirs' | 'model' | 'effort' | 'permissionMode'>,
  settingsPath: string,
  hasSession: boolean,
  input: UserInput,
): ClaudePrintInvocation {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--settings',
    settingsPath,
  ];
  const resuming = hasSession || opts.cliSessionRef !== opts.sessionId;
  args.push(resuming ? '--resume' : '--session-id', opts.cliSessionRef);
  for (const dir of new Set(opts.extraDirs ?? [])) args.push('--add-dir', dir);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  args.push('--permission-mode', opts.permissionMode || 'acceptEdits');
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return { args, stdin: input.text };

  args.push('--input-format', 'stream-json');
  const content: Array<Record<string, unknown>> = [];
  if (input.text) content.push({ type: 'text', text: input.text });
  for (const attachment of attachments) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mime,
        data: readFileSync(attachment.path).toString('base64'),
      },
    });
  }
  const stdin = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }) + '\n';
  return { args, stdin };
}

export class ClaudeSession implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef: string;
  get model(): string | undefined { return this.opts.model; }
  get effort(): ReasoningEffort | undefined { return this.opts.effort; }
  get permissionMode(): PermissionMode { return this.opts.permissionMode; }
  private emit: (e: AdapterEvent) => void = () => {};
  private tracker: ApprovalTracker;
  private autoAllow = new Set<string>();
  private pendingApprovals = new Map<string, { tool: string; input: unknown }>();
  private hasSession = false;
  private child: ChildProcess | null = null;
  private parser: ClaudeStreamParser | null = null;
  private resultSeen = false;
  private interrupted = false;
  /** §5: accumulated subprocess stderr for the current turn; never logged raw -- only a
   *  fixed-length redacted summary is emitted on close. Reset per runTurn. */
  private stderrBuf = '';
  private settingsPath: string | null = null;
  private hookConfigPath: string | null = null;
  private hookProbePath: string | null = null;
  /** F8: per-session shared secret stored only in the private relay descriptor. It is never
   * injected into the CLI environment or settings argv, so tool subprocesses cannot echo it. */
  private hookSecret = '';
  private disposed = false;
  private busy = false;
  private queue: UserInput[] = [];
  private turnDispatchAt = 0;
  private firstVisibleEvent = false;

  constructor(private opts: ClaudeSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cliSessionRef = opts.cliSessionRef;
    this.tracker = new ApprovalTracker(opts.approvalTimeoutSec, (id, decision) => {
      this.pendingApprovals.delete(id);
      this.emit({ type: 'approval.resolved', approvalId: id, decision });
    });
  }

  async init(): Promise<void> {
    const dir = createPrivateRuntimeSubdirectory();
    this.settingsPath = join(dir, 'settings.json');
    this.hookConfigPath = join(dir, 'data.json');
    this.hookProbePath = join(dir, 'ready');
    // F8: 192-bit per-session secret. The private temporary directory is removed on dispose.
    // Keeping it out of the CLI env and settings file prevents ordinary tools from seeing it.
    this.hookSecret = randomBytes(24).toString('hex');
    // P1: register the active profile's actual sensitive values + the per-session hook secret
    // with the logger so any exact match is masked in CLI stderr/debug logs. Pattern masking
    // alone misses arbitrary-format tokens (AWS keys, base64, custom provider keys).
    registerSecrets(this.hookSecret, ...Object.values(this.opts.profileEnv ?? {}));
    // §5: also register credential-bearing values from the CLI's inherited process.env
    // (nativeDefault credentials, e.g. ANTHROPIC_API_KEY already exported in the user's shell)
    // and from the profile env by KEY NAME, so arbitrary-format tokens are masked in stderr
    // regardless of whether they came from a profile or the native environment.
    registerEnvSecrets(process.env);
    registerEnvSecrets(this.opts.profileEnv ?? {});
    this.writeHookDescriptor();
    writeFileInPrivateDirectory(
      this.settingsPath,
      JSON.stringify(buildClaudeHookSettings(this.hookConfigPath, this.opts.approvalTimeoutSec)),
    );
    // §8: register the PreToolUse hook under Claude's ACTUAL session_id (cliSessionRef), which
    // is the session_id claude sends in hook payloads -- NOT the backend sessionId. They are
    // equal for fresh sessions (manager sets cliSessionRef = sessionId) but DIFFER on resume
    // (cliSessionRef = the resumed claude session id), so keying by backend sessionId broke
    // resume approval routing. Owner = backend sessionId (for duplicate-resume rejection).
    this.opts.hooks.register(
      this.cliSessionRef,
      this.sessionId,
      (p: unknown) => this.handleHook(p as ClaudeHookPayload),
      this.hookSecret,
    );
  }

  private writeHookDescriptor(probeNonce?: string): void {
    if (!this.hookConfigPath) throw new Error('Claude hook descriptor is unavailable');
    const descriptor: Record<string, unknown> = {
      port: this.opts.port,
      timeoutMs: relayTimeoutSecFor(this.opts.approvalTimeoutSec) * 1000,
      secret: this.hookSecret,
      // The command relay supplies this explicit routing key because resumed CLI sessions use
      // cliSessionRef rather than the backend session id.
      sessionId: this.cliSessionRef,
    };
    if (probeNonce) {
      descriptor.probePath = this.hookProbePath;
      descriptor.probeNonce = probeNonce;
    }
    writeFileInPrivateDirectory(this.hookConfigPath, JSON.stringify(descriptor));
  }

  /** Claude can suppress non-managed hooks through native or enterprise settings. Its init-only
   * mode runs SessionStart without sending a prompt or invoking a model, so a private nonce is a
   * deterministic per-turn proof that the same injected settings are active. */
  private async verifyHookAvailability(): Promise<void> {
    if (!this.settingsPath || !this.hookProbePath) throw new Error('Claude hook settings are unavailable');
    rmSync(this.hookProbePath, { force: true });
    const nonce = randomBytes(32).toString('hex');
    this.writeHookDescriptor(nonce);
    const args = ['--init-only', '--setting-sources', '', '--settings', this.settingsPath];
    const env = buildClaudeSpawnEnv(this.opts.profileEnv, !!this.opts.isolateProfileAuthEnv, process.env, this.opts.cwd);
    const isJs = this.opts.bin.endsWith('.js');
    try {
      await run(isJs ? process.execPath : this.opts.bin, isJs ? [this.opts.bin, ...args] : args, {
        cwd: this.opts.cwd,
        env,
        timeout: 20_000,
      });
      const observed = readFileSync(this.hookProbePath, 'utf8');
      if (observed !== nonce) throw new Error('readiness nonce mismatch');
    } catch {
      throw new Error('Claude required command hooks are disabled or unavailable');
    } finally {
      rmSync(this.hookProbePath, { force: true });
    }
  }

  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.emit = cb;
    return () => {
      if (this.emit === cb) this.emit = () => {};
    };
  }

  async send(input: UserInput): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy) {
      if (this.queue.length >= MAX_PENDING_INPUTS) throw new Error('session input queue full');
      this.queue.push(input);
      return;
    }
    this.startTurn(input);
  }

  async setEffort(effort?: ReasoningEffort): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy || this.queue.length) throw new Error('cannot change effort while a turn is running');
    if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      throw new Error('unsupported Claude effort');
    }
    this.opts.effort = effort;
  }

  async setModel(model?: string): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy || this.queue.length) throw new Error('cannot change model while a turn is running');
    const normalized = model?.trim();
    if (normalized && normalized.length > 128) throw new Error('invalid model');
    this.opts.model = normalized || undefined;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.disposed) throw new Error('session disposed');
    if (this.busy || this.queue.length) throw new Error('cannot change permission mode while a turn is running');
    if (!['plan', 'auto', 'acceptEdits'].includes(mode)) throw new Error('unsupported permission mode');
    this.opts.permissionMode = mode;
    this.autoAllow.clear();
  }

  private startTurn(input: UserInput): void {
    void this.runTurn(input).catch((error) => {
      this.busy = false;
      this.child = null;
      if (!this.disposed) this.emit({ type: 'turn.failed', ...safeFailure(error, 'claude turn failed') });
      const next = this.queue.shift();
      if (next && !this.disposed) this.startTurn(next);
    });
  }

  private async runTurn(input: UserInput): Promise<void> {
    const dispatchStartedAt = Date.now();
    this.busy = true;
    this.resultSeen = false;
    this.interrupted = false;
    this.firstVisibleEvent = false;
    this.stderrBuf = '';

    await this.verifyHookAvailability();
    const invocation = buildClaudePrintInvocation(this.opts, this.settingsPath!, this.hasSession, input);
    const baseArgs = invocation.args;

    this.emit({ type: 'turn.started' });
    log.debug('claude spawn', { hasSession: this.hasSession, cwd: this.opts.cwd });
    const isJs = this.opts.bin.endsWith('.js');
    // v3: inject the active profile's env set (subscription switching). The profile is a
    // user-maintained credential set read 0-modify by the backend; the CLI reads these env
    // vars exactly as if the user had exported them in their own shell -- the tool does NOT
    // enter the CLI's auth-verification environment, so the provider perceives nothing (S0perc).
    const env = buildClaudeSpawnEnv(this.opts.profileEnv, !!this.opts.isolateProfileAuthEnv, process.env, this.opts.cwd);
    const child = isJs
      ? spawn(process.execPath, [this.opts.bin, ...baseArgs], {
          cwd: this.opts.cwd,
          env,
          windowsHide: true,
          detached: !isWindows,
        })
      : spawn(this.opts.bin, baseArgs, {
          cwd: this.opts.cwd,
          env,
          windowsHide: true,
          detached: !isWindows,
        });
    this.child = child;
    child.stdin?.once('error', () => {});
    child.stdin?.end(invocation.stdin);
    this.turnDispatchAt = Date.now();
    this.emit({
      type: 'transport.metrics',
      metrics: { backendCliDispatchMs: this.turnDispatchAt - dispatchStartedAt, observedAt: new Date().toISOString() },
    });
    this.parser = new ClaudeStreamParser((e) => {
      this.emit(e.type === 'turn.completed'
        ? { ...e, model: e.model ?? this.opts.model, effort: this.opts.effort }
        : e);
    });

    if (child.stderr) {
      // §5: never log raw stderr per-line. Accumulate the full blob and emit one fixed-length,
      // secret-redacted summary on close (see close handler below).
      child.stderr.on('data', (d: Buffer) => {
        this.appendStderr(d.toString('utf8'));
      });
    }

    try {
      if (child.stdout) {
        for await (const line of readLines(child.stdout, CLAUDE_MAX_JSONL_LINE_CHARS)) {
          if (this.disposed) break;
          if (!this.firstVisibleEvent && /"type"\s*:\s*"(?:assistant|stream_event|result)"/.test(line)) {
            this.firstVisibleEvent = true;
            this.emit({
              type: 'transport.metrics',
              metrics: { cliFirstEventMs: Date.now() - this.turnDispatchAt, observedAt: new Date().toISOString() },
            });
          }
          this.parser.feed(line);
          if (line.includes('"type":"result"')) this.resultSeen = true;
        }
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        child.once('close', (code) => {
          if (settled) return;
          settled = true;
          this.child = null;
          this.busy = false;
          // §5: never log raw stderr; only exit code + error category + fixed-length redacted
          // summary (env secrets + value patterns masked, then hard-truncated).
          if (this.stderrBuf.trim()) {
            log.warn('claude turn stderr summary', {
              code,
              category: categorizeError(this.stderrBuf),
              summary: safeStderrSummary(this.stderrBuf),
            });
          }
          if (!this.resultSeen && !this.disposed) {
            const autoUnsupported = this.opts.permissionMode === 'auto'
              && /(?:invalid|unknown|unsupported).{0,80}(?:permission[ _-]?mode|\bauto\b)|permission[ _-]?mode.{0,80}(?:invalid|unknown|unsupported)/i.test(this.stderrBuf);
            if (autoUnsupported) this.opts.permissionMode = 'acceptEdits';
            this.emit({
              type: 'turn.failed',
              ...(autoUnsupported
                ? {
                    category: 'unknown' as const,
                    summary: '当前 Claude CLI 不支持 Auto；会话已降为 Accept Edits，请确认后重新发送。',
                    permissionMode: 'acceptEdits' as const,
                  }
                : safeFailure(this.interrupted ? 'interrupted' : 'claude exited without result')),
            });
          }
          resolve();
        });
        child.once('error', (e) => {
          if (settled) return;
          settled = true;
          log.error('claude spawn error', safeFailure(e));
          this.child = null;
          this.busy = false;
          if (!this.disposed) this.emit({ type: 'turn.failed', ...safeFailure(e, 'claude spawn failed') });
          resolve();
        });
      });
    } catch (e) {
      if (child.exitCode === null && child.signalCode === null) {
        await terminateProcessTree(child, { processGroup: !isWindows });
      }
      this.busy = false;
      this.child = null;
      if (!this.disposed) this.emit({ type: 'turn.failed', ...safeFailure(e, 'claude turn failed') });
    }

    this.hasSession = true;
    if (!this.disposed && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.startTurn(next);
    }
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
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error('approval is not pending');
    if (typeof decision !== 'string') {
      if (pending.tool !== 'AskUserQuestion') throw new Error('structured answers are only valid for AskUserQuestion');
      mergeAskUserQuestionAnswers(pending.input, decision);
    } else if (pending.tool === 'AskUserQuestion' && (decision === 'allow' || decision === 'allow_session')) {
      throw new Error('AskUserQuestion requires structured answers');
    }
    if (!this.tracker.resolve(approvalId, decision)) throw new Error('approval is not pending');
  }

  /** Called by the local PreToolUse command relay. */
  async handleHook(payload: ClaudeHookPayload): Promise<ClaudeHookResponse> {
    const tool = payload.tool_name ?? 'unknown';
    const input = payload.tool_input;
    const kind = toolToKind(tool);
    const needsAnswers = tool === 'AskUserQuestion';
    // User-input tools always round-trip to the phone. For normal tools, the three exposed
    // native modes remain authoritative: Plan and Auto continue into Claude's own checks;
    // Accept Edits auto-allows routine file/read operations and asks remotely for risky tools.
    const userInputTool = tool === 'AskUserQuestion' || tool === 'ExitPlanMode';
    const acceptEditsSafe = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool);
    const modeAllowsHook = !userInputTool && (this.opts.permissionMode === 'auto'
      || this.opts.permissionMode === 'plan'
      || (this.opts.permissionMode === 'acceptEdits' && acceptEditsSafe));
    if (!needsAnswers && !userInputTool
      && (this.opts.approvalPolicy === 'never' || modeAllowsHook || this.autoAllow.has(tool))) {
      return toClaude('allow', input);
    }
    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, { tool, input });
    const pendingDecision = new Promise<ApprovalDecision>((resolve) => {
      this.tracker.register(approvalId, resolve);
    });
    this.emit({
      type: 'approval.request',
      approvalId,
      kind,
      tool,
      input,
      summary: summarize(tool, input),
      choices: needsAnswers ? [...QUESTION_CHOICES] : kind === 'userInput' ? [...USER_INPUT_CHOICES] : [...CHOICES],
    });
    const decision = await pendingDecision;
    if (decision === 'allow_session') this.autoAllow.add(tool);
    if (needsAnswers && typeof decision !== 'string') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: mergeAskUserQuestionAnswers(input, decision),
        },
      };
    }
    return toClaude(decision, input);
  }

  history(_afterSeq?: number): Promise<Message[]> {
    return Promise.resolve([]); // manager holds authoritative history (I2)
  }

  /** #6: append a stderr chunk, keeping only the most recent STDERR_CAP bytes (drop oldest). */
  private appendStderr(chunk: string): void {
    this.stderrBuf += chunk;
    if (this.stderrBuf.length > STDERR_CAP) this.stderrBuf = this.stderrBuf.slice(-STDERR_CAP);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queue = [];
    const child = this.child;
    if (child) await terminateProcessTree(child, { processGroup: !isWindows });
    // §8: unregister under the SAME key used in register (cliSessionRef, = Claude's session_id)
    // so a resumed session's hook is actually removed. Owner-gated so we never evict another
    // session's hook.
    this.opts.hooks.unregister(this.cliSessionRef, this.sessionId);
    this.tracker.clear();
    if (this.settingsPath) {
      try {
        rmSync(dirname(this.settingsPath), { recursive: true, force: true });
      } catch {
        // best-effort
      }
      this.settingsPath = null;
      this.hookConfigPath = null;
      this.hookProbePath = null;
    }
  }
}
