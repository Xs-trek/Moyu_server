import { HELP, parseArgs, probePublicNode, runInitLifecycle, VERSION } from '../src/cli';
import { toClientFailure } from '../src/api/failure';

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`  ${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failed++;
}

check('v0.0.3 version source', VERSION === '0.0.3');
check('moyu -help accepted', parseArgs(['-help']).kind === 'help');
check('help documents Claude multi-OAuth configuration',
  HELP.includes('CLAUDE_CODE_OAUTH_TOKEN=...') &&
  HELP.includes('CLAUDE_CONFIG_DIR=<pre-logged-in OAuth config dir>'));
check('moyu --help accepted', parseArgs(['--help']).kind === 'help');
check('moyu -h accepted', parseArgs(['-h']).kind === 'help');
check('moyu -init accepted', parseArgs(['-init']).kind === 'init');
check('init help promises immediate one-time pairing output',
  HELP.includes('start in background, print a pairing string') &&
  HELP.includes('prints a five-minute pairing string for the phone'));
const initEvents: string[] = [];
const initResult = await runInitLifecycle('fixture.json', {
  init: async (path) => { initEvents.push(`init:${path}`); return 0; },
  stop: async (path, quiet) => { initEvents.push(`stop:${path}:${quiet}`); return 0; },
  start: async (path) => { initEvents.push(`start:${path}`); return 0; },
  pair: async (path) => { initEvents.push(`pair:${path}`); return 0; },
  notify: () => { initEvents.push('notify'); },
});
check('init waits for the restarted gateway then emits one-time pairing material', initResult === 0 &&
  initEvents.join('|') === 'init:fixture.json|stop:fixture.json:true|start:fixture.json|notify|pair:fixture.json');
const failedInitEvents: string[] = [];
const failedInitResult = await runInitLifecycle(undefined, {
  init: async () => { failedInitEvents.push('init'); return 0; },
  stop: async () => { failedInitEvents.push('stop'); return 0; },
  start: async () => { failedInitEvents.push('start'); return 7; },
  pair: async () => { failedInitEvents.push('pair'); return 0; },
  notify: () => { failedInitEvents.push('notify'); },
});
check('init fails closed before pairing when the gateway is unavailable',
  failedInitResult === 7 && failedInitEvents.join('|') === 'init|stop|start');
check('moyu --init accepted', parseArgs(['--init']).kind === 'init');
check('bare init compatibility', parseArgs(['init']).kind === 'init');
check('moyu -pair accepted', parseArgs(['-pair']).kind === 'pair');
check('bare pair compatibility', parseArgs(['pair']).kind === 'pair');
check('moyu -exit accepted', parseArgs(['-exit']).kind === 'exit');
check('bare exit compatibility', parseArgs(['exit']).kind === 'exit');
check('no args ensures background start', parseArgs([]).kind === 'start');
check('hidden daemon foreground action', parseArgs(['--daemon-run']).kind === 'daemon-run');
check('relative config is retained by parser', (parseArgs(['-init', '-config', 'config.json']) as { configPath?: string }).configPath === 'config.json');
check('hidden local check requires descriptor', parseArgs(['local-check']).kind === 'usage');
const relay = parseArgs(['local-check', 'C:/tmp/data.json']);
check('hidden local check accepts descriptor', relay.kind === 'local-check' && relay.relayConfigPath === 'C:/tmp/data.json');
check('queue full is retryable 429', toClientFailure(new Error('session input queue full')).status === 429 &&
  toClientFailure(new Error('session input queue full')).retryable);
check('stale approval is stable 409', toClientFailure(new Error('approval is not pending')).code === 'approval_not_pending');
check('oversized body is stable 413', toClientFailure(new Error('body too large')).status === 413);
check('relay probe blocks known provider before network', !(await probePublicNode('tcp://api.openai.com:443')).ok);
check('unexpected failure does not echo detail', toClientFailure(new Error('private path and token')).summary === 'operation failed');
const staleProfile = toClientFailure(new Error('unknown profile id: claude:env:private-name'));
check('stale profile gets an actionable stable error', staleProfile.status === 409 && staleProfile.code === 'profile_unavailable' &&
  !staleProfile.summary.includes('private-name'));
const unsupportedEffort = toClientFailure(new Error('unsupported effort for claude'));
check('unsupported effort gets a 400 contract error', unsupportedEffort.status === 400 && unsupportedEffort.code === 'unsupported_effort');
const privateAcl = toClientFailure(new Error('unable to apply private Windows ACL'));
check('private-file hardening failure stays fail-closed but actionable', privateAcl.status === 503 &&
  privateAcl.code === 'local_security_unavailable' && privateAcl.summary.includes('moyu -check'));
const approvalGuard = toClientFailure(new Error('Claude required command hooks are disabled or unavailable'));
check('Claude approval guard failure stays fail-closed but actionable', approvalGuard.status === 409 &&
  approvalGuard.code === 'approval_guard_unavailable' && approvalGuard.summary.includes('Claude'));

console.log(`\nCLI/FAILURE UNIT: ${failed ? `${failed} failed` : 'ALL PASS'}`);
if (failed) process.exitCode = 1;
