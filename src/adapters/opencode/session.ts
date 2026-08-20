// Opencode session (A3): `opencode serve` HTTP + SSE. v1/v2 coexist; detected at
// runtime via /openapi.json. Verified findings §3; items marked // SMOKE need VM
// validation (v1/v2 branch, reply body fields, SSE paths).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AdapterEvent,
  ApprovalDecision,
  ApprovalKind,
  Message,
  SessionHandle,
  UserInput,
  Usage,
} from '../types';
import { ApprovalTracker, toOpencode } from '../../approval/bridge';
import { which } from '../../util/spawn';
import { findFreePort } from '../../gateway/ports';
import { log, registerSecrets, registerEnvSecrets, categorizeError, safeStderrSummary } from '../../util/logger';
import { scrubMoyuEnv } from '../../util/runtime';

export interface OpencodeSessionOpts {
  sessionId: string;
  cliSessionRef: string;
  cwd?: string;
  approvalTimeoutSec: number;
  password?: string; // OPENCODE_SERVER_PASSWORD if set
  model?: string;
}

function authHeaders(password?: string): Record<string, string> {
  if (!password) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
}

const CHOICES = ['allow', 'allow_session', 'deny', 'cancel'] as const;

export class OpencodeSession implements SessionHandle {
  readonly sessionId: string;
  readonly cliSessionRef: string;
  private emit: (e: AdapterEvent) => void = () => {};
  private child: ChildProcess | null = null;
  private tracker: ApprovalTracker;
  private base = '';
  private version: 'v1' | 'v2' = 'v2';
  private ocSessionId: string | null = null;
  private sseCtrl: AbortController | null = null;
  // Accumulated assistant text from session.next.text.delta / message.part.updated. Flushed
  // as a text.done event at every message boundary so SessionManager persists it (it only
  // persists on text.done; without this opencode assistant replies never reach /messages).
  private messageBuf = '';
  /** §5: accumulated serve stderr; never logged raw -- only a fixed-length redacted summary. */
  private stderrBuf = '';

  constructor(private opts: OpencodeSessionOpts) {
    this.sessionId = opts.sessionId;
    this.cliSessionRef = opts.cliSessionRef;
    this.tracker = new ApprovalTracker(opts.approvalTimeoutSec, (id, decision) => {
      this.emit({ type: 'approval.resolved', approvalId: id, decision });
    });
  }

  async init(): Promise<void> {
    const bin = which('opencode');
    if (!bin) throw new Error('opencode CLI not found');
    const port = await findFreePort(14000, 14099, '127.0.0.1');
    this.base = `http://127.0.0.1:${port}`;
    this.child = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: this.opts.cwd,
      env: scrubMoyuEnv(process.env, undefined, this.opts.cwd),
      windowsHide: true,
    });
    // §5: opencode runs in the user's native env. Register credential-bearing process.env
    // values + the opencode auth password so arbitrary-format tokens are masked in stderr.
    registerEnvSecrets(process.env);
    if (this.opts.password) registerSecrets(this.opts.password);
    this.child.stderr?.on('data', (d: Buffer) => {
      // §5: never log raw stderr per-chunk. Accumulate; emit one redacted summary on close.
      this.stderrBuf += d.toString('utf8');
    });
    this.child.on('close', (code) => {
      // §5: never log raw stderr; only exit code + error category + fixed-length redacted summary.
      if (this.stderrBuf.trim()) {
        log.warn('opencode serve stderr summary', {
          code,
          category: categorizeError(this.stderrBuf),
          summary: safeStderrSummary(this.stderrBuf),
        });
      } else {
        log.info('opencode serve exited', { code });
      }
      this.child = null;
    });

    await this.waitReady();
    this.version = await this.detectVersion();
    log.info('opencode ready', { version: this.version, base: this.base });
    this.ocSessionId = await this.createSession();
    this.startSSE();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.base}/health`);
        if (r.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('opencode serve did not become ready');
  }

  private async detectVersion(): Promise<'v1' | 'v2'> {
    // SMOKE: /openapi.json vs /doc; presence of v2 routes
    try {
      const r = await fetch(`${this.base}/openapi.json`);
      if (r.ok) {
        const spec = (await r.json()) as { paths?: Record<string, unknown> };
        if (spec.paths?.['/api/event'] || spec.paths?.['/api/session']) return 'v2';
        return 'v1';
      }
    } catch {
      // best-effort
    }
    return 'v2'; // default to v2 (dev source)
  }

  private async createSession(): Promise<string> {
    // SMOKE: v1 POST /session vs v2 POST /api/session
    const path = this.version === 'v2' ? '/api/session' : '/session';
    const r = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.opts.password) },
      body: JSON.stringify({ model: this.opts.model }),
    });
    if (!r.ok) throw new Error(`opencode createSession ${r.status}: ${await r.text()}`);
    const body = (await r.json()) as { id?: string; session?: { id?: string } };
    return body.id ?? body.session?.id ?? '';
  }

  private startSSE(): void {
    const ctrl = new AbortController();
    this.sseCtrl = ctrl;
    const url = this.version === 'v2' ? `${this.base}/api/event` : `${this.base}/event`;
    void (async () => {
      try {
        const r = await fetch(url, { headers: authHeaders(this.opts.password), signal: ctrl.signal });
        if (!r.body) return;
        await this.parseSSE(r.body);
      } catch (e) {
        if (!ctrl.signal.aborted) log.warn('opencode SSE error', { err: String(e) });
      }
    })();
  }

  private async parseSSE(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        try {
          this.handleSSEEvent(JSON.parse(json) as Record<string, unknown>);
        } catch {
          // non-JSON keepalive
        }
      }
    }
  }

  /** Finalize buffered assistant text as a text.done event (clears the buffer). Mirrors the
   *  codex adapter's accumulate-then-emit-on-boundary pattern. Idempotent when empty. */
  private flushMessage(): void {
    if (this.messageBuf) {
      this.emit({ type: 'text.done', text: this.messageBuf });
      this.messageBuf = '';
    }
  }

  private handleSSEEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string;
    if (!type) return;
    // v2 events
    if (type === 'session.next.text.delta') {
      const text = (ev.delta as string) ?? '';
      this.messageBuf += text;
      this.emit({ type: 'text.delta', text });
    } else if (type === 'session.next.text.ended') {
      // text finalized via deltas -> flush accumulated buffer as text.done so it persists.
      this.flushMessage();
    } else if (type === 'session.next.tool.called') {
      this.flushMessage(); // a tool call beginning => preceding assistant text ended
      this.emit({
        type: 'tool.start',
        toolCallId: (ev.toolCallId as string) ?? randomUUID(),
        tool: (ev.tool as string) ?? 'tool',
        input: ev.input,
      });
    } else if (type === 'session.next.tool.success' || type === 'session.next.tool.failed') {
      this.emit({
        type: 'tool.done',
        toolCallId: (ev.toolCallId as string) ?? '',
        isError: type === 'session.next.tool.failed',
      });
    } else if (type === 'session.next.step.ended') {
      this.flushMessage(); // safety-net: persist any unflushed assistant text before turn end
      const u = ev as { inputTokens?: number; outputTokens?: number; cost?: number };
      this.emit({
        type: 'turn.completed',
        usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens },
        costUsd: typeof u.cost === 'number' ? u.cost : undefined,
      });
    } else if (type === 'permission.v2.asked' || type === 'permission.updated') {
      this.onPermission(ev);
    } else if (type === 'session.idle') {
      // v1 completion signal
      this.flushMessage(); // v1 has no text.ended; flush accumulated text at turn end
      this.emit({ type: 'turn.completed' });
    }
    // v1 message.part.updated handled minimally
    else if (type === 'message.part.updated') {
      const part = ev.part as { type?: string; text?: string } | undefined;
      if (part?.type === 'text' && typeof part.text === 'string') {
        this.emit({ type: 'text.delta', text: part.text });
      }
    }
  }

  private onPermission(ev: Record<string, unknown>): void {
    const permissionId = (ev.id ?? ev.permissionId) as string | undefined;
    if (!permissionId) return;
    const kind: ApprovalKind = 'permission';
    const approvalId = permissionId; // reuse as our approvalId
    this.emit({
      type: 'approval.request',
      approvalId,
      kind,
      tool: (ev.tool as string) ?? undefined,
      input: ev.input,
      summary: (ev.message as string) ?? `permission ${ev.tool ?? ''}`,
      choices: [...CHOICES],
    });
    void new Promise<ApprovalDecision>((resolve) => {
      this.tracker.register(approvalId, resolve);
    });
  }

  async send(input: UserInput): Promise<void> {
    if (!this.ocSessionId) throw new Error('opencode session not created');
    // SMOKE: v1 /session/:id/prompt_async vs v2 /api/session/:id/prompt
    const path =
      this.version === 'v2'
        ? `/api/session/${this.ocSessionId}/prompt`
        : `/session/${this.ocSessionId}/prompt_async`;
    const r = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.opts.password) },
      body: JSON.stringify({ parts: [{ type: 'text', text: input.text }] }),
    });
    if (!r.ok) log.warn('opencode prompt failed', { status: r.status, body: await r.text() });
  }

  async interrupt(): Promise<void> {
    if (!this.ocSessionId) return;
    const path =
      this.version === 'v2'
        ? `/api/session/${this.ocSessionId}/abort`
        : `/session/${this.ocSessionId}/abort`;
    try {
      await fetch(`${this.base}${path}`, { method: 'POST', headers: authHeaders(this.opts.password) });
    } catch (e) {
      log.warn('opencode abort failed', { err: String(e) });
    }
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const reply = toOpencode(decision);
    if (this.version === 'v2') {
      // SMOKE: session.permission.reply vs POST /api/session/:id/permissions/:id
      const path = `/api/session/${this.ocSessionId}/permissions/${approvalId}`;
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.opts.password) },
        body: JSON.stringify({ reply }),
      });
    } else {
      const path = `/session/${this.ocSessionId}/permissions/${approvalId}`;
      await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.opts.password) },
        body: JSON.stringify({ response: reply }),
      });
    }
    this.tracker.resolve(approvalId, decision);
  }

  history(_afterSeq?: number): Promise<Message[]> {
    return Promise.resolve([]);
  }

  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.emit = cb;
    return () => {
      if (this.emit === cb) this.emit = () => {};
    };
  }

  async dispose(): Promise<void> {
    this.tracker.clear();
    this.sseCtrl?.abort();
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }
  }
}
