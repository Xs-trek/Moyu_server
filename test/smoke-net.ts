// Smoke test for NetProbe (detect-only network layer) on the local machine.
// Verifies: IPv6 GUA + RFC4941 temp-addr, inbound firewall default, Clash TUN
// capture, public-node TCP reachability, and the dead-zone verdict.
// Run: npx tsx test/smoke-net.ts
import { NetProbe } from '../src/net/probe';

const PUBLIC_NODE = process.env.PUBLIC_NODE ?? 'tcp://47.109.138.211:11010';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main(): Promise<void> {
  const probe = new NetProbe(PUBLIC_NODE);

  console.log('# NetProbe smoke (detect-only, N5)');
  console.log(`  publicNode config = ${PUBLIC_NODE}`);

  const status = await probe.refresh();

  console.log('\n## NetProfile');
  console.log(JSON.stringify(status.profile, null, 2));

  console.log('\n## PublicNodeReachability');
  console.log(JSON.stringify(status.publicNode, null, 2));

  console.log('\n## LinkVerdict');
  console.log(JSON.stringify(status.verdict, null, 2));

  console.log('\n## Assertions');
  assert(status.profile.clash.detected === true, 'Clash TUN detected (Mihomo expected on this machine)');
  assert(
    typeof status.profile.clash.tunIfIndex === 'number',
    `tunIfIndex present (=${status.profile.clash.tunIfIndex})`,
  );
  assert(
    status.profile.clash.defaultRouteCaptured?.ipv4 === true,
    `IPv4 default route captured by TUN (=${status.profile.clash.defaultRouteCaptured?.ipv4})`,
  );
  assert(status.profile.ipv6GuaAvailable === true, 'IPv6 GUA available (this machine has v6)');
  assert(!!status.profile.tempAddress, `temp addr present (current=${status.profile.tempAddress?.current})`);
  assert(
    status.profile.inboundFirewallDefault !== 'unknown',
    `firewall default resolved (=${status.profile.inboundFirewallDefault})`,
  );
  assert(!!status.publicNode, 'public node parsed from config URL');
  assert(typeof status.publicNode?.tcpConnectOk === 'boolean', `tcpConnectOk resolved (=${status.publicNode?.tcpConnectOk})`);
  // Under Clash TUN the probe must be marked unreliable (findings §6.5).
  assert(status.publicNode?.reliable === false, `public node probe unreliable under TUN (reliable=${status.publicNode?.reliable})`);
  assert(
    status.verdict.overall === 'degraded',
    `verdict degraded under unverifiable probe (=${status.verdict.overall})`,
  );

  console.log(`\n${
    process.exitCode ? 'SMOKE FAILED' : 'SMOKE PASSED'
  } (overall=${status.verdict.overall}, reliable=${status.publicNode?.reliable}, tcpConnectOk=${status.publicNode?.tcpConnectOk})`);
  console.log('NOTE: under Clash TUN the TCP probe is a false positive (reliable=false); mark the node IP DIRECT in Clash, then re-probe for a trustworthy result.');
}

main().catch((e) => {
  console.error('smoke error', e);
  process.exit(1);
});
