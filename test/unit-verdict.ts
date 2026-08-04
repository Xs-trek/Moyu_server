// Unit tests for computeVerdict covering branches the live Windows machine
// cannot reach (Clash TUN always makes the probe unreliable there):
//   ok, dead-zone, degraded(down+v6), degraded(unverifiable), unknown.
// Run: npx tsx test/unit-verdict.ts
import { computeVerdict } from '../src/net/probe';
import type { ClashConflict, NetProfile, PublicNodeReachability } from '../src/net/types';

const profile: NetProfile = {
  ipv6GuaAvailable: true,
  inboundFirewallDefault: 'block',
  natType: 'unknown',
  clash: null,
};

const clash: ClashConflict = {
  detected: true,
  tunAdapter: 'Mihomo',
  tunIfIndex: 18,
  defaultRouteCaptured: { ipv4: true, ipv6: false },
  recommendation: '',
};

function mkPub(opts: Partial<PublicNodeReachability>): PublicNodeReachability {
  return { host: '1.2.3.4', port: 11010, tcpConnectOk: false, reliable: true, ...opts };
}

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

// 1. reliable + ok + (mobile v6 true) => ok
check(
  'reliable+ok => ok',
  computeVerdict(profile, mkPub({ tcpConnectOk: true, reliable: true }), true).overall === 'ok',
);

// 2. reliable + ok + mobile v6 false => still ok (public node works, dead-zone needs node DOWN)
check(
  'reliable+ok + no-mobile-v6 => ok',
  computeVerdict(profile, mkPub({ tcpConnectOk: true, reliable: true }), false).overall === 'ok',
);

// 3. reliable + DOWN + mobile v6 false => dead-zone
check(
  'reliable+down + no-mobile-v6 => dead-zone',
  computeVerdict(profile, mkPub({ tcpConnectOk: false, reliable: true }), false).overall === 'dead-zone',
);

// 4. reliable + DOWN + mobile v6 true => degraded (P2P fallback)
check(
  'reliable+down + mobile-v6 => degraded',
  computeVerdict(profile, mkPub({ tcpConnectOk: false, reliable: true }), true).overall === 'degraded',
);

// 5. reliable + DOWN + mobile v6 unknown => degraded (not dead-zone; need confirmed no-v6)
check(
  'reliable+down + mobile-v6-unknown => degraded (not dead-zone)',
  computeVerdict(profile, mkPub({ tcpConnectOk: false, reliable: true }), undefined).overall === 'degraded',
);

// 6. unreliable (TUN) + mobile v6 false => degraded (NOT dead-zone; can't confirm node down)
{
  const v = computeVerdict({ ...profile, clash }, mkPub({ tcpConnectOk: true, reliable: false }), false);
  check('unreliable + no-mobile-v6 => degraded (not dead-zone)', v.overall === 'degraded');
  check('unreliable rationale mentions TUN/DIRECT', v.rationale.some((r) => /DIRECT|TUN/.test(r)));
}

// 7. no public node => unknown
check('no public node => unknown', computeVerdict(profile, null, true).overall === 'unknown');

console.log(`\n${fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED'} (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
