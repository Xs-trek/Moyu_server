// Lightweight Clash TUN detection (S7, user choice): TUN adapter presence +
// per-family default-route capture (OS route table, robust) + static reminder.
// Does NOT read Clash config/API (external-controller often disabled; parsing unreliable).
// Verified commands in findings §6.
import { run } from '../util/spawn';
import { isWindows } from '../util/platform';
import type { ClashConflict } from './types';

const TUN_PATTERN = /mihomo|meta tunnel|wintun|\btun\b|clash/i;
const STATIC_REMINDER =
  '若 EasyTier P2P/relay 流量被 Clash TUN 捕获，建议在 Clash 中将公共节点 IP 与虚拟子网标 DIRECT（不自动改，S8）。';

export async function detectClashConflict(): Promise<ClashConflict> {
  try {
    return isWindows ? await detectWindows() : await detectLinux();
  } catch {
    return { detected: false, recommendation: STATIC_REMINDER };
  }
}

interface AdapterInfo {
  name: string;
  desc: string;
  ifIndex: number;
}

async function detectWindows(): Promise<ClashConflict> {
  // Select-Object preserves PascalCase property names (Name/InterfaceDescription);
  // rename to lowercase so they match AdapterInfo. Collect ALL default-route
  // ifIndexes per family (Mihomo adds a 0.0.0.0/0 competing with the physical one,
  // both RouteMetric 0 — "first by metric" is non-deterministic; use some()).
  const script =
    "$ad = Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | " +
    "Select-Object @{n='name';e={$_.Name}}, @{n='desc';e={$_.InterfaceDescription}}, ifIndex; " +
    "$v4 = @((Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ifIndex)); " +
    "$v6 = @((Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ifIndex)); " +
    "@{adapters=$ad; v4=$v4; v6=$v6} | ConvertTo-Json -Depth 5";
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  if (r.code !== 0 || !r.stdout.trim()) return { detected: false, recommendation: STATIC_REMINDER };
  const obj = JSON.parse(r.stdout) as {
    adapters: AdapterInfo[] | AdapterInfo;
    v4: number[] | number;
    v6: number[] | number;
  };
  const adapters = Array.isArray(obj.adapters) ? obj.adapters : [obj.adapters];
  const tun = adapters.find((a) => TUN_PATTERN.test(`${a.name} ${a.desc}`));
  if (!tun) return { detected: false, recommendation: STATIC_REMINDER };
  const v4arr = Array.isArray(obj.v4) ? obj.v4 : obj.v4 != null ? [obj.v4] : [];
  const v6arr = Array.isArray(obj.v6) ? obj.v6 : obj.v6 != null ? [obj.v6] : [];
  return {
    detected: true,
    tunAdapter: tun.name,
    tunIfIndex: tun.ifIndex,
    defaultRouteCaptured: {
      ipv4: v4arr.some((x) => x === tun.ifIndex),
      ipv6: v6arr.some((x) => x === tun.ifIndex),
    },
    recommendation: STATIC_REMINDER,
  };
}

async function detectLinux(): Promise<ClashConflict> {
  // `ip -j route` returns JSON on modern iproute2
  const r = await run('ip', ['-j', 'addr'], { timeout: 5000 });
  if (r.code !== 0 || !r.stdout.trim()) return { detected: false, recommendation: STATIC_REMINDER };
  const ifaces = JSON.parse(r.stdout) as Array<{
    ifname: string;
    ifindex: number;
    addr_info?: Array<{ family?: string; local?: string }>;
  }>;
  const tun = ifaces.find((i) => TUN_PATTERN.test(i.ifname));
  if (!tun) return { detected: false, recommendation: STATIC_REMINDER };
  const routeR = await run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 });
  const v4Route = routeR.stdout ? (JSON.parse(routeR.stdout) as Array<{ ifindex?: number }>) : [];
  const v6R = await run('ip', ['-6', 'route', 'show', 'default'], { timeout: 5000 });
  return {
    detected: true,
    tunAdapter: tun.ifname,
    tunIfIndex: tun.ifindex,
    defaultRouteCaptured: {
      ipv4: v4Route.some((x) => x.ifindex === tun.ifindex),
      ipv6: /default/.test(v6R.stdout) && v6RouteUses(v6R.stdout, tun.ifname),
    },
    recommendation: STATIC_REMINDER,
  };
}

function v6RouteUses(stdout: string, ifname: string): boolean {
  return new RegExp(`dev\\s+${ifname}\\b`).test(stdout);
}
