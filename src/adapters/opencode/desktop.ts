// Read-only discovery of the OpenCode Desktop application. Desktop's built-in sidecar is not
// attachable: it owns an ephemeral random Basic-auth credential. Discovery is presentation/setup
// evidence only; Moyu never reads Desktop stores, its database, or private IPC state.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getPlatform } from '../../util/platform';

export interface OpenCodeDesktopInstall {
  path: string;
}

export function detectOpenCodeDesktop(): OpenCodeDesktopInstall | null {
  const platform = getPlatform();
  const candidates: string[] = [];
  if (platform === 'windows') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (!root) continue;
      candidates.push(
        join(root, 'Programs', '@opencode-aidesktop', 'OpenCode.exe'),
        join(root, '@opencode-aidesktop', 'OpenCode.exe'),
        join(root, 'OpenCode', 'OpenCode.exe'),
      );
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/OpenCode.app', join(homedir(), 'Applications', 'OpenCode.app'));
  } else {
    for (const root of [process.env.LOCALAPPDATA, join(homedir(), '.local', 'share')]) {
      if (root) candidates.push(join(root, 'opencode', 'OpenCode.AppImage'));
    }
  }
  const path = candidates.find((candidate) => existsSync(candidate));
  return path ? { path } : null;
}
