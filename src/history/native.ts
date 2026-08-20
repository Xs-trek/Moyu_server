// Bounded, read-only discovery and normalization of native Claude/Codex JSONL histories.
// Nothing in this module writes to a native CLI directory.
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountService } from '../accounts/service';
import type { Message } from '../adapters/types';
import { effectiveConfigDir, resolveEffectiveModel } from '../adapters/effective-model';
import type { AppConfig } from '../config/schema';

export type NativeHistoryKind = 'claude' | 'codex';

export interface NativeSessionItem {
  nativeSessionId: string;
  kind: NativeHistoryKind;
  title: string;
  cwd?: string;
  model?: string;
  updatedAt: string;
  messageCount: number;
  resumable: true;
}

export interface NativeSessionList {
  items: NativeSessionItem[];
  /** Opaque candidate cursor; clients must echo it rather than deriving it from item count. */
  nextOffset: number;
  hasMore: boolean;
  generatedAt: string;
}

export interface NativeMessagesPage {
  items: Message[];
  latestSeq: number;
  hasMore: boolean;
  nextAfter: number;
  generatedAt: string;
}

export interface NativeSelection {
  kind: NativeHistoryKind;
  configDir: string;
  profileId: string;
  profileEnv: Record<string, string>;
  effectiveModel?: string;
}

export interface NativeSessionRecord {
  item: NativeSessionItem;
  messages: Message[];
  selection: NativeSelection;
}

interface NativeFileRef {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

interface ParsedHistory {
  title?: string;
  cwd?: string;
  model?: string;
  messages: Message[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_FILE_RE = new RegExp(`(${UUID})\\.jsonl$`, 'i');
const MAX_DISCOVERED_FILES = 2_000;
/** Two selected adapters can each contribute at most MAX_DISCOVERED_FILES candidates. */
export const MAX_NATIVE_LIST_OFFSET = MAX_DISCOVERED_FILES * 2;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 6;
const MAX_LIST_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_LINES = 100_000;
const MAX_NORMALIZED_MESSAGES = 5_000;
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_MESSAGE_TEXT_CHARS = 256 * 1024;

function capText(value: string): string {
  return value.length <= MAX_MESSAGE_TEXT_CHARS
    ? value
    : value.slice(0, MAX_MESSAGE_TEXT_CHARS) + '…[truncated]';
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return capText(value);
  try {
    return capText(JSON.stringify(value));
  } catch {
    return '[unserializable]';
  }
}

function boundedUnknown(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= MAX_MESSAGE_TEXT_CHARS) return value;
    return { truncated: true, preview: encoded.slice(0, MAX_MESSAGE_TEXT_CHARS) };
  } catch {
    return { truncated: true, preview: '[unserializable]' };
  }
}

function timestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function mergeContent(previous: string | undefined, next: string): string {
  next = capText(next);
  if (!previous) return next;
  if (next === previous || previous.endsWith(next)) return previous;
  if (next.startsWith(previous)) return next;
  return capText(previous + next);
}

function titleFrom(messages: Message[]): string | undefined {
  const text = messages.find((message) => message.role === 'user' && message.text?.trim())?.text?.trim();
  return text ? text.slice(0, 80) : undefined;
}

function resequence(messages: Message[]): Message[] {
  // Native files are append-only histories. When the bounded view overflows, retain the newest
  // normalized messages so opening and resuming a long session cannot silently stop in its past.
  // Re-number the retained window from one: the native messages API and SessionManager's seeded
  // resume history both use this same bounded snapshot, so their cursors remain interchangeable.
  return messages.slice(-MAX_NORMALIZED_MESSAGES).map((message, index) => ({ ...message, seq: index + 1 }));
}

async function readPrefix(path: string, size: number, maxBytes: number): Promise<string> {
  const bytes = Math.min(size, maxBytes);
  if (bytes <= 0) return '';
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (size > bytesRead) {
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline >= 0 ? text.slice(0, lastNewline) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}

/** Read the newest bounded JSONL window without ever returning a partial first line.
 *
 * One byte immediately before the desired window tells us whether it starts on an LF boundary.
 * If it does not, discard through the next LF. This also prevents a split UTF-8 character in the
 * truncated fragment from leaking into JSON parsing. The EOF side is left intact: JSONL permits a
 * valid final record without a trailing newline, while an in-progress/invalid final record is
 * already ignored by the per-line JSON parser.
 */
async function readJsonlTail(path: string, size: number, maxBytes: number): Promise<string> {
  const bytes = Math.min(size, maxBytes);
  if (bytes <= 0) return '';
  const desiredStart = Math.max(0, size - bytes);
  const readStart = desiredStart > 0 ? desiredStart - 1 : 0;
  const requested = bytes + (desiredStart > 0 ? 1 : 0);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(requested);
    let bytesRead = 0;
    while (bytesRead < requested) {
      const result = await handle.read(buffer, bytesRead, requested - bytesRead, readStart + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead === 0) return '';

    const hasBoundaryByte = desiredStart > 0;
    const startsAtLineBoundary = !hasBoundaryByte || buffer[0] === 0x0a;
    const payloadStart = hasBoundaryByte ? 1 : 0;
    let text = buffer.subarray(payloadStart, bytesRead).toString('utf8');
    if (!startsAtLineBoundary) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function walkJsonl(root: string, depth: number, out: NativeFileRef[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH || out.length >= MAX_DISCOVERED_FILES) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    if (out.length >= MAX_DISCOVERED_FILES) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(path, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const match = UUID_FILE_RE.exec(entry.name);
    if (!match?.[1]) continue;
    try {
      const info = await stat(path);
      out.push({ id: match[1].toLowerCase(), path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // File removed between readdir and stat: ignore this snapshot race.
    }
  }
}

async function discoverFiles(selection: NativeSelection): Promise<NativeFileRef[]> {
  const refs: NativeFileRef[] = [];
  if (selection.kind === 'claude') {
    await walkJsonl(join(selection.configDir, 'projects'), 0, refs);
  } else {
    await walkJsonl(join(selection.configDir, 'sessions'), 0, refs);
    await walkJsonl(join(selection.configDir, 'archived_sessions'), 0, refs);
  }
  const unique = new Map<string, NativeFileRef>();
  for (const ref of refs) {
    const existing = unique.get(ref.id);
    if (!existing || ref.mtimeMs > existing.mtimeMs) unique.set(ref.id, ref);
  }
  return [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function claudeTextParts(content: unknown): { text: string; thinking: string } {
  if (typeof content === 'string') return { text: content, thinking: '' };
  if (!Array.isArray(content)) return { text: '', thinking: '' };
  let text = '';
  let thinking = '';
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') text += part.text;
    if (part.type === 'thinking' && typeof part.thinking === 'string') thinking += part.thinking;
  }
  return { text, thinking };
}

function parseClaude(lines: string[], fallbackTime: string): ParsedHistory {
  const messages: Message[] = [];
  const assistantById = new Map<string, Message>();
  const toolsById = new Map<string, Message>();
  let title: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;

  const add = (message: Omit<Message, 'seq'>): Message => {
    const full = { ...message, seq: messages.length + 1 };
    messages.push(full);
    return full;
  };

  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const createdAt = timestamp(raw.timestamp, fallbackTime);
    if (typeof raw.cwd === 'string' && raw.cwd) cwd = raw.cwd;
    if (raw.type === 'ai-title' && typeof raw.aiTitle === 'string' && raw.aiTitle.trim()) {
      title = raw.aiTitle.trim().slice(0, 160);
      continue;
    }
    if (raw.type !== 'user' && raw.type !== 'assistant') continue;
    if (raw.isMeta === true) continue;
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const content = message.content;
    if (raw.type === 'user') {
      const parts = claudeTextParts(content);
      if (parts.text.trim()) add({ role: 'user', text: capText(parts.text), createdAt });
      if (Array.isArray(content)) {
        for (const value of content) {
          if (!value || typeof value !== 'object') continue;
          const part = value as Record<string, unknown>;
          if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
          const existing = toolsById.get(part.tool_use_id);
          const output = Array.isArray(part.content)
            ? part.content.map((item) => (item as { text?: unknown })?.text).filter((item): item is string => typeof item === 'string').join('')
            : jsonText(part.content ?? '');
          if (existing) existing.toolOutput = mergeContent(existing.toolOutput, output);
          else {
            const toolMessage = add({ role: 'tool', toolCallId: part.tool_use_id, toolOutput: capText(output), createdAt });
            toolsById.set(part.tool_use_id, toolMessage);
          }
        }
      }
      continue;
    }

    if (typeof message.model === 'string' && message.model.trim() && message.model !== '<synthetic>') {
      model = message.model.trim();
    }
    const nativeId = typeof message.id === 'string' ? message.id : String(raw.uuid ?? `assistant-${messages.length}`);
    const parts = claudeTextParts(content);
    if (parts.text || parts.thinking) {
      let existing = assistantById.get(nativeId);
      if (!existing) {
        existing = add({ role: 'assistant', createdAt });
        assistantById.set(nativeId, existing);
      }
      if (parts.text) existing.text = mergeContent(existing.text, parts.text);
      if (parts.thinking) existing.thinking = mergeContent(existing.thinking, parts.thinking);
    }
    if (Array.isArray(content)) {
      for (const value of content) {
        if (!value || typeof value !== 'object') continue;
        const part = value as Record<string, unknown>;
        if (part.type !== 'tool_use' || typeof part.id !== 'string') continue;
        if (toolsById.has(part.id)) continue;
        const toolMessage = add({
          role: 'tool',
          toolCallId: part.id,
          tool: typeof part.name === 'string' ? part.name : 'tool',
          toolInput: boundedUnknown(part.input ?? {}),
          createdAt,
        });
        toolsById.set(part.id, toolMessage);
      }
    }
  }
  const normalized = resequence(messages);
  return { title: title ?? titleFrom(normalized), cwd, model, messages: normalized };
}

function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const value of content) {
    if (typeof value === 'string') text += value;
    else if (value && typeof value === 'object') {
      const part = value as Record<string, unknown>;
      if (typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

function parseCodex(lines: string[], fallbackTime: string, indexedTitle?: string): ParsedHistory {
  const messages: Message[] = [];
  const tools = new Map<string, Message>();
  let cwd: string | undefined;
  let model: string | undefined;
  const add = (message: Omit<Message, 'seq'>): Message => {
    const full = { ...message, seq: messages.length + 1 };
    messages.push(full);
    return full;
  };

  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = raw.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    const createdAt = timestamp(raw.timestamp, fallbackTime);
    if (raw.type === 'session_meta' || raw.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
      if (typeof payload.model === 'string' && payload.model.trim()) model = payload.model.trim();
      continue;
    }
    if (raw.type !== 'response_item' || typeof payload.type !== 'string') continue;
    if (payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text = codexContentText(payload.content);
      if (text.trim()) add({ role: payload.role, text: capText(text), createdAt });
      continue;
    }
    if (payload.type === 'reasoning') {
      const thinking = codexContentText(payload.summary);
      if (thinking.trim()) add({ role: 'assistant', thinking: capText(thinking), createdAt });
      continue;
    }
    const type = payload.type;
    const isCall = type.endsWith('_call') || type === 'function_call' || type === 'mcp_tool_call';
    const isOutput = type.endsWith('_output') || type.endsWith('_call_output');
    const callId = String(payload.call_id ?? payload.id ?? '');
    if (isCall && callId) {
      const name = String(payload.name ?? payload.tool ?? payload.server ?? type);
      const toolMessage = add({
        role: 'tool',
        toolCallId: callId,
        tool: name,
        toolInput: boundedUnknown(payload.input ?? payload.arguments ?? {}),
        createdAt,
      });
      tools.set(callId, toolMessage);
      continue;
    }
    if (isOutput && callId) {
      const output = jsonText(payload.output ?? payload.result ?? payload.error ?? '');
      const existing = tools.get(callId);
      if (existing) existing.toolOutput = mergeContent(existing.toolOutput, output);
      else {
        const toolMessage = add({ role: 'tool', toolCallId: callId, toolOutput: output, createdAt });
        tools.set(callId, toolMessage);
      }
    }
  }
  const normalized = resequence(messages);
  return { title: indexedTitle?.trim() || titleFrom(normalized), cwd, model, messages: normalized };
}

async function codexTitles(configDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const path = join(configDir, 'session_index.jsonl');
  let info;
  try {
    info = await stat(path);
  } catch {
    return result;
  }
  const text = await readPrefix(path, info.size, 2 * 1024 * 1024);
  for (const line of text.split(/\r?\n/).slice(0, MAX_JSONL_LINES)) {
    if (!line || line.length > MAX_LINE_CHARS) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof value.id === 'string' && typeof value.thread_name === 'string' && value.thread_name.trim()) {
        result.set(value.id.toLowerCase(), value.thread_name.trim().slice(0, 160));
      }
    } catch {
      // Bad index line does not invalidate the remaining native history.
    }
  }
  return result;
}

async function parseFile(
  selection: NativeSelection,
  ref: NativeFileRef,
  maxBytes: number,
  indexedTitle?: string,
): Promise<ParsedHistory> {
  const fallbackTime = new Date(ref.mtimeMs).toISOString();
  const text = await readJsonlTail(ref.path, ref.size, maxBytes);
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && line.length <= MAX_LINE_CHARS)
    .slice(-MAX_JSONL_LINES);
  return selection.kind === 'claude'
    ? parseClaude(lines, fallbackTime)
    : parseCodex(lines, fallbackTime, indexedTitle);
}

export function resolveNativeSelection(
  kind: NativeHistoryKind,
  config: AppConfig,
  accounts: AccountService,
): NativeSelection {
  const profile = accounts.selectedProfile(kind, undefined, config);
  const profileEnv = accounts.resolveEnv(profile);
  const configuredDir = config.adapters[kind].configDir;
  return {
    kind,
    configDir: effectiveConfigDir(kind, configuredDir, profileEnv),
    profileId: profile.id,
    profileEnv,
    effectiveModel: resolveEffectiveModel(kind, config, profileEnv),
  };
}

interface NativeListCandidate {
  selection: NativeSelection;
  ref: NativeFileRef;
}

function compareNativeCandidates(a: NativeListCandidate, b: NativeListCandidate): number {
  if (a.ref.mtimeMs !== b.ref.mtimeMs) return b.ref.mtimeMs - a.ref.mtimeMs;
  const kind = a.selection.kind.localeCompare(b.selection.kind);
  if (kind !== 0) return kind;
  const id = a.ref.id.localeCompare(b.ref.id);
  return id !== 0 ? id : a.ref.path.localeCompare(b.ref.path);
}

async function parseListCandidate(
  candidate: NativeListCandidate,
  codexTitlesById: ReadonlyMap<string, string>,
): Promise<NativeSessionItem | null> {
  const { selection, ref } = candidate;
  try {
    const parsed = await parseFile(
      selection,
      ref,
      MAX_LIST_FILE_BYTES,
      selection.kind === 'codex' ? codexTitlesById.get(ref.id) : undefined,
    );
    return {
      nativeSessionId: ref.id,
      kind: selection.kind,
      title: parsed.title || `${selection.kind} ${ref.id.slice(0, 8)}`,
      cwd: parsed.cwd,
      model: parsed.model ?? selection.effectiveModel,
      updatedAt: new Date(ref.mtimeMs).toISOString(),
      messageCount: parsed.messages.length,
      resumable: true,
    };
  } catch {
    // A disappearing/unreadable history file is omitted; discovery remains best-effort.
    return null;
  }
}

export async function listNativeSessions(
  config: AppConfig,
  accounts: AccountService,
  limit: number,
  offset = 0,
): Promise<NativeSessionList> {
  const selections = (['claude', 'codex'] as const).map((kind) => resolveNativeSelection(kind, config, accounts));
  const groups = await Promise.all(selections.map(async (selection) =>
    (await discoverFiles(selection)).map((ref): NativeListCandidate => ({ selection, ref }))));
  const candidates = groups.flat().sort(compareNativeCandidates);
  if (offset >= candidates.length) {
    return { items: [], nextOffset: offset, hasMore: false, generatedAt: new Date().toISOString() };
  }
  const codexSelection = selections.find((selection) => selection.kind === 'codex')!;
  const titles = await codexTitles(codexSelection.configDir);
  const items: NativeSessionItem[] = [];
  let cursor = offset;
  while (cursor < candidates.length && items.length < limit) {
    const item = await parseListCandidate(candidates[cursor++]!, titles);
    if (item) items.push(item);
  }
  const nextOffset = cursor;
  let hasMore = false;
  // Probe only until the next readable record. This keeps hasMore truthful without parsing every
  // older history file; the returned nextOffset still points before that lookahead candidate.
  while (cursor < candidates.length) {
    if (await parseListCandidate(candidates[cursor++]!, titles)) {
      hasMore = true;
      break;
    }
  }
  return { items, nextOffset, hasMore, generatedAt: new Date().toISOString() };
}

export async function readNativeSession(
  kind: NativeHistoryKind,
  nativeSessionId: string,
  config: AppConfig,
  accounts: AccountService,
): Promise<NativeSessionRecord | null> {
  const id = nativeSessionId.toLowerCase();
  if (!new RegExp(`^${UUID}$`, 'i').test(id)) return null;
  const selection = resolveNativeSelection(kind, config, accounts);
  const ref = (await discoverFiles(selection)).find((candidate) => candidate.id === id);
  if (!ref) return null;
  const titleMap = kind === 'codex' ? await codexTitles(selection.configDir) : new Map<string, string>();
  const parsed = await parseFile(selection, ref, MAX_MESSAGE_FILE_BYTES, titleMap.get(id));
  return {
    selection,
    messages: parsed.messages,
    item: {
      nativeSessionId: id,
      kind,
      title: parsed.title || `${kind} ${id.slice(0, 8)}`,
      cwd: parsed.cwd,
      model: parsed.model ?? selection.effectiveModel,
      updatedAt: new Date(ref.mtimeMs).toISOString(),
      messageCount: parsed.messages.length,
      resumable: true,
    },
  };
}

export function pageNativeMessages(record: NativeSessionRecord, after: number, limit: number): NativeMessagesPage {
  const matching = record.messages.filter((message) => message.seq > after);
  const items = matching.slice(0, limit);
  const latestSeq = record.messages.at(-1)?.seq ?? 0;
  return {
    items,
    latestSeq,
    hasMore: matching.length > items.length,
    nextAfter: items.at(-1)?.seq ?? after,
    generatedAt: new Date().toISOString(),
  };
}
