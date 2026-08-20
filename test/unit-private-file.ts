// Real filesystem permission checks for the cross-platform private-file helper.
// Windows verifies the resulting NTFS DACL, not Node's ineffective POSIX mode bits.
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { platform } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import {
  createPrivateTempDirectory,
  initializePrivateRuntimeRoot,
  createPrivateRuntimeSubdirectory,
  ensurePrivateDirectory,
  securePrivateFile,
  writeFileInPrivateDirectory,
  writePrivateFile,
} from '../src/util/private-file';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ FAIL: ' + name);
  }
}

interface AclRule {
  sid: string;
  inherited: boolean;
  type: string;
  rights: string;
}

interface AclView {
  protected: boolean;
  currentSid: string;
  rules: AclRule[];
}

function inspectWindowsAcl(path: string): AclView {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:PRIVATE_ACL_TEST_TARGET
$acl = if ([System.IO.Directory]::Exists($target)) {
  [System.IO.Directory]::GetAccessControl($target)
} else {
  [System.IO.File]::GetAccessControl($target)
}
$rules = @($acl.Access | ForEach-Object {
  [pscustomobject]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    inherited = $_.IsInherited
    type = $_.AccessControlType.ToString()
    rights = $_.FileSystemRights.ToString()
  }
})
[pscustomobject]@{
  protected = $acl.AreAccessRulesProtected
  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  rules = $rules
} | ConvertTo-Json -Compress -Depth 4
`;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? '';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PRIVATE_ACL_TEST_TARGET: path },
  });
  if (result.error || result.status !== 0) throw new Error('Windows ACL inspection failed');
  return JSON.parse(result.stdout.trim()) as AclView;
}

function exactPrivateWindowsAcl(view: AclView): boolean {
  const allowed = new Set([view.currentSid, 'S-1-5-18']);
  const found = new Set(view.rules.map((rule) => rule.sid));
  return view.protected &&
    view.rules.length === 2 &&
    view.rules.every((rule) => allowed.has(rule.sid) && !rule.inherited && rule.type === 'Allow' && rule.rights.includes('FullControl')) &&
    found.has(view.currentSid) && found.has('S-1-5-18');
}

function inheritedPrivateWindowsAcl(view: AclView): boolean {
  const allowed = new Set([view.currentSid, 'S-1-5-18']);
  const found = new Set(view.rules.map((rule) => rule.sid));
  return view.rules.length === 2 &&
    view.rules.every((rule) => allowed.has(rule.sid) && rule.type === 'Allow' && rule.rights.includes('FullControl')) &&
    found.has(view.currentSid) && found.has('S-1-5-18');
}

const root = createPrivateTempDirectory();
const file = join(root, 'secret.json');
try {
  check('temporary directory prefix is neutral', !/moyu|remote|codex|claude|hook|relay/i.test(basename(root)));
  writePrivateFile(file, '{"secret":true}');
  check('private file contents written', readFileSync(file, 'utf8') === '{"secret":true}');
  const inheritedFile = join(root, 'inherited-secret.json');
  writeFileInPrivateDirectory(inheritedFile, '{"secret":"inherited"}');
  check('file inside private directory is written', readFileSync(inheritedFile, 'utf8') === '{"secret":"inherited"}');
  // Once the parent has been verified private, child create/overwrite must not depend on a
  // second PowerShell launch. This is the per-session runtime path used after daemon bootstrap.
  const previousSystemRoot = process.env.SystemRoot;
  const previousWindir = process.env.WINDIR;
  process.env.SystemRoot = join(root, 'missing-system-root');
  delete process.env.WINDIR;
  try {
    writeFileInPrivateDirectory(inheritedFile, '{"secret":"updated"}');
    check('private-child overwrite is independent of later Windows helper availability',
      readFileSync(inheritedFile, 'utf8') === '{"secret":"updated"}');
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    if (previousWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = previousWindir;
  }

  // Public API rejects the wrong object type rather than writing secret contents into it.
  const wrongType = join(root, 'not-a-file');
  mkdirSync(wrongType);
  let wrongTypeRejected = false;
  try { writePrivateFile(wrongType, 'must-not-write'); } catch { wrongTypeRejected = true; }
  check('wrong path type fails closed', wrongTypeRejected);
  ensurePrivateDirectory(wrongType);
  let directoryRejected = false;
  try { securePrivateFile(wrongType); } catch { directoryRejected = true; }
  check('securePrivateFile rejects a directory', directoryRejected);

  if (platform() === 'win32') {
    check('Windows directory has exact private DACL', exactPrivateWindowsAcl(inspectWindowsAcl(root)));
    check('Windows file has exact private DACL', exactPrivateWindowsAcl(inspectWindowsAcl(file)));
    check('Windows child inherits only the private user+SYSTEM DACL', inheritedPrivateWindowsAcl(inspectWindowsAcl(inheritedFile)));

    // Bootstrap the process runtime root once, then prove that later session children and files
    // inherit its exact ACL without any dependence on another PowerShell invocation.
    const runtimeParent = join(root, 'runtime-parent');
    mkdirSync(runtimeParent);
    const runtimeRoot = initializePrivateRuntimeRoot(runtimeParent);
    const previousRuntimeSystemRoot = process.env.SystemRoot;
    const previousRuntimeWindir = process.env.WINDIR;
    process.env.SystemRoot = join(root, 'missing-runtime-system-root');
    delete process.env.WINDIR;
    let runtimeChild = '';
    let runtimeFile = '';
    try {
      runtimeChild = createPrivateRuntimeSubdirectory();
      runtimeFile = join(runtimeChild, 'data.json');
      writeFileInPrivateDirectory(runtimeFile, '{"runtime":true}');
    } finally {
      if (previousRuntimeSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousRuntimeSystemRoot;
      if (previousRuntimeWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousRuntimeWindir;
    }
    check('runtime root stays beneath explicitly bootstrapped parent', runtimeRoot.startsWith(runtimeParent));
    check('Windows runtime child inherits only the private user+SYSTEM DACL', inheritedPrivateWindowsAcl(inspectWindowsAcl(runtimeChild)));
    check('Windows runtime file inherits only the private user+SYSTEM DACL', inheritedPrivateWindowsAcl(inspectWindowsAcl(runtimeFile)));

    // Prove re-hardening removes an explicit unrelated principal, not just inherited entries.
    const broaden = spawnSync('icacls.exe', [file, '/grant', '*S-1-5-32-545:R'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
    });
    check('Windows test broadened file ACL', !broaden.error && broaden.status === 0);
    writePrivateFile(file, '{"secret":false}');
    check('Windows overwrite removes unrelated ACL', exactPrivateWindowsAcl(inspectWindowsAcl(file)));

    // Security-sensitive ACL setup must not resolve a same-named helper through PATH. A
    // stripped PATH still succeeds because production uses the absolute system PowerShell.
    const previousPath = process.env.PATH;
    const stripped = join(root, 'stripped-path');
    mkdirSync(stripped);
    process.env.PATH = stripped;
    const pathIndependent = join(root, 'path-independent');
    try {
      ensurePrivateDirectory(pathIndependent);
      check('Windows private ACL setup is independent of PATH', existsSync(pathIndependent));
      check('Windows PATH-independent directory has exact private DACL', exactPrivateWindowsAcl(inspectWindowsAcl(pathIndependent)));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } else {
    check('POSIX directory mode is 0700', (statSync(root).mode & 0o777) === 0o700);
    check('POSIX file mode is 0600', (statSync(file).mode & 0o777) === 0o600);
    const runtimeParent = join(root, 'runtime-parent');
    mkdirSync(runtimeParent);
    initializePrivateRuntimeRoot(runtimeParent);
    const runtimeChild = createPrivateRuntimeSubdirectory();
    const runtimeFile = join(runtimeChild, 'data.json');
    writeFileInPrivateDirectory(runtimeFile, '{"runtime":true}');
    check('POSIX runtime child mode is 0700', (statSync(runtimeChild).mode & 0o777) === 0o700);
    check('POSIX runtime file mode is 0600', (statSync(runtimeFile).mode & 0o777) === 0o600);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ` (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
