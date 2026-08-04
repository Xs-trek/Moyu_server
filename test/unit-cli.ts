import { parseArgs, probePublicNode, VERSION } from '../src/cli';
import { toClientFailure } from '../src/api/failure';

let failed = 0;
function check(name: string, condition: boolean): void {
  console.log(`  ${condition ? '✓' : '✗'} ${name}`);
  if (!condition) failed++;
}

check('v0.0.2 version source', VERSION === '0.0.2');
check('moyu -help accepted', parseArgs(['-help']).kind === 'help');
check('moyu --help accepted', parseArgs(['--help']).kind === 'help');
check('moyu -h accepted', parseArgs(['-h']).kind === 'help');
check('moyu -init accepted', parseArgs(['-init']).kind === 'init');
check('moyu --init accepted', parseArgs(['--init']).kind === 'init');
check('bare init compatibility', parseArgs(['init']).kind === 'init');
check('moyu -pair accepted', parseArgs(['-pair']).kind === 'pair');
check('bare pair compatibility', parseArgs(['pair']).kind === 'pair');
check('moyu -exit accepted', parseArgs(['-exit']).kind === 'exit');
check('bare exit compatibility', parseArgs(['exit']).kind === 'exit');
check('no args ensures background start', parseArgs([]).kind === 'start');
check('hidden daemon foreground action', parseArgs(['--daemon-run']).kind === 'daemon-run');
check('relative config is retained by parser', (parseArgs(['-init', '-config', 'config.json']) as { configPath?: string }).configPath === 'config.json');
check('hidden relay requires descriptor', parseArgs(['hook-relay']).kind === 'usage');
const relay = parseArgs(['hook-relay', 'C:/tmp/relay.json']);
check('hidden relay accepts descriptor', relay.kind === 'hook-relay' && relay.relayConfigPath === 'C:/tmp/relay.json');
check('queue full is retryable 429', toClientFailure(new Error('session input queue full')).status === 429 &&
  toClientFailure(new Error('session input queue full')).retryable);
check('stale approval is stable 409', toClientFailure(new Error('approval is not pending')).code === 'approval_not_pending');
check('oversized body is stable 413', toClientFailure(new Error('body too large')).status === 413);
check('relay probe blocks known provider before network', !(await probePublicNode('tcp://api.openai.com:443')).ok);
check('unexpected failure does not echo detail', toClientFailure(new Error('private path and token')).summary === 'operation failed');

console.log(`\nCLI/FAILURE UNIT: ${failed ? `${failed} failed` : 'ALL PASS'}`);
if (failed) process.exitCode = 1;
