// File system browse (I6). Local, token-protected. No sandboxing beyond OS perms
// (user's own PC); reads are best-effort.
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isFile: boolean;
  size: number;
  mtime: string;
}

export async function listDir(dirPath: string): Promise<FsEntry[]> {
  const abs = resolve(dirPath || process.cwd());
  const entries = await readdir(abs, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const e of entries) {
    const p = join(abs, e.name);
    let size = 0;
    let mtime = '';
    try {
      const s = await stat(p);
      size = s.size;
      mtime = s.mtime.toISOString();
    } catch {
      // best-effort
    }
    out.push({
      name: e.name,
      path: p,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
      size,
      mtime,
    });
  }
  return out.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}
