// NetProbe (N5: detect-only, never modify). Builds NetProfile (IPv6 GUA + RFC4941
// temp addr lifetimes, inbound firewall default, Clash TUN), probes public-node
// TCP reachability, and computes a LinkVerdict with the dead-zone rule (C8/N6).
// NAT classification is intentionally not actively probed: it would add another outbound
// protocol and is not needed by the IPv6/public-node dead-zone verdict.
import { createConnection } from 'node:net';
import { run } from '../util/spawn';
import { isWindows } from '../util/platform';
import { detectClashConflict } from './clash';
import { assertNotProviderHost } from './egress';
import type {
  ClashConflict,
  Ipv6TempAddress,
  InboundPolicy,
  LinkVerdict,
  NetProfile,
  NetStatus,
  PublicNodeReachability,
} from './types';
import { createInboundPolicy } from './types';
import type { NetStatusProvider } from '../context';

function tcpConnect(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; latencyMs?: number }> {
  const start = Date.now();
  return new Promise((res) => {
    const sock = createConnection({ host, port }, () => {
      res({ ok: true, latencyMs: Date.now() - start });
      sock.destroy(); // [L]⑥: release fd immediately (was end() half-close; timeout path still destroy()s)
    });
    sock.setTimeout(timeoutMs);
    sock.on('timeout', () => {
      sock.destroy();
      res({ ok: false });
    });
    sock.on('error', () => res({ ok: false }));
  });
}

function parseTimespan(s: string | undefined): number {
  if (!s) return 0;
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 4) return parts[0]! * 86400 + parts[1]! * 3600 + parts[2]! * 60 + parts[3]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return 0;
}

interface NetDetect {
  ipv6GuaAvailable: boolean;
  tempAddress?: Ipv6TempAddress;
  fw: 'allow' | 'block' | 'unknown';
}

async function detectWindowsNet(): Promise<NetDetect> {
  // PowerShell enums (SuffixOrigin/PrefixOrigin/DefaultInboundAction) serialize as
  // integers, so coerce to strings via .ToString() to compare reliably.
  const script =
    "$ip = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.IPAddress -notlike 'fe80*' -and $_.IPAddress -ne '::1' -and $_.IPAddress -notlike 'f*' } | " +
    "Select-Object @{n='IP';e={$_.IPAddress}}, @{n='Suffix';e={$_.SuffixOrigin.ToString()}}, " +
    "@{n='Prefix';e={$_.PrefixOrigin.ToString()}}, @{n='Pref';e={($_.PreferredLifetime).ToString()}}, " +
    "@{n='Valid';e={($_.ValidLifetime).ToString()}}; " +
    "$fw = Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction SilentlyContinue | " +
    "Select-Object Name, @{n='Action';e={$_.DefaultInboundAction.ToString()}}; " +
    "@{ipv6=$ip; fw=$fw} | ConvertTo-Json -Depth 5";
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000 });
  if (r.code !== 0 || !r.stdout.trim()) return { ipv6GuaAvailable: false, fw: 'unknown' };
  let obj: { ipv6: unknown; fw: unknown };
  try {
    obj = JSON.parse(r.stdout) as { ipv6: unknown; fw: unknown };
  } catch {
    // [L]④: malformed stdout (non-JSON, e.g. warnings on stdout) -> unknown, don't crash refresh -> 500
    return { ipv6GuaAvailable: false, fw: 'unknown' };
  }
  const addrs = (Array.isArray(obj.ipv6) ? obj.ipv6 : obj.ipv6 ? [obj.ipv6] : []) as Array<{
    IP: string;
    Suffix: string;
    Prefix: string;
    Pref: string;
    Valid: string;
  }>;
  let gua = false;
  let temp: Ipv6TempAddress | undefined;
  for (const a of addrs) {
    const isGua = /^2/.test(a.IP) && a.Prefix === 'RouterAdvertisement';
    if (isGua) gua = true;
    if (isGua && a.Suffix === 'Random' && !temp) {
      const pref = parseTimespan(a.Pref);
      temp = {
        current: a.IP,
        preferredLifetimeSec: pref,
        validLifetimeSec: parseTimespan(a.Valid),
        estimatedRotationAt: new Date(Date.now() + pref * 1000 - 5000).toISOString(),
      };
    }
  }
  const fwArr = (Array.isArray(obj.fw) ? obj.fw : obj.fw ? [obj.fw] : []) as Array<{
    Action?: string;
  }>;
  const fw = fwArr.some((p) => p.Action === 'Block')
    ? 'block'
    : fwArr.some((p) => p.Action === 'Allow')
      ? 'allow'
      : 'unknown';
  return { ipv6GuaAvailable: gua, tempAddress: temp, fw };
}

async function detectLinuxNet(): Promise<NetDetect> {
  const r = await run('ip', ['-6', 'addr'], { timeout: 5000 });
  let gua = false;
  let temp: Ipv6TempAddress | undefined;
  if (r.code === 0) {
    const lines = r.stdout.split('\n');
    for (const line of lines) {
      // inet6 2409:... scope global dynamic ... temporary
      const m = /inet6\s+(2[0-9a-f:]+)\b.*scope global(?:\s+([\s\S]*))?/i.exec(line);
      if (m) {
        gua = true;
        if (/temporary|mngtmpaddr/.test(line) && !temp) {
          temp = {
            current: m[1]!,
            preferredLifetimeSec: 0,
            validLifetimeSec: 0,
            estimatedRotationAt: new Date(Date.now() + 86400 * 1000).toISOString(),
          };
        }
      }
    }
  }
  // firewall: ufw then iptables
  let fw: 'allow' | 'block' | 'unknown' = 'unknown';
  const ufw = await run('ufw', ['status', 'verbose'], { timeout: 4000 });
  if (ufw.code === 0) {
    fw = /default:\s*deny/i.test(ufw.stdout) ? 'block' : /default:\s*allow/i.test(ufw.stdout) ? 'allow' : 'unknown';
  } else {
    const ipt = await run('iptables', ['-S', 'INPUT'], { timeout: 4000 });
    if (ipt.code === 0) {
      fw = /-P INPUT DROP/i.test(ipt.stdout) ? 'block' : /-P INPUT ACCEPT/i.test(ipt.stdout) ? 'allow' : 'unknown';
    }
  }
  return { ipv6GuaAvailable: gua, tempAddress: temp, fw };
}

async function detectNetProfile(): Promise<NetProfile> {
  const clash = await detectClashConflict();
  const det = isWindows ? await detectWindowsNet() : await detectLinuxNet();
  return {
    ipv6GuaAvailable: det.ipv6GuaAvailable,
    tempAddress: det.tempAddress,
    inboundFirewallDefault: det.fw,
    natType: 'unknown',
    clash,
  };
}

export function computeVerdict(
  profile: NetProfile,
  publicNode: PublicNodeReachability | null,
  mobileV6?: boolean,
): LinkVerdict {
  const rationale: string[] = [];
  const pubConfirmedUp = !!publicNode && publicNode.reliable && publicNode.tcpConnectOk;
  const pubConfirmedDown = !!publicNode && publicNode.reliable && !publicNode.tcpConnectOk;
  const pubUnverifiable = !!publicNode && !publicNode.reliable;

  // Dead-zone (C8/N6) ONLY when we have CONFIRMED the public node is down AND the
  // mobile side has no IPv6. An unverifiable probe (Clash TUN) must NOT trigger
  // dead-zone - we don't actually know the node is down.
  const deadZone = mobileV6 === false && pubConfirmedDown;

  let overall: LinkVerdict['overall'];
  if (deadZone) {
    overall = 'dead-zone';
    rationale.push('移动端无 IPv6 且公共节点确认不可达 = 死区 (C8/N6)，不重试');
  } else if (pubConfirmedUp) {
    overall = 'ok';
    rationale.push('公共节点可达（探测可信），relay 路径可用');
  } else if (pubUnverifiable) {
    overall = 'degraded';
    rationale.push(
      '公共节点可达性无法验证：Clash TUN 捕获默认路由，TCP 连接被本地完成（伪成功）。请在 Clash 中将公共节点 IP 标为 DIRECT 后复测（S8，不自动改）',
    );
  } else if (pubConfirmedDown) {
    overall = 'degraded';
    rationale.push('公共节点确认不可达；移动端若有 IPv6 仍可走 P2P');
  } else {
    overall = 'unknown';
    rationale.push('公共节点状态未知');
  }
  if (profile.clash?.detected) {
    const c = profile.clash;
    rationale.push(
      `Clash TUN 检测到 (${c.tunAdapter}, ifIndex=${c.tunIfIndex})；IPv4 捕获=${c.defaultRouteCaptured?.ipv4}, IPv6 捕获=${c.defaultRouteCaptured?.ipv6}`,
    );
  }
  return { publicNode, mobileV6Available: mobileV6, overall, rationale };
}

export class NetProbe implements NetStatusProvider {
  private cached: NetStatus | null = null;
  private cacheTs = 0;
  private readonly ttlMs = 8000;

  constructor(
    private publicNodeUrl: string,
    private inboundPolicy: InboundPolicy = createInboundPolicy('127.0.0.1'),
  ) {}

  /** Apply a new publicNode live (review P1: PATCH must reconfigure). Invalidates the cache so
   *  the next getStatus/refresh re-probes the new node. */
  setPublicNode(url: string): void {
    this.publicNodeUrl = url;
    this.cached = null;
    this.cacheTs = 0;
  }

  setInboundPolicy(policy: InboundPolicy): void {
    this.inboundPolicy = policy;
    this.cached = null;
    this.cacheTs = 0;
  }

  async getStatus(): Promise<NetStatus> {
    if (this.cached && Date.now() - this.cacheTs < this.ttlMs) return this.cached;
    return this.refresh();
  }

  async refresh(mobileV6?: boolean): Promise<NetStatus> {
    const profile = await detectNetProfile();
    const publicNode = await this.probePublicNode(profile.clash);
    const verdict = computeVerdict(profile, publicNode, mobileV6);
    this.cached = { profile, publicNode, verdict, inboundPolicy: this.inboundPolicy, checkedAt: new Date().toISOString() };
    this.cacheTs = Date.now();
    return this.cached;
  }

  private async probePublicNode(clash: ClashConflict | null): Promise<PublicNodeReachability | null> {
    if (!this.publicNodeUrl) return null;
    const schemeMatch = /^(tcp|udp|ws|wss):\/\//.exec(this.publicNodeUrl);
    const m = /(?:tcp|udp|ws|wss):\/\/([^:/]+):(\d+)/.exec(this.publicNodeUrl) ?? /([^:/]+):(\d+)/.exec(this.publicNodeUrl);
    if (!m || !m[1] || !m[2]) return null;
    const host = m[1];
    const port = Number(m[2]);
    // C3 0-perception: the backend must never connect to an AI-provider host. The relay URL is
    // user-configured; this OPTIONAL guard (§12: defense-in-depth, not the acceptance basis)
    // blocks a misconfigured URL that points at a KNOWN provider domain. It cannot catch an
    // unknown provider domain; the architectural invariant + static egress check are the real
    // guarantee. No legitimate relay is a provider domain.
    assertNotProviderHost(host);
    // N1: udp:// nodes cannot be probed via TCP connect (UDP accepts no TCP handshake; EasyTier
    // public nodes speak their own UDP protocol, not STUN). A failed TCP probe would falsely
    // mark the node down -> dead-zone when the mobile has no IPv6. Mark unverifiable
    // (reliable=false) so computeVerdict degrades instead of dead-zoning; actual reachability
    // is decided by EasyTier's own handshake.
    if (schemeMatch?.[1] === 'udp') {
      return {
        host,
        port,
        tcpConnectOk: false,
        reliable: false,
        note: 'udp:// 节点未用 TCP 探测，可达性未验证（EasyTier 自身握手决定）',
      };
    }
    const r = await tcpConnect(host, port);
    // Clash/Mihomo TUN completes outbound TCP handshakes locally (findings §6.5),
    // so a connect "success" is meaningless while the TUN captures the default route.
    const tunCaptures = !!clash?.detected && clash.defaultRouteCaptured?.ipv4 === true;
    const reliable = !tunCaptures;
    let note: string | undefined;
    if (tunCaptures) {
      note =
        'Clash TUN 捕获默认路由，TCP 握手在本地完成（伪成功），tcpConnectOk 不可信；在 Clash 标公共节点 IP 为 DIRECT 后复测';
    }
    return { host, port, tcpConnectOk: r.ok, reliable, latencyMs: r.latencyMs, note };
  }
}
