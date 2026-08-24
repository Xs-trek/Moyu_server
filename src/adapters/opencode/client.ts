// Minimal client for the official OpenCode Server API. This deliberately stays inside the
// OpenCode bridge: it is not a provider SDK and it never contacts a model provider directly.

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_SSE_FRAME_CHARS = 2 * 1024 * 1024;
const REST_TIMEOUT_MS = 10_000;

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  directory: string;
  title: string;
  version?: string;
  time: { created: number; updated: number };
}

export interface OpenCodeProjectInfo {
  id: string;
  worktree: string;
}

export interface OpenCodePathInfo {
  directory: string;
  worktree: string;
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number; completed?: number };
  model?: { providerID?: string; modelID?: string };
  providerID?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
  error?: unknown;
}

export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status?: 'pending' | 'running' | 'completed' | 'error' | string;
    input?: unknown;
    output?: string;
    error?: string;
    title?: string;
  };
}

export interface OpenCodeMessageRecord {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodeGlobalEvent {
  directory: string;
  payload: {
    type: string;
    properties?: Record<string, unknown>;
  };
}

export interface OpenCodePromptBody {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
}

function isIpv4Loopback(hostname: string): boolean {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece))) return false;
  const nums = pieces.map(Number);
  return nums.every((value) => value >= 0 && value <= 255) && nums[0] === 127;
}

/** Enforce the 0-perception boundary: OpenCode control traffic may target only a local server.
 * Redirects are disabled separately so a compromised local server cannot bounce a request to a
 * provider or arbitrary LAN host. */
export function normalizeLoopbackServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenCode serverUrl must be an absolute HTTP URL');
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || isIpv4Loopback(hostname);
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error('OpenCode serverUrl must use HTTP on loopback');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OpenCode serverUrl must not contain credentials, query, or fragment');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('OpenCode serverUrl must target the server root');
  }
  url.pathname = '/';
  return url.toString().replace(/\/$/, '');
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new Error('OpenCode response exceeded size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_JSON_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw new Error('OpenCode response exceeded size limit');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly authorization?: string;

  constructor(baseUrl: string, username = 'opencode', password?: string) {
    this.baseUrl = normalizeLoopbackServerUrl(baseUrl);
    if (password) this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  private url(path: string, directory?: string): string {
    const url = new URL(path, `${this.baseUrl}/`);
    if (directory) url.searchParams.set('directory', directory);
    return url.toString();
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.authorization ? { authorization: this.authorization } : {}),
    };
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { directory?: string; body?: unknown; signal?: AbortSignal; allowEmpty?: boolean } = {},
  ): Promise<T> {
    // Ordinary Server API calls are finite. In particular, one hung health request must not
    // defeat the runtime's readiness deadline. The global SSE stream deliberately keeps only
    // its caller-owned AbortSignal and does not use this timeout.
    const timeoutSignal = AbortSignal.timeout(REST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(this.url(path, opts.directory), {
      method,
      headers: this.headers(opts.body !== undefined),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      // Never surface the response body: upstream errors may include prompts, paths, provider
      // diagnostics, or credentials. Status + operation are sufficient for the public failure.
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new Error(`OpenCode Server API ${method} ${path} failed (${response.status})`);
    }
    if (opts.allowEmpty && (response.status === 204 || response.headers.get('content-length') === '0')) {
      return undefined as T;
    }
    const text = await boundedResponseText(response);
    if (!text && opts.allowEmpty) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`OpenCode Server API ${method} ${path} returned invalid JSON`);
    }
  }

  health(signal?: AbortSignal): Promise<OpenCodeHealth> {
    return this.request('GET', '/global/health', { signal });
  }

  listSessions(directory?: string): Promise<OpenCodeSessionInfo[]> {
    return this.request('GET', '/session', { directory });
  }

  listProjects(): Promise<OpenCodeProjectInfo[]> {
    return this.request('GET', '/project');
  }

  getPath(): Promise<OpenCodePathInfo> {
    return this.request('GET', '/path');
  }

  createSession(directory: string, title?: string): Promise<OpenCodeSessionInfo> {
    return this.request('POST', '/session', { directory, body: title ? { title } : {} });
  }

  getSession(id: string, directory?: string): Promise<OpenCodeSessionInfo> {
    return this.request('GET', `/session/${encodeURIComponent(id)}`, { directory });
  }

  listMessages(id: string, directory?: string): Promise<OpenCodeMessageRecord[]> {
    return this.request('GET', `/session/${encodeURIComponent(id)}/message`, { directory });
  }

  async promptAsync(
    id: string,
    directory: string,
    input: { text: string },
    model?: { providerID: string; modelID: string },
  ): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(id)}/prompt_async`, {
      directory,
      body: buildOpenCodePrompt(input, model),
      allowEmpty: true,
    });
  }

  abort(id: string, directory?: string): Promise<boolean> {
    return this.request('POST', `/session/${encodeURIComponent(id)}/abort`, { directory, body: {} });
  }

  replyPermission(
    sessionId: string,
    permissionId: string,
    response: 'once' | 'always' | 'reject',
    directory?: string,
  ): Promise<boolean> {
    return this.request('POST', `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      directory,
      body: { response },
    });
  }

  async globalEvents(
    signal: AbortSignal,
    onEvent: (event: OpenCodeGlobalEvent) => void,
    onOpen?: () => void,
  ): Promise<void> {
    const response = await fetch(this.url('/global/event'), {
      headers: { ...this.headers(), accept: 'text/event-stream' },
      signal,
      redirect: 'error',
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new Error(`OpenCode global event stream failed (${response.status})`);
    }
    onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        if (block.length > MAX_SSE_FRAME_CHARS) throw new Error('OpenCode SSE frame exceeded size limit');
        const separator = pending.slice(boundary).startsWith('\r\n\r\n') ? 4 : 2;
        pending = pending.slice(boundary + separator);
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          try {
            const event = JSON.parse(data) as OpenCodeGlobalEvent;
            if (event && typeof event.directory === 'string' && event.payload && typeof event.payload.type === 'string') {
              onEvent(event);
            }
          } catch {
            // A malformed event cannot relax an approval; ignore it and keep the stream alive.
          }
        }
        boundary = pending.search(/\r?\n\r?\n/);
      }
      if (pending.length > MAX_SSE_FRAME_CHARS) throw new Error('OpenCode SSE frame exceeded size limit');
    }
  }
}

export function parseOpenCodeModel(model?: string): { providerID: string; modelID: string } | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error('OpenCode model must use provider/model format');
  }
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

/** Pure provider-surface projection. Only the user-authored text and explicitly mapped model
 * enter the official prompt body; wider frontend/device/transport objects are ignored. */
export function buildOpenCodePrompt(
  input: { text: string },
  model?: { providerID: string; modelID: string },
): OpenCodePromptBody {
  return {
    parts: [{ type: 'text', text: input.text }],
    ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
  };
}
