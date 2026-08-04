// Claude session (A1): spawns `claude -p --output-format stream-json` per turn,
// resumes via --session-id/--resume, parses NDJSON, and bridges PreToolUse hook
// approvals. 0-perception: no CLAUDE_CODE_REMOTE/BRIDGE_SESSION_ID; hook via --settings.
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
import type { ClaudeHookPayload, HookRegistry } from '../../api/hooks';
import type { ApprovalPolicy } from '../../config/schema';
import { ApprovalTracker, toClaude, type ClaudeHookResponse } from '../../approval/bridge';
import { ClaudeStreamParser } from './parser';
import { readLines } from '../../util/spawn';
import { log, registerSecrets, registerEnvSecrets, categorizeError, safeStderrSummary, safeFailure } from '../../util/logger';
import { scrubMoyuEnv } from '../../util/runtime';
import { isWindows } from '../../util/platform';
import { terminateProcessTree } from '../../util/process';

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
  /** v3: env vars resolved from the active account profile (subscription switching).
   *  Injected verbatim into the spawn env; holds credentials, NEVER echoed in events (S6). */
  profileEnv?: Record<string, string>;
  bin: string; // resolved claude binary path (native exe or legacy cli.js)
}

function toolToKind(tool: string): ApprovalKind {
  if (tool === 'Bash') return 'command';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'].includes(tool)) return 'fileChange';
  if (tool.startsWith('mcp__')) return 'mcpElicit';
  return 'permission';
}

function summarize(tool: string, input: unknown): string {
  try {
    if (typeof input === 'object' && input !== null) {
      const i = input as Record<string, unknown>;
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

// #6: fixed cap on accumulated subprocess stderr. A long/verbose turn can emit unbounded
// stderr before the close handler emits its redacted summary; cap at collection time so memory
// stays bounded. safeStderrSummary() further truncates for the log line.
const STDERR_CAP = 64 * 1024; // 64KB
const MAX_PENDING_INPUTS = 32;

export interface ClaudePrintInvocation {
  args: string[];
  stdin: string;
}

/** Build the native print-mode invocation. The prompt goes through stdin, as supported by
 * Claude Code's CLI, so it is not exposed in the process list or constrained by argv limits. */
export function buildClaudePrintInvocation(
  opts: Pick<ClaudeSessionOpts, 'sessionId' | 'cliSessionRef' | 'extraDirs' | 'model' | 'effort'>,
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
  for (const dir of opts.extraDirs ?? []) args.push('--add-dir', dir);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  return { args, stdin: input.text };
}

export class ClaudeSession implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef: string;
  get model(): string | undefined { return this.opts.model; }
  get effort(): ReasoningEffort | undefined { return this.opts.effort; }
  private emit: (e: AdapterEvent) => void = () => {};
  private tracker: ApprovalTracker;
  private autoAllow = new Set<string>();
  private hasSession = false;
  private child: ChildProcess | null = null;
  private parser: ClaudeStreamParser | null = null;
  private resultSeen = false;
  private interrupted = false;
  /** §5: accumulated subprocess stderr for the current turn; never logged raw -- only a
   *  fixed-length redacted summary is emitted on close. Reset per runTurn. */
  private stderrBuf = '';
  private settingsPath: string | null = null;
  /** F8: per-session shared secret stored only in the mode-0600 temporary settings file.
   * It is never injected into the CLI environment, so tool subprocesses cannot echo it. */
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
      this.emit({ type: 'approval.resolved', approvalId: id, decision });
    });
  }

  async init(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'rd-claude-'));
    this.settingsPath = join(dir, 'settings.json');
    // F8: 192-bit per-session secret. The temporary directory is removed on dispose and the
    // file is mode 0600. Keeping it out of the CLI env prevents ordinary tools from seeing it.
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
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                // FAIL-OPEN (claude HTTP hook, verified 2026-07-31): claude blocks a tool ONLY on
                // 2xx + permissionDecision:"deny". On non-2xx, connection failure, or timeout it
                // ALLOWS the tool. So if this gateway is unreachable, claude auto-approves. The
                // gateway is fail-closed when reachable (DENY on no handler); mitigation is gateway
                // availability (no client-side fail-closed mechanism by design constraint).
                type: 'http',
                url: `http://127.0.0.1:${this.opts.port}/hooks/pre-tool-use`,
                // Give the gateway's fail-closed tracker time to return deny before Claude's
                // own HTTP-hook timeout (which is fail-open on transport failure).
                timeout: Math.min(599, this.opts.approvalTimeoutSec + 10),
                // Literal in a private temporary settings file; never enters CLI/tool env.
                headers: { Authorization: `Bearer ${this.hookSecret}` },
              },
            ],
          },
        ],
      },
    };
    writeFileSync(this.settingsPath, JSON.stringify(settings), { mode: 0o600 });
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

    const invocation = buildClaudePrintInvocation(this.opts, this.settingsPath!, this.hasSession, input);
    const baseArgs = invocation.args;

    this.emit({ type: 'turn.started' });
    log.debug('claude spawn', { hasSession: this.hasSession, cwd: this.opts.cwd });
    const isJs = this.opts.bin.endsWith('.js');
    // v3: inject the active profile's env set (subscription switching). The profile is a
    // user-maintained credential set read 0-modify by the backend; the CLI reads these env
    // vars exactly as if the user had exported them in their own shell -- the tool does NOT
    // enter the CLI's auth-verification environment, so the provider perceives nothing (S0perc).
    const env = scrubMoyuEnv({ ...process.env, ...(this.opts.profileEnv ?? {}) });
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
        ? { ...e, model: this.opts.model, effort: this.opts.effort }
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
        for await (const line of readLines(child.stdout)) {
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
            this.emit({
              type: 'turn.failed',
              ...safeFailure(this.interrupted ? 'interrupted' : 'claude exited without result'),
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
    if (!this.tracker.resolve(approvalId, decision)) throw new Error('approval is not pending');
  }

  /** Called by the PreToolUse HTTP hook (routed via HookRegistry by session_id). */
  async handleHook(payload: ClaudeHookPayload): Promise<ClaudeHookResponse> {
    const tool = payload.tool_name ?? 'unknown';
    const input = payload.tool_input;
    // v2: approvalPolicy='never' => auto-allow every tool (no remote approval).
    if (this.opts.approvalPolicy === 'never' || this.autoAllow.has(tool)) {
      return toClaude('allow');
    }
    const approvalId = randomUUID();
    const kind = toolToKind(tool);
    this.emit({
      type: 'approval.request',
      approvalId,
      kind,
      tool,
      input,
      summary: summarize(tool, input),
      choices: [...CHOICES],
    });
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.tracker.register(approvalId, resolve);
    });
    if (decision === 'allow_session') this.autoAllow.add(tool);
    return toClaude(decision);
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
    }
  }
}
