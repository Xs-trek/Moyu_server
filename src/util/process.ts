import { spawn, type ChildProcess } from 'node:child_process';
import { isWindows } from './platform';

export interface TerminateProcessOptions {
  gracefulSignal?: NodeJS.Signals;
  graceMs?: number;
  hardMs?: number;
  /** True only when the child was spawned as a detached Unix process group leader. */
  processGroup?: boolean;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      child.off('close', onClose);
      child.off('error', onClose);
      clearTimeout(timer);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    child.once('close', onClose);
    child.once('error', onClose);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

function signalUnix(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean): void {
  if (child.pid && processGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group has already gone away.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort termination.
  }
}

/** Terminate an adapter subprocess and every tool process it spawned, with a bounded wait. */
export async function terminateProcessTree(child: ChildProcess, opts: TerminateProcessOptions = {}): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceMs = opts.graceMs ?? 2_000;
  const hardMs = opts.hardMs ?? 4_000;

  if (isWindows && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      killer.once('close', finish);
      killer.once('error', finish);
      const timer = setTimeout(finish, graceMs);
      timer.unref?.();
    });
    // taskkill is the process-tree path. Direct kill is a fallback for restricted
    // environments where taskkill could not attach to the child.
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort.
    }
    await waitForExit(child, hardMs);
    return;
  }

  const processGroup = opts.processGroup === true;
  signalUnix(child, opts.gracefulSignal ?? 'SIGTERM', processGroup);
  if (await waitForExit(child, graceMs)) return;
  signalUnix(child, 'SIGKILL', processGroup);
  await waitForExit(child, Math.max(0, hardMs - graceMs));
}
