// The default app-owned config is verified once per process; later PATCH persistence must not
// depend on another Windows helper. Custom config paths retain per-write fail-closed hardening.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';

if (platform() !== 'win32') {
  console.log('CONFIG DEFAULT CACHE UNIT: SKIP (Windows only)');
  process.exit(0);
}

const fakeHome = mkdtempSync(join(tmpdir(), 'config-cache-home-'));
const originalUserProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeHome;
const { applyPatch, loadConfig } = await import('../src/config/loader');
const defaultDir = join(fakeHome, '.remote-dashboard');
const defaultPath = join(defaultDir, 'config.json');
const cfg = loadConfig();
const originalSystemRoot = process.env.SystemRoot;
const originalWindir = process.env.WINDIR;
process.env.SystemRoot = join(defaultDir, 'missing-system-root');
delete process.env.WINDIR;
let defaultSucceeded = false;
let customFailedClosed = false;
const customParent = join(defaultDir, 'cache-test-custom-' + process.pid);
const customPath = join(customParent, 'config.json');
try {
  applyPatch(cfg, { defaultAdapter: cfg.defaultAdapter });
  defaultSucceeded = true;
  mkdirSync(customParent);
  try { loadConfig(customPath); } catch { customFailedClosed = true; }
} finally {
  if (originalSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRoot;
  if (originalWindir === undefined) delete process.env.WINDIR;
  else process.env.WINDIR = originalWindir;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(`${defaultSucceeded ? 'PASS' : 'FAIL'} - default app config persists after one verified bootstrap`);
console.log(`${customFailedClosed ? 'PASS' : 'FAIL'} - custom config remains fail-closed without ACL helper`);
if (!defaultSucceeded || !customFailedClosed) process.exitCode = 1;
