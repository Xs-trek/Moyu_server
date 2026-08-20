// Approval bridge (A5): maps unified ApprovalDecision -> each adapter's native
// approval shape (design §5.3), plus a fail-closed timeout tracker.
// Security: the public timeout is bounded by config validation; every timeout defaults to deny.
import type { ApprovalDecision } from '../adapters/types';
import { log } from '../util/logger';

// ---- Native decision shapes ----

export interface ClaudeHookResponse {
  hookSpecificOutput: {
    // [M] hookEventName is REQUIRED per claude code docs ('hookSpecificOutput requires a
    // hookEventName field set to the event name'); omitting it -> permissionDecision not
    // reliably honored -> allow/deny ignored -> fail-open. Must match the gateway DENY constant.
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: unknown;
  };
}

export type OpencodeReply = 'once' | 'always' | 'reject';

function isModification(d: ApprovalDecision): d is { allowWithModification: { answers: Record<string, string | string[]> } } {
  return typeof d === 'object' && d !== null && 'allowWithModification' in d;
}

/** Map a decision to Claude's command-hook JSON. Echoing the original tool input on an allow
 * also lets the shared relay reject malformed/truncated allow responses before they reach CLI. */
export function toClaude(d: ApprovalDecision, toolInput: unknown = {}): ClaudeHookResponse {
  if (isModification(d) && d.allowWithModification !== undefined) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: d.allowWithModification } };
  }
  switch (d) {
    case 'allow':
    case 'allow_session':
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: toolInput } };
    case 'deny':
    case 'cancel':
    default:
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'approval was not granted' } };
  }
}

export function toOpencode(d: ApprovalDecision): OpencodeReply {
  if (isModification(d)) return 'once'; // opencode has no modification; degrade to allow-once
  switch (d) {
    case 'allow':
      return 'once';
    case 'allow_session':
      return 'always';
    case 'deny':
    case 'cancel':
    default:
      return 'reject';
  }
}

// ---- Codex PreToolUse command hook (#1) ----
// Verified vs openai/codex rust-v0.146.0 hooks/src/events/pre_tool_use.rs + output_parser:
// the hook EMITS on stdout a {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision,...}}.
//   deny  -> {permissionDecision:"deny", permissionDecisionReason:"<why>"}
//   allow -> {permissionDecision:"allow", updatedInput:<tool_input>}  (allow REQUIRES updatedInput;
//            without it codex fails open with "unsupported permissionDecision:allow". Echo the
//            original tool_input unchanged to allow the tool as-is.)
// `ask` is unsupported by codex (fails open) -> never emitted. Exit code 2 + stderr also = deny.
export interface CodexHookResponse {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
    updatedInput?: unknown;
  };
}

/** #1: map a unified ApprovalDecision to a codex PreToolUse hook stdout response. `toolInput`
 *  is the original tool_input (echoed as updatedInput on allow, since codex requires it). */
export function toCodexHook(d: ApprovalDecision, toolInput: unknown): CodexHookResponse {
  if (isModification(d) && d.allowWithModification !== undefined) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: d.allowWithModification } };
  }
  switch (d) {
    case 'allow':
    case 'allow_session':
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: toolInput } };
    case 'deny':
    case 'cancel':
    default:
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'approval was not granted' } };
  }
}

// ---- Pending-approval tracker with fail-closed timeout ----

interface Pending {
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalTracker {
  private pending = new Map<string, Pending>();

  constructor(
    private timeoutSec: number,
    private onResolved: (approvalId: string, decision: ApprovalDecision, timedOut: boolean) => void,
  ) {}

  /** Register a pending approval; auto-resolves 'deny' after timeoutSec. */
  register(approvalId: string, resolve: (d: ApprovalDecision) => void): void {
    const timer = setTimeout(() => {
      if (this.pending.has(approvalId)) {
        log.warn('approval timeout -> fail-closed deny', { approvalId });
        this.doResolve(approvalId, 'deny', true);
      }
    }, this.timeoutSec * 1000);
    // unref so the timer never keeps the process alive alone
    timer.unref?.();
    this.pending.set(approvalId, { resolve, timer });
  }

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    return this.doResolve(approvalId, decision, false);
  }

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  private doResolve(id: string, d: ApprovalDecision, timedOut: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(d);
    this.onResolved(id, d, timedOut);
    return true;
  }

  /** Fail-closed teardown: resolve every still-pending approval as 'deny' so registered
   *  callers (adapter approval promises) don't hang forever. Called on dispose/shutdown. */
  clear(): void {
    for (const id of [...this.pending.keys()]) {
      this.doResolve(id, 'deny', false);
    }
  }
}
