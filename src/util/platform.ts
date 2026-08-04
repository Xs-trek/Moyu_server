// Cross-platform helpers (T6: win/linux/darwin, x64/arm64).
import { platform, arch } from 'node:os';

export type Platform = 'windows' | 'linux' | 'darwin';
export type Arch = 'x64' | 'arm64';

export function getPlatform(): Platform {
  const p = platform();
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'darwin';
  throw new Error(`unsupported platform: ${String(p)}`);
}

export function getArch(): Arch {
  const a = arch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'arm64';
  throw new Error(`unsupported arch: ${String(a)}`);
}

export const isWindows: boolean = getPlatform() === 'windows';
export const isLinux: boolean = getPlatform() === 'linux';
export const isMacos: boolean = getPlatform() === 'darwin';

/** Append .exe on Windows for a native binary base name. */
export function exeName(base: string): string {
  return isWindows ? `${base}.exe` : base;
}

/** bun build --compile target triple for the current host. */
export function bunTarget(): string {
  const p = getPlatform();
  const a = getArch();
  if (p === 'windows') return `bun-windows-${a}`;
  if (p === 'linux') return `bun-linux-${a}`;
  return `bun-darwin-${a}`;
}
