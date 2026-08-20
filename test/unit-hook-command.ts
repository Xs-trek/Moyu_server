import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNeutralHookDescriptor,
  assertNeutralHookSurface,
  createNeutralExecutableAlias,
} from '../src/approval/hook-executable';
import { hookRelayCommands, hookRelayExec } from '../src/approval/hook-command';
import { createPrivateTempDirectory } from '../src/util/private-file';
import { isWindows } from '../src/util/platform';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log(`PASS - ${name}`);
  } else {
    fail++;
    console.log(`FAIL - ${name}`);
  }
}

const sourceDir = createPrivateTempDirectory();
const targetRoot = createPrivateTempDirectory();
try {
  // The source deliberately carries every forbidden product marker. Only the neutral
  // alias is allowed to enter a native hook definition.
  const source = join(sourceDir, 'moyu-remote_dashboard-hook-relay.bin');
  writeFileSync(source, 'alias-test');
  const alias = createNeutralExecutableAlias(source, [targetRoot]);
  check('neutral alias is a hard-link on the supplied filesystem', alias.method === 'link');
  check('neutral alias exists and preserves executable bytes', existsSync(alias.path) && readFileSync(alias.path, 'utf8') === 'alias-test');
  check('neutral alias path contains no forbidden marker', !/moyu|remote[-_]dashboard|hook-relay/i.test(alias.path));
  assertNeutralHookSurface(alias.path, ['local-check']);
  assertNeutralHookDescriptor(join(alias.dir, 'data.json'));
  check('neutral compiled hook command and argv pass the outbound surface gate', true);

  let rejectedCommand = false;
  try { assertNeutralHookSurface('C:/bin/moyu.exe', []); } catch { rejectedCommand = true; }
  check('product executable name is rejected', rejectedCommand);

  let rejectedArg = false;
  try { assertNeutralHookSurface(alias.path, ['hook-relay']); } catch { rejectedArg = true; }
  check('retired branded hook subcommand is rejected', rejectedArg);

  // Ancestors are outside the hook builder's ownership and may contain ordinary words. The
  // product-owned leaf remains fixed and neutral.
  assertNeutralHookDescriptor('C:/phone/mobile/easytier/.tmp-user/data.json');
  check('ordinary user path components do not trigger the product surface gate', true);

  if (isWindows) {
    // Execute the actual Codex 0.146 commandWindows form through its default PowerShell runner.
    // A SessionStart marker proves every unusual path byte arrived rather than merely failing.
    const specialDir = join(targetRoot, 'phone mobile relay %PATH% !PATH! & (x) 中文');
    mkdirSync(specialDir);
    const descriptor = join(specialDir, 'data.json');
    const marker = join(specialDir, 'ready');
    const nonce = 'a'.repeat(64);
    writeFileSync(descriptor, JSON.stringify({
      port: 1,
      timeoutMs: 1_000,
      secret: 'b'.repeat(48),
      sessionId: 'session',
      probePath: marker,
      probeNonce: nonce,
    }));
    const commandWindows = hookRelayCommands(descriptor).windows;
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? '';
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', commandWindows], {
      input: JSON.stringify({ hook_event_name: 'SessionStart' }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const commandOk = !result.error && result.status === 0 && result.stdout === '' && result.stderr === '' &&
      existsSync(marker) && readFileSync(marker, 'utf8') === nonce;
    if (!commandOk) console.error(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, commandWindows }));
    check('commandWindows preserves PowerShell metacharacter paths', commandOk);
  }

  // Exercise the same branch used by the Bun-compiled artifact. Only the executable alias and
  // fixed subcommand are product-owned; the neutral descriptor argument is preserved verbatim.
  (globalThis as { __MOYU_COMPILED__?: boolean }).__MOYU_COMPILED__ = true;
  const compiled = hookRelayExec('C:/phone/mobile/easytier/.tmp-user/data.json');
  check('compiled hook uses the neutral executable alias', /[\\/]local-guard(?:\.exe)?$/i.test(compiled.command));
  check('compiled hook argv uses the neutral subcommand', compiled.args[0] === 'local-check');
  check('compiled hook preserves an ordinary user-selected ancestor path', compiled.args[1] === 'C:/phone/mobile/easytier/.tmp-user/data.json');

  rmSync(alias.dir, { recursive: true, force: true });
} finally {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(targetRoot, { recursive: true, force: true });
}

console.log(`\nHOOK-COMMAND: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
