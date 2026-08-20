// Provider-surface release gate. Offline and differential: a frontend-decorated request must
// produce exactly the same native Claude/Codex provider sinks as the same headless user action.
// Only user-authored semantic fields (prompt, explicit cwd/model/effort and attachments) may
// affect argv/env/stdin/cwd. Device/network/UI/transport metadata is deliberately not part of
// UserInput and must remain inert even if a future gateway passes a wider object by mistake.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildClaudeHookSettings,
  buildClaudePrintInvocation,
  buildClaudeSpawnEnv,
} from '../src/adapters/claude/session';
import { buildCodexExecInvocation, buildCodexSpawnEnv } from '../src/adapters/codex/protocol';
import { resolveSessionWorkingDirectory } from '../src/session/manager';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log(`PASS - ${name}`);
  } else {
    fail++;
    console.error(`FAIL - ${name}`);
  }
}

const forbidden = [
  '__FRONT_DEVICE__', '__FRONT_NETWORK__', '__FRONT_TRANSPORT__', '__FRONT_UI__', '__FRONT_TITLE__',
  'android', 'webview', 'easytier', 'moyu', 'remote-dashboard', 'remote_dashboard',
];
function hasForbidden(value: unknown): boolean {
  const serialized = JSON.stringify(value).toLowerCase();
  return forbidden.some((marker) => serialized.includes(marker.toLowerCase()));
}

const frontendMetadata = {
  deviceId: '__FRONT_DEVICE__', clientTs: 1_999_999_999_999, mobileV6Available: true,
  network: '__FRONT_NETWORK__', transport: '__FRONT_TRANSPORT__', uiVersion: '__FRONT_UI__', title: '__FRONT_TITLE__',
};

const inherited = {
  PATH: process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin',
  PWD: resolve('D:/CC/moyu/remote_dashboard'),
  OLDPWD: resolve('D:/CC/moyu'),
  INIT_CWD: resolve('D:/CC/remote_dashboard'),
  npm_config_local_prefix: resolve('D:/CC/moyu'),
  npm_package_json: resolve('D:/CC/moyu/package.json'),
  USER_NATIVE_SETTING: 'preserve-me',
  MOYU_UI_VERSION: '__FRONT_UI__',
  RD_HOOK_DEVICE_ID: '__FRONT_DEVICE__',
  REMOTE_DASHBOARD_CONFIG: '__FRONT_NETWORK__',
};
const neutralCwd = resolve(homedir());
const claudeEnv = buildClaudeSpawnEnv(undefined, false, inherited, neutralCwd);
const codexEnv = buildCodexSpawnEnv(undefined, inherited, neutralCwd);
check('Claude env strips every product control variable', !hasForbidden(claudeEnv));
check('Codex env strips every product control variable', !hasForbidden(codexEnv));
check('AI CLI PWD matches its neutral OS working directory', claudeEnv.PWD === neutralCwd && codexEnv.PWD === neutralCwd);
check('stale product launch-context paths are absent from AI CLI env',
  claudeEnv.OLDPWD === undefined && claudeEnv.INIT_CWD === undefined &&
  claudeEnv.npm_config_local_prefix === undefined && claudeEnv.npm_package_json === undefined &&
  codexEnv.OLDPWD === undefined && codexEnv.INIT_CWD === undefined &&
  codexEnv.npm_config_local_prefix === undefined && codexEnv.npm_package_json === undefined);
check('env scrub preserves unrelated native user settings',
  claudeEnv.USER_NATIVE_SETTING === 'preserve-me' && codexEnv.USER_NATIVE_SETTING === 'preserve-me');

const claudeOpts = { sessionId: '00000000-0000-4000-8000-000000000001', cliSessionRef: '00000000-0000-4000-8000-000000000001' };
const baselineClaude = buildClaudePrintInvocation(claudeOpts, join(tmpdir(), '.tmp-', 'settings.json'), false, { text: 'hello' });
const decoratedClaude = buildClaudePrintInvocation(claudeOpts, join(tmpdir(), '.tmp-', 'settings.json'), false,
  { text: 'hello', ...frontendMetadata } as { text: string });
check('Claude text argv/stdin are invariant to frontend metadata', JSON.stringify(decoratedClaude) === JSON.stringify(baselineClaude));
check('Claude text sink contains no frontend/product marker', !hasForbidden(baselineClaude));

const codexOpts = {
  approvalPolicy: 'untrusted' as const, sandbox: 'workspace-write' as const, approvalsReviewer: 'user' as const,
  approvalTimeoutSec: 120, hookConfigPath: join(tmpdir(), '.tmp-', 'data.json'),
};
const runtimeGlobal = globalThis as { __MOYU_COMPILED__?: boolean };
const previousCompiled = runtimeGlobal.__MOYU_COMPILED__;
runtimeGlobal.__MOYU_COMPILED__ = true;
try {
  const claudeHookSettings = buildClaudeHookSettings(join(tmpdir(), '.tmp-', 'data.json'), 120);
  check('compiled Claude settings sink contains no frontend/product marker', !hasForbidden(claudeHookSettings));

  const baselineCodex = buildCodexExecInvocation(codexOpts, { text: 'hello' }, null);
  const decoratedCodex = buildCodexExecInvocation(codexOpts, { text: 'hello', ...frontendMetadata }, null);
  check('Codex argv/stdin are invariant to frontend metadata', JSON.stringify(decoratedCodex) === JSON.stringify(baselineCodex));
  check('compiled Codex sink contains no frontend/product marker', !hasForbidden(baselineCodex));
} finally {
  if (previousCompiled === undefined) delete runtimeGlobal.__MOYU_COMPILED__;
  else runtimeGlobal.__MOYU_COMPILED__ = previousCompiled;
}

const imageDir = mkdtempSync(join(tmpdir(), '.tmp-'));
try {
  const imagePath = join(imageDir, 'neutral.png');
  writeFileSync(imagePath, Buffer.from('fixture-image'));
  const attachment = {
    artifactId: '11111111-1111-4111-8111-111111111111', name: 'neutral.png', mime: 'image/png' as const,
    size: 13, sha256: 'a'.repeat(64), createdAt: new Date(0).toISOString(), path: imagePath,
  };
  const baselineImage = buildClaudePrintInvocation(claudeOpts, join(tmpdir(), '.tmp-', 'settings.json'), false,
    { text: 'inspect', attachments: [attachment] });
  const decoratedImage = buildClaudePrintInvocation(claudeOpts, join(tmpdir(), '.tmp-', 'settings.json'), false,
    { text: 'inspect', attachments: [attachment], ...frontendMetadata } as { text: string; attachments: typeof attachment[] });
  check('Claude native image block is invariant to frontend metadata', JSON.stringify(decoratedImage) === JSON.stringify(baselineImage));
  check('Claude image sink contains neither local path nor client filename',
    !baselineImage.stdin.includes(imagePath) && !baselineImage.stdin.includes(attachment.name));
  check('Claude image sink contains no synthetic attachment prompt', !baselineImage.stdin.includes('[Image attachment:'));
} finally {
  rmSync(imageDir, { recursive: true, force: true });
}

check('omitted session cwd resolves to user home, not daemon launch cwd', resolveSessionWorkingDirectory() === resolve(homedir()));
check('empty session cwd resolves to user home, not daemon launch cwd', resolveSessionWorkingDirectory('') === resolve(homedir()));

console.log(`\nPROVIDER-SURFACE: ${pass} pass, ${fail} fail`);
if (fail) process.exitCode = 1;
