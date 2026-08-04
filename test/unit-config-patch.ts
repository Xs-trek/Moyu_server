// Unit tests for validateConfigPatch (review P2): applyPatch trusted the JSON shape, so a
// string approvalTimeoutSec -> NaN or a bad enum could persist into runtime config. This gates a
// 400 before any mutation. Run: npx tsx test/unit-config-patch.ts
import { validateConfigPatch, ENABLED_ADAPTER_KINDS } from '../src/config/schema';
import { applyPatch, loadConfig } from '../src/config/loader';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// --- valid patches (zero errors) ---
check('empty object valid', validateConfigPatch({}).length === 0);
check('unknown top-level key ignored (not an error)', validateConfigPatch({ unknownKey: 1 }).length === 0);
check('valid approvalTimeoutSec', validateConfigPatch({ approvalTimeoutSec: 120 }).length === 0);
check('valid boundary approvalTimeoutSec=10', validateConfigPatch({ approvalTimeoutSec: 10 }).length === 0);
check('valid boundary approvalTimeoutSec=590', validateConfigPatch({ approvalTimeoutSec: 590 }).length === 0);
check('valid logLevel', validateConfigPatch({ logLevel: 'debug' }).length === 0);
check('valid defaultAdapter', validateConfigPatch({ defaultAdapter: 'codex' }).length === 0);
check('§4 defaultAdapter opencode rejected (not enabled)', validateConfigPatch({ defaultAdapter: 'opencode' }).length > 0);
check('§4 defaultAdapter pty rejected (not enabled)', validateConfigPatch({ defaultAdapter: 'pty' }).length > 0);
check('§4 ENABLED_ADAPTER_KINDS = claude+codex only', ENABLED_ADAPTER_KINDS.length === 2 && ENABLED_ADAPTER_KINDS.includes('claude') && ENABLED_ADAPTER_KINDS.includes('codex') && !ENABLED_ADAPTER_KINDS.includes('opencode') && !ENABLED_ADAPTER_KINDS.includes('pty'));
check('valid adapter approvalPolicy', validateConfigPatch({ adapters: { claude: { approvalPolicy: 'never' } } }).length === 0);
check('valid adapter sandbox', validateConfigPatch({ adapters: { codex: { sandbox: 'danger-full-access' } } }).length === 0);
check('valid gateway range', validateConfigPatch({ gateway: { portMin: 18080, portMax: 18099 } }).length === 0);
check('valid network (publicNode only; privateMode no longer a patch field)', validateConfigPatch({ network: { publicNode: 'tcp://1.2.3.4:11010' } }).length === 0);
check('known provider cannot be configured as relay', validateConfigPatch({ network: { publicNode: 'tcp://api.anthropic.com:443' } }).length > 0);
check('valid ptyAddon', validateConfigPatch({ ptyAddon: { enabled: false } }).length === 0);

// --- invalid patches (>=1 error) ---
check('non-object patch invalid', validateConfigPatch('nope').length > 0);
check('string approvalTimeoutSec invalid (NaN prevention)', validateConfigPatch({ approvalTimeoutSec: 'abc' }).length > 0);
check('approvalTimeoutSec below 10 invalid', validateConfigPatch({ approvalTimeoutSec: 5 }).length > 0);
check('approvalTimeoutSec above 590 invalid', validateConfigPatch({ approvalTimeoutSec: 600 }).length > 0);
check('non-integer approvalTimeoutSec invalid', validateConfigPatch({ approvalTimeoutSec: 120.5 }).length > 0);
check('bad logLevel invalid', validateConfigPatch({ logLevel: 'verbose' }).length > 0);
check('bad defaultAdapter invalid', validateConfigPatch({ defaultAdapter: 'foo' }).length > 0);
check('bad approvalPolicy invalid', validateConfigPatch({ adapters: { claude: { approvalPolicy: 'always' } } }).length > 0);
check('bad sandbox invalid', validateConfigPatch({ adapters: { codex: { sandbox: 'full' } } }).length > 0);
check('bad approvalsReviewer invalid', validateConfigPatch({ adapters: { claude: { approvalsReviewer: 'boss' } } }).length > 0);
check('portMin > portMax invalid', validateConfigPatch({ gateway: { portMin: 20000, portMax: 18080 } }).length > 0);
check('string portMin invalid', validateConfigPatch({ gateway: { portMin: '18080' } }).length > 0);
check('portMin out of range invalid', validateConfigPatch({ gateway: { portMin: 0 } }).length > 0);
check('privateMode ignored (not a patch field, §2; unknown key => no error)', validateConfigPatch({ network: { privateMode: 'yes' } }).length === 0);
check('non-object network invalid', validateConfigPatch({ network: [] }).length > 0);
check('model too long invalid', validateConfigPatch({ adapters: { claude: { model: 'x'.repeat(200) } } }).length > 0);
check('non-string model invalid', validateConfigPatch({ adapters: { claude: { model: 42 } } }).length > 0);
check('non-object adapters invalid', validateConfigPatch({ adapters: 'x' }).length > 0);

// --- §2: private mode is forced + immutable (never PATCH-able) ---
{
  // loadConfig must force privateMode true even when the on-disk config carries false.
  const tmp = join(tmpdir(), `rd-patch-test-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify({
    gateway: { bindHost: '0.0.0.0' },
    network: { publicNode: '', privateMode: false, networkName: 'rd', networkSecret: 's' },
  }));
  try {
    const base = loadConfig(tmp); // §2: forces privateMode true + persists to tmp
    base.adapters.claude.configDir = 'C:\\local-only-claude';
    check('loadConfig forces privateMode true from disk false (§2)', base.network.privateMode === true);
    check('loadConfig forces gateway bindHost to loopback', base.gateway.bindHost === '127.0.0.1');
    // applyPatch must NOT let a PATCH disable privateMode (stays true); other fields still apply.
    const attacked = applyPatch(base, {
      network: { publicNode: 'tcp://1.2.3.4:11010', privateMode: false },
      adapters: { claude: { configDir: 'C:\\remote-attacker' } },
    } as never);
    check('applyPatch ignores privateMode:false (stays true, §2)', attacked.network.privateMode === true);
    check('applyPatch still applies publicNode alongside', attacked.network.publicNode === 'tcp://1.2.3.4:11010');
    check('applyPatch cannot change PC-local adapter configDir', attacked.adapters.claude.configDir === 'C:\\local-only-claude');
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* temp */ }
  }
}

// --- error messages are human-readable (smoke) ---
const errs = validateConfigPatch({ approvalTimeoutSec: 'abc', logLevel: 'nope' });
check('returns multiple distinct errors', errs.length >= 2);

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
if (fail) process.exitCode = 1;
