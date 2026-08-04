// Egress policy (C3 0-perception). Core invariant -- the ACCEPTANCE BASIS: the backend Node
// process makes ZERO outbound calls to AI providers. All AI API traffic stays inside the CLI
// subprocesses, never transiting the backend; the backend never probes account availability.
// This holds by ARCHITECTURE (no provider-request code path exists) plus the build-time static
// check in test/unit-egress.ts: every outbound primitive (createConnection / http.request /
// https.request / fetch) lives in EGRESS_ALLOWED_OUTBOUND_FILES, and no provider-domain
// literal appears in src. No privilege, no heavy module (the constraints forbid a host
// firewall / process-level network limit).
//
// PROVIDER_HOST_BLOCKLIST + assertNotProviderHost() are OPTIONAL defense-in-depth on the one
// real backend outbound path (NetProbe's relay-URL TCP reachability check): they block a
// misconfigured relay URL that points at a KNOWN provider domain. This is NOT the acceptance
// basis and MUST NOT be expanded -- a longer list implies a false guarantee. It cannot catch
// an unknown provider domain, and CLI-subprocess telemetry (the CLI phoning home on its own)
// is outside the backend's control entirely. Those two are acknowledged, unprovable residual
// boundaries (see requirements-spec §0 / §4.3), not something the backend can statically
// guarantee.

/** Known AI-provider API hosts, used ONLY by the optional assertNotProviderHost() defense on
 *  the NetProbe relay-URL path. NOT the C3 acceptance basis (that is architectural + the
 *  build-time static check). Do NOT expand this list as a substitute for the invariant -- it
 *  only ever covers known domains. The build-time test also forbids these as literals in src. */
export const PROVIDER_HOST_BLOCKLIST = [
  'anthropic.com',
  'api.anthropic.com',
  'openai.com',
  'api.openai.com',
  'claude.ai',
  'generativelanguage.googleapis.com',
  'api.deepseek.com',
  'dashscope.aliyuncs.com',
  'api.moonshot.cn',
  'api.mistral.ai',
  'api.groq.com',
  'api.together.xyz',
] as const;

/** Source files permitted to open outbound sockets. Asserted by test/unit-egress.ts -- any new
 *  outbound call must either land here (with a justification) or be removed. */
export const EGRESS_ALLOWED_OUTBOUND_FILES = [
  'src/net/probe.ts', // NetProbe: TCP reachability to the configured relay public node
  'src/cli.ts', // CLI client: HTTP to the local gateway (localhost)
  'src/approval/hook-relay.ts', // Codex hook relay: fixed localhost gateway endpoint only
  'src/adapters/opencode/session.ts', // opencode adapter (SHELVED): HTTP to the local opencode server
] as const;

/** Extract the host from a URL or host[:port] string, lower-cased. */
function hostOf(urlOrHost: string): string {
  const m = /(?:^[a-z]+:\/\/)?([^:/]+)/i.exec(urlOrHost);
  return (m?.[1] ?? urlOrHost).toLowerCase();
}

/** True if the host is a known AI-provider domain (exact or subdomain). */
export function isProviderHost(host: string): boolean {
  const h = hostOf(host);
  return PROVIDER_HOST_BLOCKLIST.some((d) => h === d || h.endsWith('.' + d));
}

/** Runtime guard: throw if the target host is a known AI-provider domain. OPTIONAL
 *  defense-in-depth on the NetProbe relay-URL path only -- NOT the C3 acceptance basis. Catches
 *  a misconfigured relay URL pointing at a known provider; cannot catch unknown providers or
 *  CLI-subprocess telemetry. */
export function assertNotProviderHost(host: string): void {
  if (isProviderHost(host)) {
    throw new Error(`egress blocked: provider host ${host} (C3 0-perception)`);
  }
}
