// Cross-platform private directory/file creation for locally persisted secrets.
// POSIX permissions are enforced with chmod. Windows POSIX mode bits do not constrain
// NTFS access, so Windows receives an explicit, inheritance-disabled DACL containing only
// the process user and SYSTEM. Any hardening failure throws before the caller may continue.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isWindows } from './platform';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

// The .NET access-control APIs apply the replacement DACL as one security-descriptor update. This avoids the
// transient broad-ACL window caused by a reset + icacls grant sequence. The verification is
// deliberately performed by Windows itself and rejects inherited, denied, or extra entries.
const WINDOWS_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:PRIVATE_ACL_TARGET
$isDirectory = $env:PRIVATE_ACL_DIRECTORY -eq '1'
if ([string]::IsNullOrWhiteSpace($target)) { throw 'missing ACL target' }
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
# Replace only the access-control section from an SDDL descriptor. This preserves owner/group,
# removes every prior ACE in one operation, and remains idempotent for an already-private path.
$aceFlags = if ($isDirectory) { 'OICI' } else { '' }
$sddl = "D:P(A;$aceFlags;FA;;;$($userSid.Value))(A;$aceFlags;FA;;;$($systemSid.Value))"
$acl = if ($isDirectory) {
  New-Object System.Security.AccessControl.DirectorySecurity
} else {
  New-Object System.Security.AccessControl.FileSecurity
}
$acl.SetSecurityDescriptorSddlForm(
  $sddl,
  [System.Security.AccessControl.AccessControlSections]::Access
)
$allow = [System.Security.AccessControl.AccessControlType]::Allow
if ($isDirectory) {
  [System.IO.Directory]::SetAccessControl($target, $acl)
} else {
  [System.IO.File]::SetAccessControl($target, $acl)
}
$check = if ($isDirectory) {
  [System.IO.Directory]::GetAccessControl($target)
} else {
  [System.IO.File]::GetAccessControl($target)
}
if (-not $check.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }
$allowed = @($userSid.Value, $systemSid.Value)
$seen = @()
foreach ($rule in @($check.Access)) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($rule.IsInherited -or $rule.AccessControlType -ne $allow -or $allowed -notcontains $sid) {
    throw 'unexpected ACL entry'
  }
  $seen += $sid
}
if ($seen -notcontains $userSid.Value -or $seen -notcontains $systemSid.Value) {
  throw 'required ACL entry missing'
}
`;

function assertPathType(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error('private path must not be a symbolic link');
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(directory ? 'private directory required' : 'private file required');
  }
}

function applyWindowsPrivateAcl(path: string, directory: boolean): void {
  // Do not resolve a security-sensitive helper through PATH/current-directory search. The
  // absolute system location is stable on supported Windows installations and prevents a
  // same-named executable from observing secret-bearing target paths through this call.
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error('Windows system directory is unavailable');
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(powershell)) throw new Error('Windows PowerShell is unavailable');
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PRIVATE_ACL],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        PRIVATE_ACL_TARGET: path,
        PRIVATE_ACL_DIRECTORY: directory ? '1' : '0',
      },
    },
  );
  if (result.error || result.status !== 0) {
    // Never continue with inherited Windows permissions. Do not include command output: it can
    // contain local paths and account names, while callers only need a stable fail-closed error.
    throw new Error('unable to apply private Windows ACL');
  }
}

/** Create if needed and enforce a private directory. Existing directories are re-hardened. */
export function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  if (!existed) mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    assertPathType(path, true);
    if (isWindows) applyWindowsPrivateAcl(path, true);
    else chmodSync(path, PRIVATE_DIR_MODE);
  } catch (error) {
    if (!existed) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* best-effort empty-dir cleanup */ }
    }
    throw error;
  }
}

/** Enforce private permissions on an existing regular file. */
export function securePrivateFile(path: string): void {
  assertPathType(path, false);
  if (isWindows) applyWindowsPrivateAcl(path, false);
  else chmodSync(path, PRIVATE_FILE_MODE);
}

/**
 * Write a secret-bearing text file without ever writing secret contents to a broadly inherited
 * new file. A new file is created empty, secured, then populated; an existing file is secured
 * before overwrite. If the parent does not exist it is created privately.
 */
export function writePrivateFile(path: string, contents: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) ensurePrivateDirectory(parent);
  const existed = existsSync(path);
  if (existed) {
    securePrivateFile(path);
  } else {
    writeFileSync(path, '', { flag: 'wx', mode: PRIVATE_FILE_MODE });
    try {
      securePrivateFile(path);
    } catch (error) {
      try { rmSync(path, { force: true }); } catch { /* empty file only */ }
      throw error;
    }
  }
  writeFileSync(path, contents, { flag: 'w', mode: PRIVATE_FILE_MODE });
}

/**
 * Write a file inside a directory whose exact private ACL/mode was already established by this
 * process. New children inherit that Windows DACL; POSIX receives an explicit 0600 mode. This is
 * intentionally not exported as a general replacement for writePrivateFile: callers must hold
 * the freshly-created private parent and must never use it for an existing/operator path.
 */
export function writeFileInPrivateDirectory(path: string, contents: string): void {
  if (existsSync(path)) {
    assertPathType(path, false);
    writeFileSync(path, contents, { flag: 'w', mode: PRIVATE_FILE_MODE });
    return;
  }
  writeFileSync(path, contents, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  assertPathType(path, false);
}

/** Create a neutral-name private temporary directory suitable for adapter descriptors/settings. */
export function createPrivateTempDirectory(prefix = '.tmp-', root = tmpdir()): string {
  const dir = mkdtempSync(join(root, prefix));
  try {
    ensurePrivateDirectory(dir);
    return dir;
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

let privateRuntimeRoot: string | null = null;
let runtimeCleanupRegistered = false;

/**
 * Establish one process-owned private runtime root using the full fail-closed ACL helper.
 * Session subdirectories subsequently inherit this proven DACL, removing PowerShell from the
 * interactive create-session path without weakening the initial protection requirement.
 */
export function initializePrivateRuntimeRoot(root = tmpdir()): string {
  if (privateRuntimeRoot && existsSync(privateRuntimeRoot)) return privateRuntimeRoot;
  const created = createPrivateTempDirectory('.tmp-', root);
  privateRuntimeRoot = created;
  if (!runtimeCleanupRegistered) {
    runtimeCleanupRegistered = true;
    process.once('exit', () => {
      if (privateRuntimeRoot) {
        try { rmSync(privateRuntimeRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        privateRuntimeRoot = null;
      }
    });
  }
  return created;
}

/** Create a neutral private child beneath the already-hardened process runtime root. */
export function createPrivateRuntimeSubdirectory(prefix = '.tmp-'): string {
  const root = initializePrivateRuntimeRoot();
  const dir = mkdtempSync(join(root, prefix), { encoding: 'utf8' });
  try {
    assertPathType(dir, true);
    if (!isWindows) chmodSync(dir, PRIVATE_DIR_MODE);
    return dir;
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}
