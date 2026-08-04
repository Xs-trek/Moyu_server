// Unit tests for adapter reconfigure after a /config PATCH (review P1: adapters capture
// approvalTimeoutSec + adapterConfig at construction, so a PATCH must reconfigure them or new
// sessions spawn with stale config). Verifies AdapterManager.reconfigure forwards to the
// adapter's reconfigure, and is a safe no-op for adapters that don't implement it.
// Run: npx tsx test/unit-adapter.ts
import { AdapterManager } from '../src/adapters/manager';
import type { Adapter, AdapterKind, AuthProfile } from '../src/adapters/types';
import type { AdapterConfig } from '../src/config/schema';
import { buildClaudePrintInvocation } from '../src/adapters/claude/session';
import { readLines } from '../src/util/spawn';
import { Readable } from 'node:stream';

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
  configuration: { model: false, effortLevels: [], sandboxModes: [], reviewers: [] },
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
  { sessionId: 'session', cliSessionRef: 'session', extraDirs: ['D:/work'], model: 'native-model', effort: 'high' },
  'D:/private/settings.json',
  false,
  { text: 'private user prompt' },
);
check('claude prompt uses stdin', claudeInvocation.stdin === 'private user prompt');
check('claude prompt is absent from argv', !claudeInvocation.args.includes('private user prompt'));
check('claude print stream flags retained', claudeInvocation.args.includes('-p') && claudeInvocation.args.includes('stream-json'));
check('claude native effort is an argv option', claudeInvocation.args.includes('--effort') && claudeInvocation.args.includes('high'));

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
