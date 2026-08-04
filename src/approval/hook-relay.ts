// Hidden local helper used by the Codex PreToolUse command hook.
//
// It deliberately talks only to the fixed localhost gateway. Unlike a bare curl command,
// it validates both the request and the hook response. Every transport, timeout, HTTP or
// schema failure exits with code 2 and a non-empty stderr message, which Codex 0.146 treats
// as a blocking PreToolUse result. No response body or secret is written to stderr.
import * as http from 'node:http';
import { readFileSync } from 'node:fs';

const MAX_HOOK_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 16 * 1024;

export interface HookRelayConfig {
  port: number;
  timeoutMs: number;
  secret: string;
  sessionId: string;
}

interface HookSpecificOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason?: string;
  updatedInput?: unknown;
}

interface HookResponse {
  hookSpecificOutput: HookSpecificOutput;
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function failClosed(message: string): Promise<number> {
  try {
    await write(process.stderr, 'blocked: ' + message + '\n');
  } catch {
    // Exit 2 remains the fail-closed signal even if stderr itself is unavailable.
  }
  return 2;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_HOOK_BYTES) {
        process.stdin.pause();
        finish(() => reject(new Error('hook request too large')));
        return;
      }
      body += chunk;
    });
    process.stdin.once('end', () => finish(() => resolve(body)));
    process.stdin.once('error', (error) => finish(() => reject(error)));
  });
}

function isValidResponse(value: unknown): value is HookResponse {
  if (!value || typeof value !== 'object') return false;
  const output = (value as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (!output || typeof output !== 'object') return false;
  const o = output as Record<string, unknown>;
  if (o.hookEventName !== 'PreToolUse') return false;
  if (o.permissionDecision === 'deny') return true;
  // Codex 0.146 rejects allow without updatedInput and then fails open. Require the
  // property itself (null is a valid tool input), not merely a non-undefined value.
  return o.permissionDecision === 'allow' && Object.prototype.hasOwnProperty.call(o, 'updatedInput');
}

function postToGateway(body: string, port: number, secret: string, sessionId: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/hooks/pre-tool-use',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'X-Moyu-Session': sessionId,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        let responseBytes = 0;
        res.once('error', reject);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > MAX_HOOK_BYTES) {
            res.destroy(new Error('hook response too large'));
            return;
          }
          responseBody += chunk;
        });
        res.once('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) reject(new Error('hook gateway returned non-2xx'));
          else resolve(responseBody);
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('hook gateway timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

/** Execute the hidden relay command. Return value is the process exit code. */
export function readHookRelayConfig(path: string): HookRelayConfig {
  if (!path) throw new Error('missing hook descriptor');
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error('hook descriptor too large');
  const value = JSON.parse(text) as Partial<HookRelayConfig>;
  if (!Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535) throw new Error('invalid hook port');
  if (!Number.isFinite(value.timeoutMs) || value.timeoutMs! < 1 || value.timeoutMs! > 600_000) throw new Error('invalid hook timeout');
  if (typeof value.secret !== 'string' || value.secret.length < 32) throw new Error('invalid hook secret');
  if (typeof value.sessionId !== 'string' || !value.sessionId) throw new Error('invalid hook session');
  return value as HookRelayConfig;
}

export async function runHookRelay(configPath: string): Promise<number> {
  let config: HookRelayConfig;
  try {
    config = readHookRelayConfig(configPath);
  } catch {
    return await failClosed('invalid hook identity');
  }
  const { port, secret, sessionId, timeoutMs } = config;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return await failClosed('invalid hook port');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await failClosed('invalid hook timeout');
  if (!secret || !sessionId) return await failClosed('missing hook identity');

  try {
    const body = await readStdin();
    const parsedInput = JSON.parse(body) as Record<string, unknown>;
    if (!parsedInput || typeof parsedInput !== 'object' || parsedInput.hook_event_name !== 'PreToolUse') {
      return await failClosed('invalid hook request');
    }
    const responseText = await postToGateway(body, port, secret, sessionId, Math.ceil(timeoutMs));
    const response = JSON.parse(responseText) as unknown;
    if (!isValidResponse(response)) return await failClosed('invalid hook response');
    await write(process.stdout, JSON.stringify(response));
    return 0;
  } catch {
    return await failClosed('hook relay failed');
  }
}
