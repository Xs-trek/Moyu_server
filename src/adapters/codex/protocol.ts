// Version-bound Codex CLI protocol contract.
//
// Keep argv/TOML construction and JSONL wire-shape normalization here so a future Codex
// protocol update does not disturb session lifecycle, approval tracking or gateway code.
import type { ApprovalPolicy, ApprovalsReviewer, SandboxMode } from '../../config/schema';
import type { Usage } from '../types';
import type { ReasoningEffort } from '../types';
import { hookRelayCommands, relayTimeoutSecFor } from '../../approval/hook-command';
import { scrubMoyuEnv } from '../../util/runtime';

export { hookRelayCommands, hookRelayExec, relayTimeoutSecFor } from '../../approval/hook-command';

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
  /** Mode-0600 local descriptor consumed by the hidden local check. The path, rather than
   * credentials, is placed in the command hook; no moyu variables enter the CLI env. */
  hookConfigPath: string;
}

export interface CodexExecInvocation {
  args: string[];
  stdin: string;
  hookTimeoutSec: number;
  relayTimeoutSec: number;
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
  input: { text: string; attachments?: { path?: string }[] },
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
  // local approvalPolicy is enforced by the PreToolUse check. The reviewer setting is still
  // forwarded as adapter configuration, but it never replaces the relay transport.
  args.push('-c', 'approval_policy=never');
  args.push('-c', 'approvals_reviewer=' + opts.approvalsReviewer);
  args.push('-c', 'features.hooks=true');
  args.push('-c', hook.config);

  // Parent exec options must precede the resume subcommand. Only a small subset of flags is
  // global after resume in 0.146.
  const imagePaths = (input.attachments ?? []).flatMap((attachment) => attachment.path ? [attachment.path] : []);
  if (threadId) {
    args.push('resume', threadId);
    // In Codex 0.146 `resume --image` belongs to ResumeArgs (not the parent exec parser).
    for (const path of imagePaths) args.push('--image', path);
    args.push('-');
  } else {
    // New-turn images are part of SharedCliOptions and must precede the stdin prompt marker.
    for (const path of imagePaths) args.push('--image', path);
    args.push('-');
  }
  return { args, stdin: input.text, hookTimeoutSec: hook.hookTimeoutSec, relayTimeoutSec: hook.relayTimeoutSec };
}

/** Compatibility wrapper kept for tests/consumers that only inspect argv. */
export function buildCodexExecArgs(
  opts: CodexProtocolOptions,
  input: { text: string; attachments?: { path?: string }[] },
  threadId: string | null,
): string[] {
  return buildCodexExecInvocation(opts, input, threadId).args;
}

/** Merge the native environment and selected profile. Hook routing is intentionally absent:
 * a normal CLI tool subprocess must not inherit any moyu integration marker or secret. */
export function buildCodexSpawnEnv(
  profileEnv: Record<string, string> | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
  childCwd?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  if (profileEnv?.CODEX_HOME) {
    // A selected CODEX_HOME is an account boundary. Remove standard inherited credentials
    // before applying the selected *.home values so OAuth/API-key profiles cannot be silently
    // overridden by the shell that launched the daemon.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  }
  Object.assign(env, profileEnv ?? {});
  return scrubMoyuEnv(env, undefined, childCwd);
}

export interface NormalizedCodexImage {
  base64: string;
  mime: string;
  name?: string;
}

export type NormalizedCodexItem =
  | { kind: 'agent_message'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'command_execution'; id: string; command: string; output: string; status?: string }
  | { kind: 'file_change'; id: string; changes: unknown; status?: string }
  | { kind: 'mcp_tool_call'; id: string; server: string; tool: string; input: unknown; output?: string; images?: NormalizedCodexImage[]; status?: string }
  | { kind: 'other'; id: string; wireType: string; input: unknown; output?: string; images?: NormalizedCodexImage[]; status?: string };

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

const MAX_TOOL_IMAGES = 4;
const MAX_CONTENT_BLOCKS_SCANNED = 256;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024) / 3) * 4;
const MAX_IMAGE_MIME_CHARS = 128;
const MAX_IMAGE_NAME_CHARS = 160;

function contentBlocks(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const content = (value as Record<string, unknown>).content;
  return Array.isArray(content) ? content : undefined;
}

/** Extract only the standard in-band image shape. MIME support and canonical base64/magic-byte
 * validation remain the ArtifactStore's responsibility so unsupported blocks degrade locally. */
function extractToolImages(...values: unknown[]): NormalizedCodexImage[] | undefined {
  const images: NormalizedCodexImage[] = [];
  let scanned = 0;
  for (const value of values) {
    const blocks = contentBlocks(value);
    if (!blocks) continue;
    for (const block of blocks) {
      if (scanned++ >= MAX_CONTENT_BLOCKS_SCANNED || images.length >= MAX_TOOL_IMAGES) break;
      if (!block || typeof block !== 'object') continue;
      const image = block as Record<string, unknown>;
      if (image.type !== 'image') continue;
      const base64 = typeof image.data === 'string'
        ? image.data
        : typeof image.base64 === 'string'
          ? image.base64
          : undefined;
      const mimeValue = typeof image.mimeType === 'string'
        ? image.mimeType
        : typeof image.mime_type === 'string'
          ? image.mime_type
          : undefined;
      if (!base64 || base64.length > MAX_IMAGE_BASE64_CHARS || !mimeValue) continue;
      const mime = mimeValue.trim().slice(0, MAX_IMAGE_MIME_CHARS);
      if (!mime) continue;
      const rawName = typeof image.name === 'string'
        ? image.name
        : typeof image.filename === 'string'
          ? image.filename
          : undefined;
      const name = rawName?.slice(0, MAX_IMAGE_NAME_CHARS);
      images.push({ base64, mime, ...(name ? { name } : {}) });
    }
    if (scanned >= MAX_CONTENT_BLOCKS_SCANNED || images.length >= MAX_TOOL_IMAGES) break;
  }
  return images.length ? images : undefined;
}

/** Preserve the prior JSON text output for non-image results, but never copy a large in-band
 * base64 payload into the text event/replay ring after it has been extracted as an artifact. */
function withoutImagePayloads(value: unknown): unknown {
  const blocks = contentBlocks(value);
  if (!blocks) return value;
  const content = blocks.map((block) => {
    if (!block || typeof block !== 'object' || (block as Record<string, unknown>).type !== 'image') return block;
    const copy = { ...(block as Record<string, unknown>) };
    delete copy.data;
    delete copy.base64;
    return copy;
  });
  if (Array.isArray(value)) return content;
  return { ...(value as Record<string, unknown>), content };
}

function stringifyToolOutput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(withoutImagePayloads(value));
  } catch {
    return '[unserializable output]';
  }
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
      output: stringifyToolOutput(result),
      images: extractToolImages(item.result, item.output),
      status: item.status as string | undefined,
    };
  }
  // Codex adds item types over time. Preserve unknown tool-like items as a generic unified tool
  // instead of silently dropping them; known message/reasoning shapes were handled above.
  const outputValue = item.output ?? item.result ?? item.error ?? item.aggregated_output ?? item.aggregatedOutput;
  let output: string | undefined;
  if (typeof outputValue === 'string') output = outputValue;
  else output = stringifyToolOutput(outputValue);
  const inputValue = item.input ?? item.arguments ?? (() => {
    const copy: Record<string, unknown> = { ...item };
    for (const key of ['id', 'type', 'status', 'output', 'result', 'error', 'aggregated_output', 'aggregatedOutput']) delete copy[key];
    return copy;
  })();
  return {
    kind: 'other',
    id,
    wireType: wireType || 'unknown_item',
    input: inputValue,
    output,
    images: extractToolImages(item.output, item.result),
    status: typeof item.status === 'string' ? item.status : undefined,
  };
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
