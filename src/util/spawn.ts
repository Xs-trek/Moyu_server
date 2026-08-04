// Process spawning helpers. CLI adapters use child_process directly for streaming;
// these cover one-shot probes (availability/detect) and PATH lookup.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { isWindows } from './platform';

/** Locate an executable in PATH. Returns absolute path or null. */
export function which(cmd: string): string | null {
  const sep = isWindows ? ';' : ':';
  const pathEnv = process.env.PATH ?? '';
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try {
        accessSync(p, isWindows ? constants.F_OK : constants.X_OK);
        return p;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export interface RunOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  shell?: boolean;
  stdin?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, buffering stdout/stderr. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      shell: opts.shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // [L]⑤: cap one-shot probe output (was unbounded accumulation)
    let capped = false;
    child.stdout?.on('data', (d: Buffer) => {
      if (capped) return;
      stdout += d.toString('utf8');
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n[...truncated...]';
        capped = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (capped) return;
      stderr += d.toString('utf8');
      if (stderr.length > MAX_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n[...truncated...]';
        capped = true;
        child.kill('SIGKILL');
      }
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
    const timer = opts.timeout
      ? setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 1000);
        }, opts.timeout)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Probe whether a CLI is installed by running `<cmd> --version`. */
export async function probeVersion(cmd: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const r = await run(cmd, ['--version'], { timeout: 8000 });
    if (r.code === 0 || r.stdout || r.stderr) {
      const v = (r.stdout || r.stderr).trim().split('\n')[0];
      return { ok: true, version: v || undefined };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Async iterate over bounded NDJSON lines. A broken CLI must not grow an unterminated line
 * without limit; exceeding the cap fails the turn and lets the adapter terminate its process. */
export async function* readLines(stream: Readable, maxLineChars = 2 * 1024 * 1024): AsyncIterable<string> {
  stream.setEncoding('utf8');
  let pending = '';
  for await (const raw of stream) {
    pending += String(raw);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      let line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > maxLineChars) throw new Error('CLI JSONL line too large');
      yield line;
      newline = pending.indexOf('\n');
    }
    if (pending.length > maxLineChars) throw new Error('CLI JSONL line too large');
  }
  if (pending) yield pending;
}
