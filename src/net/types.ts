// Network layer types. ClashConflict is lightweight per user decision (TUN presence +
// static reminder only; no Clash config/API parsing). See findings §6.
export interface ClashConflict {
  detected: boolean;
  tunAdapter?: string;
  tunIfIndex?: number;
  defaultRouteCaptured?: { ipv4: boolean; ipv6: boolean };
  recommendation: string;
}

export interface Ipv6TempAddress {
  current: string;
  preferredLifetimeSec: number;
  validLifetimeSec: number;
  estimatedRotationAt: string;
}

export interface NetProfile {
  ipv6GuaAvailable: boolean;
  tempAddress?: Ipv6TempAddress;
  inboundFirewallDefault: 'allow' | 'block' | 'unknown';
  natType: 'fullcone' | 'restrictedcone' | 'portrestricted' | 'symmetric' | 'unknown';
  clash: ClashConflict | null;
}

export interface PublicNodeReachability {
  host: string;
  port: number;
  tcpConnectOk: boolean;
  /**
   * Whether the TCP-connect result can be trusted. Clash/Mihomo TUN completes the
   * 3-way handshake locally for ALL outbound TCP (connect() always "succeeds" in
   * <5ms regardless of whether anything listens), so when the TUN captures the
   * default route the probe is a false positive and reliable=false. The user must
   * mark the public-node IP DIRECT in Clash (or disable TUN) to restore trust.
   * See findings §6.5.
   */
  reliable: boolean;
  latencyMs?: number;
  note?: string;
}

export interface LinkVerdict {
  publicNode: PublicNodeReachability | null;
  mobileV6Available?: boolean; // reported by mobile client
  overall: 'ok' | 'degraded' | 'dead-zone' | 'unknown';
  rationale: string[];
}

/** Effective inbound boundary reported to the frontend. It documents the controls the
 * backend actually enforces and deliberately does not imply host-firewall ownership. */
export interface InboundPolicy {
  version: 1;
  mode: 'loopback-via-overlay-map';
  gatewayBindHost: string;
  backendMapCidr: string | null;
  apiBearerRequired: true;
  pairingOneTimeCodeRequired: true;
  hooksLocalhostOnly: true;
  hookSessionSecretRequired: true;
  hostFirewallMutation: false;
}

export function createInboundPolicy(gatewayBindHost: string, backendMapCidr?: string): InboundPolicy {
  return {
    version: 1,
    mode: 'loopback-via-overlay-map',
    gatewayBindHost,
    backendMapCidr: backendMapCidr || null,
    apiBearerRequired: true,
    pairingOneTimeCodeRequired: true,
    hooksLocalhostOnly: true,
    hookSessionSecretRequired: true,
    hostFirewallMutation: false,
  };
}

export interface NetStatus {
  profile: NetProfile;
  publicNode: PublicNodeReachability | null;
  verdict: LinkVerdict;
  inboundPolicy: InboundPolicy;
  checkedAt: string;
}
