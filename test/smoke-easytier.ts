// In-process smoke for EasyTierController (no HTTP/port guessing).
// Verifies: start -> running, getState, mobileJoinParams (correct verified flags),
// graceful stop (status stopped + no orphan easytier process), and graceful
// degradation when publicNode is absent (C5: not-configured, no throw).
// Run: npx tsx test/smoke-easytier.ts
import { execSync } from 'node:child_process';
import { EasyTierController } from '../src/net/easytier';
import type { NetworkConfig } from '../src/config/schema';

const BIN = process.env.EASYTIER_BIN ?? 'bin/win-x64/easytier-core.exe';
const PUB = 'tcp://203.0.113.5:11010';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ FAIL: ${name}`);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function easytierRunningCount(): number {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq easytier-core.exe" /NH /FO CSV', { windowsHide: true }).toString();
    return out.split('\n').filter((l) => /easytier-core/i.test(l)).length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  // clean slate
  try {
    execSync('taskkill /F /IM easytier-core.exe', { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* none */
  }
  await sleep(1000);
  check('no easytier at start', easytierRunningCount() === 0);

  console.log('# 1. graceful degradation: no publicNode => not-configured, no throw');
  {
    const cfg: NetworkConfig = { publicNode: '', easytierBin: BIN, privateMode: true, networkName: 'rd', networkSecret: 's' };
    const c = new EasyTierController(cfg);
    await c.start();
    const st = c.getState();
    check('status not-configured', st.status === 'not-configured');
    check('error mentions publicNode', /publicNode/.test(st.error ?? ''));
    await c.stop();
  }

  console.log('# 2. start -> running, verified flags, then stop');
  {
    const cfg: NetworkConfig = {
      publicNode: PUB,
      easytierBin: BIN,
      virtualIp: '10.144.144.1',
      backendMapCidr: '10.1.1.10/32',
      privateMode: true,
      networkName: 'rd-smoke',
      networkSecret: 'testsecret',
    };
    const c = new EasyTierController(cfg);

    // mobileJoinParams: N4 SOCKS5 baseline (loopback) + optional port-forward optimization.
    const gwPort = 18081;
    const jp = c.mobileJoinParams(gwPort);
    check('mode is socks5 (N4 baseline)', jp.mode === 'socks5');
    check('configFile binds socks5 to loopback 127.0.0.1:1080', /socks5:\/\/127\.0\.0\.1:1080/.test(jp.configFile));
    check('configFile does NOT bind 0.0.0.0 (loopback-only)', !/0\.0\.0\.0/.test(jp.configFile));
    check('socks5Port is 1080 (phone loopback)', jp.socks5Port === 1080);
    check('targetHost is backend VIP 10.1.1.10', jp.targetHost === '10.1.1.10');
    check('targetPort is gatewayPort', jp.targetPort === gwPort);
    // args = verified CLI flags for everything EXCEPT socks5/port-forward.
    check('args include --no-tun', jp.args.includes('--no-tun'));
    check('args include --use-smoltcp', jp.args.includes('--use-smoltcp'));
    check('args include -i <mobileVip>', jp.args.includes('-i') && jp.args[jp.args.indexOf('-i') + 1] === jp.mobileVip);
    check('args include -e <public>', jp.args.includes('-e') && jp.args[jp.args.indexOf('-e') + 1] === PUB);
    check('args include --private-mode true (§2 forced)', jp.args.includes('--private-mode') && jp.args[jp.args.indexOf('--private-mode') + 1] === 'true');
    check('args include --latency-first', jp.args.includes('--latency-first'));
    check('args include --encryption-algorithm aes-256-gcm', jp.args.includes('--encryption-algorithm') && jp.args[jp.args.indexOf('--encryption-algorithm') + 1] === 'aes-256-gcm');
    check('args include --no-listener', jp.args.includes('--no-listener'));
    check('args include --rpc-portal 127.0.0.2:0', jp.args.includes('--rpc-portal') && jp.args[jp.args.indexOf('--rpc-portal') + 1] === '127.0.0.2:0');
    check('baseline args do NOT include --socks5 (config file handles loopback bind)', !jp.args.includes('--socks5'));
    check('baseline args do NOT include --port-forward (it is optional)', !jp.args.includes('--port-forward'));
    check('portForward optimization present + loopback-bound (1081)', !!jp.portForward && jp.portForward.localPort === 1081);
    check('portForward args include --port-forward tcp://127.0.0.1:1081/10.1.1.10:<gwPort>',
      !!jp.portForward && jp.portForward.args.includes('--port-forward') && jp.portForward.args[jp.portForward.args.indexOf('--port-forward') + 1] === `tcp://127.0.0.1:1081/10.1.1.10:${gwPort}`);
    check('join includes networkName', jp.networkName === 'rd-smoke');
    check('join includes secret (for trusted client)', !!jp.networkSecret && jp.networkSecret === 'testsecret');
    check('join backendVip is 10.1.1.10', jp.backendVip === '10.1.1.10');
    check('join gatewayPort echoed', jp.gatewayPort === gwPort);

    await c.start();
    await sleep(2500);
    const st = c.getState();
    console.log('     state:', JSON.stringify(st));
    check('status running', st.status === 'running');
    check('pid present', typeof st.pid === 'number');
    check('virtualIp recorded', st.virtualIp === '10.144.144.1');
    check('publicNode recorded', st.publicNode === PUB);
    check('easytier process alive', easytierRunningCount() >= 1);

    // Regression: the transient pairing overlay must coexist with the already-running
    // primary overlay. Without --no-listener the second process exits on TCP 11010.
    const pairCfg: NetworkConfig = {
      ...cfg,
      virtualIp: '10.144.144.2',
      backendMapCidr: '10.1.1.11/32',
      networkName: 'rd-pair',
      networkSecret: 'paircode',
    };
    const pair = new EasyTierController(pairCfg, {
      noListener: true,
      rpcPortal: '127.0.0.3:0',
    });
    await pair.start();
    await sleep(2500);
    check('pairing overlay runs beside primary', pair.getState().status === 'running');
    check('two EasyTier processes coexist', easytierRunningCount() >= 2);
    await pair.stop();
    await sleep(1000);
    check('primary remains running after pairing stops', c.getState().status === 'running' && easytierRunningCount() >= 1);

    await c.stop();
    await sleep(1500);
    const st2 = c.getState();
    check('status stopped after stop', st2.status === 'stopped');
    check('no orphan easytier after stop', easytierRunningCount() === 0);
  }

  console.log(`\n${fail === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'} (${pass} pass, ${fail} fail)`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('smoke error', e);
  try {
    execSync('taskkill /F /IM easytier-core.exe', { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* */
  }
  process.exit(1);
});