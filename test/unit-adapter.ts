// Unit tests for adapter reconfigure after a /config PATCH (review P1: adapters capture
// approvalTimeoutSec + adapterConfig at construction, so a PATCH must reconfigure them or new
// sessions spawn with stale config). Verifies AdapterManager.reconfigure forwards to the
// adapter's reconfigure, and is a safe no-op for adapters that don't implement it.
// Run: npx tsx test/unit-adapter.ts
import { AdapterManager } from '../src/adapters/manager';
import type { Adapter, AdapterKind, AuthProfile } from '../src/adapters/types';
import type { AdapterConfig } from '../src/config/schema';
import {
  buildClaudeHookSettings,
  buildClaudePrintInvocation,
  CLAUDE_MAX_JSONL_LINE_CHARS,
  mergeAskUserQuestionAnswers,
} from '../src/adapters/claude/session';
import { readLines } from '../src/util/spawn';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ FAIL: ' + name);
  }
}

const opts = {
  approvalTimeoutSec: 200,
  adapterConfig: { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' } as AdapterConfig,
};
const capabilities = {
  streaming: { text: true, thinking: false, tools: true },
  resume: true,
  interrupt: true,
  accountProfiles: false,
  approval: { transport: 'native' as const, semantics: 'native' as const, policies: [] },
  configuration: { model: false, modelSelection: 'freeform' as const, effortLevels: [], permissionModes: [], sandboxModes: [], reviewers: [] },
};

// Adapter WITH reconfigure: manager forwards the opts verbatim.
let received: typeof opts | null = null;
const withReconfigure: Adapter = {
  kind: 'claude' as AdapterKind,
  displayName: 'Mock',
  capabilities,
  isAvailable: async () => true,
  detect: async () => ({ adapter: 'claude', mode: 'none', hasCredentials: false }) as AuthProfile,
  startSession: async () => {
    throw new Error('not used');
  },
  reconfigure: (o) => {
    received = o;
  },
};
const mgr1 = new AdapterManager();
mgr1.register(withReconfigure);
mgr1.reconfigure('claude', opts);
check('reconfigure forwards to adapter', received !== null);
check('forwarded approvalTimeoutSec', received?.approvalTimeoutSec === 200);
check('forwarded adapterConfig.approvalPolicy', received?.adapterConfig.approvalPolicy === 'never');
check('forwarded adapterConfig.sandbox', received?.adapterConfig.sandbox === 'read-only');

// Adapter WITHOUT reconfigure (optional method): manager.reconfigure is a no-op, no throw.
const withoutReconfigure: Adapter = {
  kind: 'codex' as AdapterKind,
  displayName: 'Mock2',
  capabilities,
  isAvailable: async () => true,
  detect: async () => ({ adapter: 'codex', mode: 'none', hasCredentials: false }) as AuthProfile,
  startSession: async () => {
    throw new Error('not used');
  },
};
const mgr2 = new AdapterManager();
mgr2.register(withoutReconfigure);
let threw = false;
try {
  mgr2.reconfigure('codex', opts);
} catch {
  threw = true;
}
check('reconfigure on adapter without method does not throw', !threw);

// Unregistered kind: no throw (defensive).
let threw2 = false;
try {
  mgr2.reconfigure('opencode' as AdapterKind, opts);
} catch {
  threw2 = true;
}
check('reconfigure unregistered kind does not throw', !threw2);

mgr1.reconfigureAll(200, { claude: opts.adapterConfig });
check('reconfigureAll routes config through registered adapter', received?.approvalTimeoutSec === 200);
check('registry has registered adapter by string', mgr1.has('claude'));
check('registry rejects unknown adapter string', !mgr1.has('future-missing'));

const claudeInvocation = buildClaudePrintInvocation(
  { sessionId: 'session', cliSessionRef: 'session', extraDirs: ['D:/work'], model: 'native-model', effort: 'high', permissionMode: 'auto' },
  'D:/private/settings.json',
  false,
  { text: 'private user prompt' },
);
check('claude prompt uses stdin', claudeInvocation.stdin === 'private user prompt');
check('claude prompt is absent from argv', !claudeInvocation.args.includes('private user prompt'));
check('claude print stream flags retained', claudeInvocation.args.includes('-p') && claudeInvocation.args.includes('stream-json'));
check('claude native effort is an argv option', claudeInvocation.args.includes('--effort') && claudeInvocation.args.includes('high'));
check('claude permission mode is a native argv option', claudeInvocation.args.includes('--permission-mode') && claudeInvocation.args.includes('auto'));
const claudeForbiddenConfigFlags = [
  '--bare',
  '--safe-mode',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--setting-sources',
  '--tools',
];
check(
  'claude invocation preserves native user config, skills and MCP discovery',
  claudeForbiddenConfigFlags.every((flag) => !claudeInvocation.args.includes(flag)),
);
const claudeHookSettings = buildClaudeHookSettings('D:/private/data.json', 120);
const claudeHook = claudeHookSettings.hooks.PreToolUse[0]?.hooks[0];
const claudeCanaryHook = claudeHookSettings.hooks.SessionStart[0]?.hooks[0];
check('claude command-line settings re-enable hooks disabled by lower settings scopes', claudeHookSettings.disableAllHooks === false);
check('claude settings contain a local SessionStart readiness canary',
  claudeCanaryHook?.type === 'command' && claudeCanaryHook.args.includes('local-check'));
check('claude approval uses a local command hook, not fail-open HTTP', claudeHook?.type === 'command' && !('url' in claudeHook));
check('claude command hook uses exec-form arguments', Array.isArray(claudeHook?.args) && claudeHook.args.includes('local-check') && claudeHook.args.includes('D:/private/data.json'));
check('claude command hook timeout leaves relay a blocking margin', claudeHook?.timeout === 150);
const claudeBoundaryHook = buildClaudeHookSettings('D:/private/data.json', 590).hooks.PreToolUse[0]?.hooks[0];
check('claude maximum configured timeout preserves the relay backstop margin', claudeBoundaryHook?.timeout === 620);
check('claude hook settings contain no credential/header material', !/authorization|bearer|secret|headers/i.test(JSON.stringify(claudeHookSettings)));
const maxEightMiBBase64Chars = Math.ceil((8 * 1024 * 1024) / 3) * 4;
check('claude JSONL cap accommodates four 8 MiB base64 tool results', CLAUDE_MAX_JSONL_LINE_CHARS > maxEightMiBBase64Chars * 4);
const imageDir = mkdtempSync(join(tmpdir(), '.tmp-'));
try {
  const imagePath = join(imageDir, '11111111-1111-4111-8111-111111111111.png');
  writeFileSync(imagePath, Buffer.from('fixture-image'));
  const imageInput = {
    text: 'inspect',
    attachments: [{ artifactId: '11111111-1111-4111-8111-111111111111', name: 'android-webview-screen.png', mime: 'image/png' as const, size: 13, sha256: 'a'.repeat(64), createdAt: new Date(0).toISOString(), path: imagePath }],
  };
  const claudeImageInvocation = buildClaudePrintInvocation(
    { sessionId: 'session', cliSessionRef: 'session' },
    'D:/private/settings.json',
    false,
    imageInput,
  );
  check('claude image uses the official stream-json input protocol',
    claudeImageInvocation.args.join(' ').includes('--input-format stream-json'));
  check('claude image does not grant the private artifact directory as workspace context',
    !claudeImageInvocation.args.includes('--add-dir') && !claudeImageInvocation.args.join(' ').includes(imageDir));
  check('claude image input contains no synthetic path label or client filename',
    !claudeImageInvocation.stdin.includes('[Image attachment:') &&
    !claudeImageInvocation.stdin.includes(imagePath) &&
    !claudeImageInvocation.stdin.includes('android-webview-screen.png'));
  const imageMessage = JSON.parse(claudeImageInvocation.stdin) as {
    type?: string;
    message?: { role?: string; content?: Array<Record<string, unknown>> };
    parent_tool_use_id?: unknown;
  };
  const imageBlock = imageMessage.message?.content?.[1] as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | undefined;
  check('claude image is a native base64 image content block',
    imageMessage.type === 'user' && imageMessage.message?.role === 'user' &&
    imageBlock?.type === 'image' && imageBlock.source?.type === 'base64' &&
    imageBlock.source.media_type === 'image/png' && imageBlock.source.data === Buffer.from('fixture-image').toString('base64'));

  const withFrontendOnlyMetadata = buildClaudePrintInvocation(
    { sessionId: 'session', cliSessionRef: 'session' },
    'D:/private/settings.json',
    false,
    {
      ...imageInput,
      deviceId: '__FRONT_DEVICE__',
      clientTs: 123456,
      network: '__FRONT_NETWORK__',
      transport: '__FRONT_TRANSPORT__',
      uiVersion: '__FRONT_UI__',
      title: '__FRONT_TITLE__',
    } as typeof imageInput,
  );
  check('claude provider input is invariant to frontend-only metadata',
    JSON.stringify(withFrontendOnlyMetadata) === JSON.stringify(claudeImageInvocation));
} finally {
  rmSync(imageDir, { recursive: true, force: true });
}
const askInput = {
  questions: [
    { question: 'Choose a mode', header: 'Mode', options: [{ label: 'Fast' }, { label: 'Safe' }], multiSelect: false },
    { question: 'Choose features', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
  ],
};
const answered = mergeAskUserQuestionAnswers(askInput, {
  allowWithModification: { answers: { 'Choose a mode': 'Safe', 'Choose features': ['A', 'B'] } },
}) as { questions?: unknown[]; answers?: Record<string, unknown> };
check('AskUserQuestion merges bounded single and multi-select answers',
  answered.questions?.length === 2 && answered.answers?.['Choose a mode'] === 'Safe' && answered.answers?.['Choose features'] === 'A, B');
let arbitraryModificationRejected = false;
try {
  mergeAskUserQuestionAnswers(askInput, { allowWithModification: { answers: { 'Different question': 'x' } } });
} catch {
  arbitraryModificationRejected = true;
}
check('AskUserQuestion rejects client replacement of native questions', arbitraryModificationRejected);

const parsedLines: string[] = [];
for await (const line of readLines(Readable.from(['one\r\ntwo\n']), 16)) parsedLines.push(line);
check('bounded JSONL reader preserves CRLF/LF lines', parsedLines.join(',') === 'one,two');
let oversizedLineRejected = false;
try {
  for await (const _line of readLines(Readable.from(['x'.repeat(17)]), 16)) { /* consume */ }
} catch {
  oversizedLineRejected = true;
}
check('bounded JSONL reader rejects oversized line', oversizedLineRejected);

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
if (fail) process.exitCode = 1;
