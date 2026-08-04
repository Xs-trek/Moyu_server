// Unit tests for live reconfigure after a config PATCH (review P1: PATCH only reassigned
// ctx.config; NetProbe's publicNode + EasyTierController's network + logger level were
// captured at construction, so a PATCH never reached the running overlay/probe).
// Offline: verifies the no-spawn reconfigure path (no real easytier bin, no OS probes, no
// running child). The restart-on-change-while-running path needs a real binary and is
// covered by smoke-easytier.ts.
// Run: npx tsx test/unit-net.ts
import { EasyTierController } from '../src/net/easytier';
import { NetProbe } from '../src/net/probe';
import { createInboundPolicy } from '../src/net/types';
import { run } from '../src/util/spawn';
import type { NetworkConfig } from '../src/config/schema';

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

async function main(): Promise<void> {
  // EasyTierController: construct with an unconfigured network (no publicNode, no bin).
  const empty = {
    publicNode: '',
    networkName: '',
    networkSecret: '',
    easytierBin: '',
  } as NetworkConfig;
  const e = new EasyTierController(empty);
  const initial = e.getState().status;
  check('starts stopped/not-configured', initial === 'stopped' || initial === 'not-configured');

  // reconfigure with the SAME cfg -> no material change -> no restart.
  let restarted = await e.reconfigure(empty);
  check('reconfigure same cfg -> no restart', restarted === false);
  check('same-cfg reconfigure did not spawn', e.getState().status !== 'running');

  // reconfigure with a CHANGED publicNode, but no running child -> adopts cfg, no spawn.
  const changed = {
    publicNode: 'tcp://1.2.3.4:11010',
    networkName: 'n',
    networkSecret: 's',
    easytierBin: '',
  } as NetworkConfig;
  restarted = await e.reconfigure(changed);
  check('reconfigure changed cfg + no running child -> no restart', restarted === false);
  check('changed-cfg reconfigure did not spawn', e.getState().status !== 'running');

  // getState reflects the adopted bin slot (still no spawn).
  check('getState does not throw after reconfigure', typeof e.getState().status === 'string');

  // NetProbe.setPublicNode: setter is harmless + invalidates cache (no throw).
  const np = new NetProbe('tcp://old:1');
  let threw = false;
  try {
    np.setPublicNode('tcp://new:2');
  } catch {
    threw = true;
  }
  check('setPublicNode does not throw', !threw);
  const inbound = createInboundPolicy('127.0.0.1', '10.1.1.10/32');
  check('inbound policy declares loopback overlay map', inbound.mode === 'loopback-via-overlay-map');
  check('inbound policy requires API bearer without firewall mutation', inbound.apiBearerRequired && !inbound.hostFirewallMutation);

  // §1: mobileJoinParams outputs the N4 SOCKS5 baseline (loopback) + optional port-forward.
  const cfg2 = {
    publicNode: 'tcp://1.2.3.4:11010',
    networkName: 'n',
    networkSecret: 's',
    easytierBin: '',
    virtualIp: '10.144.144.1',
    backendMapCidr: '10.1.1.10/32',
  } as NetworkConfig;
  const e2 = new EasyTierController(cfg2);
  // Constructor launch-mode regression: the primary PC overlay must retain its listeners,
  // while the transient pairing overlay must be outbound-only so both can coexist.
  // pcArgs is intentionally private runtime plumbing; this white-box check keeps the
  // production API from exposing an argv containing networkSecret.
  const primaryArgs = (e2 as unknown as { pcArgs(): string[] }).pcArgs();
  const pairingController = new EasyTierController(cfg2, {
    noListener: true,
    rpcPortal: '127.0.0.3:0',
  });
  const pairingArgs = (pairingController as unknown as { pcArgs(): string[] }).pcArgs();
  check('pairing regression: primary PC overlay keeps listeners', !primaryArgs.includes('--no-listener'));
  check('pairing regression: outbound-only overlay disables listeners', pairingArgs.includes('--no-listener'));
  check('pairing regression: primary RPC stays off-map on 127.0.0.2', primaryArgs[primaryArgs.indexOf('--rpc-portal') + 1] === '127.0.0.2:0');
  check('pairing regression: second RPC uses distinct off-map loopback', pairingArgs[pairingArgs.indexOf('--rpc-portal') + 1] === '127.0.0.3:0');
  const jp = e2.mobileJoinParams(18081);
  check('§1 mode socks5 (N4 baseline)', jp.mode === 'socks5');
  check('§1 configFile binds 127.0.0.1 loopback-only', /socks5:\/\/127\.0\.0\.1:1080/.test(jp.configFile) && !/0\.0\.0\.0/.test(jp.configFile));
  check('§1 socks5Port 1080', jp.socks5Port === 1080);
  check('§1 targetHost 10.1.1.10', jp.targetHost === '10.1.1.10');
  check('§1 targetPort = gwPort', jp.targetPort === 18081);
  check('§1 baseline args have no --socks5 (config file binds loopback)', !jp.args.includes('--socks5'));
  check('§1 baseline args have no --port-forward (optional only)', !jp.args.includes('--port-forward'));
  check('§1 args force --private-mode true', jp.args.includes('--private-mode') && jp.args[jp.args.indexOf('--private-mode') + 1] === 'true');
  check('§1 portForward optional + loopback 1081', !!jp.portForward && jp.portForward.localPort === 1081);
  check('§1 portForward args include --port-forward', !!jp.portForward && jp.portForward.args.includes('--port-forward'));

  // N1: udp:// public node is not TCP-probed (UDP accepts no TCP handshake; EasyTier nodes
  // speak their own UDP protocol, not STUN). Marked unverifiable (reliable=false) so
  // computeVerdict degrades instead of dead-zoning when mobile has no IPv6. Does not touch the
  // network -- the udp branch returns before tcpConnect.
  const npUdp = new NetProbe('udp://1.2.3.4:11010');
  const ud = await (npUdp as any).probePublicNode(null);
  check('N1: udp publicNode -> reliable=false (unverifiable)', !!ud && ud.reliable === false);
  check('N1: udp publicNode -> tcpConnectOk=false (not probed)', !!ud && ud.tcpConnectOk === false);
  check('N1: udp publicNode -> note set', !!ud && typeof ud.note === 'string' && ud.note.length > 0);

  // [L]⑤: run() caps one-shot probe output at 2MB (was unbounded accumulation).
  const big = await run(process.execPath, ['-e', "process.stdout.write('x'.repeat(3*1024*1024))"], { timeout: 15000 });
  check('[L]⑤: >2MB stdout truncated (marker present)', big.stdout.includes('[...truncated...]'));
  check('[L]⑤: stdout capped under 3MB', big.stdout.length < 3 * 1024 * 1024);

  console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
  if (fail) process.exitCode = 1;
}

void main();
