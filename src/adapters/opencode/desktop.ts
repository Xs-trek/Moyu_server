// Read-only discovery of the OpenCode Desktop application and an official service-capable CLI
// if a release actually bundles/stages one. Production 1.18.21 does not, so absence is an
// expected, explicit state; Moyu never scrapes v1 sidecar IPC, process memory or credentials.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getPlatform } from '../../util/platform';

export interface OpenCodeDesktopInstall {
  path: string;
  serviceCliPath?: string;
  /** Official Desktop service discovery locations; values are paths only, never credentials. */
  serviceStateHomes?: string[];
}

function appDataRoots(platform: string): string[] {
  return (platform === 'windows'
    ? [process.env.APPDATA]
    : platform === 'darwin'
      ? [join(homedir(), 'Library', 'Application Support')]
      : [process.env.XDG_CONFIG_HOME, join(homedir(), '.config')]).filter((value): value is string => Boolean(value));
}

function serviceStateHomes(platform: string): string[] {
  const homes: string[] = [];
  for (const appData of appDataRoots(platform)) {
    for (const name of ['ai.opencode.desktop', 'ai.opencode.desktop.beta', 'ai.opencode.desktop.dev']) {
      const value = join(appData, name);
      if (existsSync(value)) homes.push(value);
    }
  }
  return homes;
}

function serviceCliForDesktop(path: string, platform: string): string | undefined {
  const bundled = platform === 'windows'
    ? [join(dirname(path), 'resources', 'opencode-cli.exe')]
    : platform === 'darwin'
      ? [join(path, 'Contents', 'Resources', 'opencode-cli'), join(path, 'Contents', 'MacOS', 'opencode-cli')]
      : [join(dirname(path), 'resources', 'opencode-cli'), join(dirname(path), 'opencode-cli')];
  const staged: string[] = [];
  for (const appData of appDataRoots(platform)) {
    for (const name of ['ai.opencode.desktop', 'ai.opencode.desktop.beta', 'ai.opencode.desktop.dev']) {
      const root = join(appData, name, 'cli');
      try {
        for (const version of readdirSync(root).sort().reverse()) {
          staged.push(join(root, version, platform === 'windows' ? 'opencode-cli.exe' : 'opencode-cli'));
        }
      } catch { /* no staged v2 CLI */ }
    }
  }
  return [...bundled, ...staged].find((candidate) => existsSync(candidate));
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
  return path ? { path, serviceCliPath: serviceCliForDesktop(path, platform), serviceStateHomes: serviceStateHomes(platform) } : null;
}
