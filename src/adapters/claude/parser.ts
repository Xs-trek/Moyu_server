// Claude stream-json NDJSON parser -> AdapterEvent (verified findings §1).
// With --include-partial-messages, content arrives as stream_event content_block_*;
// tool_result arrives in a top-level `user` message; the final `result` line ends the turn.
import type { AdapterEvent, Usage } from '../types';
import { safeFailure } from '../../util/logger';

interface ToolAcc {
  id: string;
  name: string;
  json: string;
  truncated?: boolean;
}

interface CurrentBlock {
  type: string;
  buf: string;
  truncated?: boolean;
  tool?: ToolAcc;
}

const MAX_ACCUMULATED_CHARS = 256 * 1024;
const MAX_TOOL_IMAGES = 4;
const MAX_CONTENT_BLOCKS_SCANNED = 256;
const MAX_IMAGE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024) / 3) * 4;

function appendBounded(current: { buf: string; truncated?: boolean }, chunk: string): void {
  const remaining = MAX_ACCUMULATED_CHARS - current.buf.length;
  if (remaining <= 0) {
    current.truncated = true;
    return;
  }
  current.buf += chunk.slice(0, remaining);
  if (chunk.length > remaining) current.truncated = true;
}

function capText(value: string): string {
  return value.length <= MAX_ACCUMULATED_CHARS
    ? value
    : value.slice(0, MAX_ACCUMULATED_CHARS) + '…[truncated]';
}

function imagePayload(value: unknown): { base64: string; mime: string; name?: string } | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.type !== 'image') return null;
  const source = item.source && typeof item.source === 'object' ? item.source as Record<string, unknown> : undefined;
  const file = item.file && typeof item.file === 'object' ? item.file as Record<string, unknown> : undefined;
  const base64 = source?.data ?? file?.base64 ?? item.data ?? item.base64;
  const mime = source?.media_type ?? source?.mediaType ?? file?.type ?? item.mime_type ?? item.mimeType;
  if (typeof base64 !== 'string' || base64.length > MAX_IMAGE_BASE64_CHARS || typeof mime !== 'string') return null;
  const boundedMime = mime.trim().slice(0, 128);
  if (!boundedMime) return null;
  return {
    base64,
    mime: boundedMime,
    name: typeof item.name === 'string' ? item.name.slice(0, 160) : undefined,
  };
}

export class ClaudeStreamParser {
  private current: CurrentBlock | null = null;
  private done = false;
  private model: string | undefined;

  constructor(private emit: (e: AdapterEvent) => void) {}

  feed(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (o.type) {
      case 'system':
        if (typeof o.model === 'string' && o.model.trim() && o.model !== '<synthetic>') this.model = o.model.trim();
        return; // init
      case 'stream_event':
        this.onStream((o as { event: Record<string, unknown> }).event);
        return;
      case 'assistant': {
        // Full assistant messages duplicate the streamed text, but their metadata is the
        // authoritative runtime model (including provider-compatible alias resolution).
        const message = o.message as { model?: unknown } | undefined;
        if (typeof message?.model === 'string' && message.model.trim() && message.model !== '<synthetic>') {
          this.model = message.model.trim();
        }
        return;
      }
      case 'user':
        this.onUser((o as { message?: { content?: unknown[] } }).message);
        return;
      case 'result':
        this.onResult(o as Record<string, unknown>);
        return;
      default:
        return;
    }
  }

  private onStream(e: Record<string, unknown> | undefined): void {
    if (!e || typeof e.type !== 'string') return;
    if (e.type === 'content_block_start') {
      const cb = e.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (!cb) return;
      if (cb.type === 'tool_use') {
        const acc: ToolAcc = { id: cb.id ?? '', name: cb.name ?? '', json: '' };
        this.current = { type: 'tool_use', buf: '', tool: acc };
      } else {
        this.current = { type: cb.type ?? 'unknown', buf: '' };
      }
    } else if (e.type === 'content_block_delta') {
      const d = e.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
      if (!d || !this.current) return;
      if (d.type === 'text_delta') {
        appendBounded(this.current, d.text ?? '');
        this.emit({ type: 'text.delta', text: d.text ?? '' });
      } else if (d.type === 'thinking_delta') {
        this.emit({ type: 'thinking.delta', text: d.thinking ?? '' });
      } else if (d.type === 'input_json_delta') {
        if (this.current.tool) {
          const holder = { buf: this.current.tool.json, truncated: this.current.tool.truncated };
          appendBounded(holder, d.partial_json ?? '');
          this.current.tool.json = holder.buf;
          this.current.tool.truncated = holder.truncated;
        }
      }
    } else if (e.type === 'content_block_stop') {
      if (!this.current) return;
      if (this.current.type === 'text') {
        this.emit({
          type: 'text.done',
          text: this.current.buf + (this.current.truncated ? '…[truncated]' : ''),
        });
      } else if (this.current.type === 'thinking') {
        this.emit({ type: 'thinking.done' });
      } else if (this.current.type === 'tool_use' && this.current.tool) {
        let input: unknown = {};
        try {
          input = this.current.tool.truncated
            ? { _raw: this.current.tool.json + '…[truncated]', truncated: true }
            : this.current.tool.json ? JSON.parse(this.current.tool.json) : {};
        } catch {
          input = { _raw: this.current.tool.json };
        }
        this.emit({
          type: 'tool.start',
          toolCallId: this.current.tool.id,
          tool: this.current.tool.name,
          input,
        });
      }
      this.current = null;
    }
  }

  private onUser(message: { content?: unknown[] } | undefined): void {
    if (!message || !Array.isArray(message.content)) return;
    for (const c of message.content.slice(0, MAX_CONTENT_BLOCKS_SCANNED)) {
      const r = c as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (r && r.type === 'tool_result' && r.tool_use_id) {
        let text = '';
        if (typeof r.content === 'string') text = capText(r.content);
        else if (Array.isArray(r.content)) {
          for (const item of r.content.slice(0, MAX_CONTENT_BLOCKS_SCANNED)) {
            text = capText(text + ((item as { text?: string })?.text ?? ''));
            if (text.endsWith('…[truncated]')) break;
          }
        }
        this.emit({ type: 'tool.output', toolCallId: r.tool_use_id, text });
        if (Array.isArray(r.content)) {
          let imageCount = 0;
          for (const item of r.content.slice(0, MAX_CONTENT_BLOCKS_SCANNED)) {
            const image = imagePayload(item);
            if (image) {
              this.emit({ type: 'tool.output', toolCallId: r.tool_use_id, ...image });
              if (++imageCount >= MAX_TOOL_IMAGES) break;
            }
          }
        }
        this.emit({ type: 'tool.done', toolCallId: r.tool_use_id, isError: r.is_error === true });
      }
    }
  }

  private onResult(o: Record<string, unknown>): void {
    if (this.done) return;
    this.done = true;
    const usageRaw = o.usage as Record<string, number> | undefined;
    const usage: Usage | undefined = usageRaw
      ? {
          inputTokens: usageRaw.input_tokens,
          outputTokens: usageRaw.output_tokens,
          cacheReadTokens: usageRaw.cache_read_input_tokens,
          cacheWriteTokens: usageRaw.cache_creation_input_tokens,
        }
      : undefined;
    const costUsd = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined;
    if (o.subtype === 'error' || o.is_error) {
      this.emit({ type: 'turn.failed', ...safeFailure(String(o.result ?? 'claude error'), 'claude turn failed') });
    } else {
      this.emit({ type: 'turn.completed', usage, costUsd, model: this.model });
    }
  }
}
