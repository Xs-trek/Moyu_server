// Version-bound Codex CLI protocol contract.
//
// Keep argv/TOML construction and JSONL wire-shape normalization here so a future Codex
// protocol update does not disturb session lifecycle, approval tracking or gateway code.
import { fileURLToPath } from 'node:url';
import type { ApprovalPolicy, ApprovalsReviewer, SandboxMode } from '../../config/schema';
import type { Usage } from '../types';
import type { ReasoningEffort } from '../types';
import { isCompiledBinary } from '../../util/runtime';

export const CODEX_PROTOCOL_MAJOR = 0;
export const CODEX_PROTOCOL_MINOR = 146;

export function isSupportedCodexVersion(output: string | undefined): boolean {
  const match = /\b(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\b/.exec(output ?? '');
  return !!match && Number(match[1]) === CODEX_PROTOCOL_MAJOR && Number(match[2]) === CODEX_PROTOCOL_MINOR;
}

export interface CodexProtocolOptions {
  cwd?: string;
  extraDirs?: string[];
  model?: string;
  effort?: ReasoningEffort;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: ApprovalsReviewer;
  approvalTimeoutSec: number;
  /** Mode-0600 local descriptor consumed by the hidden hook relay. The path, rather than
   * credentials, is placed in the command hook; no moyu variables enter the CLI env. */
  hookConfigPath: string;
}

export interface CodexExecInvocation {
  args: string[];
  stdin: string;
  hookTimeoutSec: number;
  relayTimeoutSec: number;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Build an exact command for both shells. Source mode passes node, tsx and the entry as
 * separate quoted arguments; quote characters are never stored in an env var and therefore
 * cannot become literal argv on POSIX shells. */
export function hookRelayCommands(configPath: string): { unix: string; windows: string } {
  const args = isCompiledBinary()
    ? [process.execPath, 'hook-relay', configPath]
    : [
        process.execPath,
        fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../../index.ts', import.meta.url)),
        'hook-relay',
        configPath,
      ];
  return {
    unix:
      args.map(quotePosix).join(' ') + ' || ' +
      '{ echo "blocked: hook relay unavailable" >&2; exit 2; }',
    windows:
      args.map(quoteCmd).join(' ') + ' || ' +
      '(echo blocked: hook relay unavailable 1>&2 & exit /b 2)',
  };
}

export function relayTimeoutSecFor(approvalTimeoutSec: number): number {
  return approvalTimeoutSec + 10;
}

function hookConfigOverride(approvalTimeoutSec: number, configPath: string): { config: string; hookTimeoutSec: number; relayTimeoutSec: number } {
  // The relay owns network timeout and exits 2 (deny) first. Codex's hook timeout is only a
  // backstop and therefore always has a 20-second margin.
  const relayTimeoutSec = relayTimeoutSecFor(approvalTimeoutSec);
  const hookTimeoutSec = relayTimeoutSec + 20;
  const command = hookRelayCommands(configPath);
  const config =
    `hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",` +
    `command=${JSON.stringify(command.unix)},commandWindows=${JSON.stringify(command.windows)},` +
    `timeout=${hookTimeoutSec}}]}]`;
  return { config, hookTimeoutSec, relayTimeoutSec };
}

/** Build a safe non-interactive invocation. The prompt is always read from stdin (`-`) so it
 * cannot be parsed as an option, leak through the process list, or hit OS argv length limits. */
export function buildCodexExecInvocation(
  opts: CodexProtocolOptions,
  input: { text: string },
  threadId: string | null,
): CodexExecInvocation {
  const hook = hookConfigOverride(opts.approvalTimeoutSec, opts.hookConfigPath);
  const args: string[] = [
    'exec',
    '--strict-config',
    '--json',
    '--dangerously-bypass-hook-trust',
  ];
  if (opts.cwd) args.push('--cd', opts.cwd);
  args.push('--sandbox', opts.sandbox);
  for (const dir of opts.extraDirs ?? []) args.push('--add-dir', dir);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('-c', 'model_reasoning_effort=' + opts.effort);

  // codex exec is headless and forces native approval_policy=never. State that explicitly;
  // gateway approvalPolicy is enforced by the PreToolUse relay. The reviewer setting is still
  // forwarded as adapter configuration, but it never replaces the relay transport.
  args.push('-c', 'approval_policy=never');
  args.push('-c', 'approvals_reviewer=' + opts.approvalsReviewer);
  args.push('-c', 'features.hooks=true');
  args.push('-c', hook.config);

  // Parent exec options must precede the resume subcommand. Only a small subset of flags is
  // global after resume in 0.146.
  if (threadId) args.push('resume', threadId, '-');
  else args.push('-');
  return { args, stdin: input.text, hookTimeoutSec: hook.hookTimeoutSec, relayTimeoutSec: hook.relayTimeoutSec };
}

/** Compatibility wrapper kept for tests/consumers that only inspect argv. */
export function buildCodexExecArgs(
  opts: CodexProtocolOptions,
  input: { text: string },
  threadId: string | null,
): string[] {
  return buildCodexExecInvocation(opts, input, threadId).args;
}

/** Merge the native environment and selected profile. Hook routing is intentionally absent:
 * a normal CLI tool subprocess must not inherit any moyu integration marker or secret. */
export function buildCodexSpawnEnv(profileEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(profileEnv ?? {}),
  };
  if (profileEnv?.CODEX_HOME) {
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith('RD_HOOK_') || key.startsWith('MOYU_') || key === 'REMOTE_DASHBOARD_CONFIG') delete env[key];
  }
  return env;
}

export type NormalizedCodexItem =
  | { kind: 'agent_message'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'command_execution'; id: string; command: string; output: string; status?: string }
  | { kind: 'file_change'; id: string; changes: unknown; status?: string }
  | { kind: 'mcp_tool_call'; id: string; server: string; tool: string; input: unknown; output?: string; status?: string }
  | { kind: 'other'; id: string; wireType: string };

export interface NormalizedCodexEvent {
  type: string;
  threadId?: string;
  usage?: Usage;
  errorText?: string;
  item?: NormalizedCodexItem;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => (typeof part === 'string' ? part : (part as { text?: string })?.text ?? '')).join('');
}

function mapUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const u = value as Record<string, number>;
  return {
    inputTokens: u.input_tokens ?? u.inputTokens,
    outputTokens: u.output_tokens ?? u.outputTokens,
    cacheReadTokens: u.cached_input_tokens ?? u.cached_tokens ?? u.cacheReadTokens,
    cacheWriteTokens: u.cache_write_input_tokens ?? u.cacheWriteTokens,
  };
}

function normalizeItem(raw: unknown): NormalizedCodexItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const wireType = typeof item.type === 'string' ? item.type : '';
  const id = typeof item.id === 'string' ? item.id : '';
  if (wireType === 'agent_message' || wireType === 'message') {
    return { kind: 'agent_message', id, text: (item.text as string) ?? extractText(item.content) ?? '' };
  }
  if (wireType === 'reasoning') return { kind: 'reasoning', id, text: String(item.text ?? '') };
  if (wireType === 'command_execution') {
    return {
      kind: 'command_execution',
      id,
      command: String(item.command ?? ''),
      output: String(item.aggregated_output ?? item.aggregatedOutput ?? ''),
      status: typeof item.status === 'string' ? item.status : undefined,
    };
  }
  if (wireType === 'file_change') {
    return { kind: 'file_change', id, changes: item.changes ?? item, status: item.status as string | undefined };
  }
  if (wireType === 'mcp_tool_call') {
    const result = item.result ?? item.error;
    return {
      kind: 'mcp_tool_call',
      id,
      server: String(item.server ?? ''),
      tool: String(item.tool ?? ''),
      input: item.arguments ?? {},
      output: result === undefined ? undefined : JSON.stringify(result),
      status: item.status as string | undefined,
    };
  }
  return { kind: 'other', id, wireType };
}

export function decodeCodexLine(line: string): NormalizedCodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) return null;
  const event: NormalizedCodexEvent = { type };
  if (type === 'thread.started') event.threadId = String(raw.thread_id ?? raw.threadId ?? '');
  if (type === 'turn.completed' || type === 'task.completed') event.usage = mapUsage(raw.usage ?? raw.tokenUsage);
  if (type === 'turn.failed') {
    const error = raw.error;
    const message =
      error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : undefined;
    event.errorText =
      typeof error === 'string'
        ? error
        : message ?? (typeof raw.message === 'string' ? raw.message : 'turn failed');
  }
  if (type.startsWith('item.')) event.item = normalizeItem(raw.item);
  return event;
}
