// Shared local command-hook launcher. Adapter settings receive only a fixed internal command
// and a private neutral descriptor path; routing secrets never enter the CLI environment.
import { fileURLToPath } from 'node:url';
import { isCompiledBinary } from '../util/runtime';
import {
  assertNeutralHookDescriptor,
  assertNeutralHookSurface,
  neutralHookExecutable,
} from './hook-executable';

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  // Codex 0.146 uses the detected Windows user shell and defaults to PowerShell. Single-quoted
  // literals preserve %, !, &, parentheses, spaces and Unicode; only a literal quote doubles.
  return `'${value.replace(/'/g, "''")}'`;
}

/** Exact executable + argument vector for command-hook implementations that support exec form. */
export function hookRelayExec(configPath: string): { command: string; args: string[] } {
  // Validate only the product-owned descriptor leaf. Ancestor components can legitimately be
  // chosen by the OS/user and must not become a false-positive brand/path policy.
  assertNeutralHookDescriptor(configPath);
  if (isCompiledBinary()) {
    const command = neutralHookExecutable();
    const args = ['local-check', configPath];
    assertNeutralHookSurface(command, ['local-check']);
    return { command, args };
  }
  const args = [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../index.ts', import.meta.url)),
        'local-check',
        configPath,
      ];
  return { command: process.execPath, args };
}

/** Shell forms retained for the version-bound Codex 0.146 hook configuration. Every non-zero
 * relay result is normalized to exit 2, which both supported CLIs treat as a blocking result. */
export function hookRelayCommands(configPath: string): { unix: string; windows: string } {
  const relay = hookRelayExec(configPath);
  const args = [relay.command, ...relay.args];
  return {
    unix:
      args.map(quotePosix).join(' ') + ' || ' +
      '{ echo "approval unavailable" >&2; exit 2; }',
    // Codex 0.146's Windows hook runner prefers pwsh, then Windows PowerShell, both with
    // -NoProfile -Command. Keep this version-bound and normalize every non-zero result to 2.
    windows:
      '& ' + args.map(quotePowerShell).join(' ') + '; ' +
      "if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('approval unavailable'); exit 2 }",
  };
}

/** Leave enough time for the approval tracker itself to produce its fail-closed decision. */
export function relayTimeoutSecFor(approvalTimeoutSec: number): number {
  return approvalTimeoutSec + 10;
}
