// Offline unit test: per-adapter config plumbing (v3). No CLI spawn, no account, no saveConfig.
import { loadConfig } from '../src/config/loader';
import { sanitizeConfig, DEFAULT_ADAPTER_CONFIG } from '../src/config/schema';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Never mutate the operator's real config while testing first-run secret generation.
const tmpCfg = join(tmpdir(), `rd-config-${process.pid}-${Date.now()}.json`);
const cfg = loadConfig(tmpCfg);
const s = sanitizeConfig(cfg);
try { unlinkSync(tmpCfg); } catch { /* best-effort cleanup */ }

const checks: [string, boolean][] = [
  ['claude default approvalPolicy=untrusted', cfg.adapters.claude.approvalPolicy === 'untrusted'],
  ['claude default sandbox=workspace-write', cfg.adapters.claude.sandbox === 'workspace-write'],
  ['codex default approvalsReviewer=user', cfg.adapters.codex.approvalsReviewer === 'user'],
  ['model undefined by default (inherit CLI)', cfg.adapters.claude.model === undefined],
  ['activeProfileId undefined by default (native)', cfg.adapters.claude.activeProfileId === undefined],
  ['DEFAULT_ADAPTER_CONFIG sanity', DEFAULT_ADAPTER_CONFIG.approvalPolicy === 'untrusted' && DEFAULT_ADAPTER_CONFIG.sandbox === 'workspace-write'],
  // v3: baseUrl removed (superseded by profiles); activeProfileId is the switching handle.
  ['sanitize has NO baseUrl field (claude)', !('baseUrl' in s.adapters.claude)],
  ['sanitize has NO baseUrlPresent (claude)', !('baseUrlPresent' in s.adapters.claude)],
  ['sanitize has activeProfileId field (claude)', 'activeProfileId' in s.adapters.claude],
  ['sanitize activeProfileId undefined when unset', s.adapters.claude.activeProfileId === undefined],
  ['sanitize codex present', s.adapters.codex.approvalPolicy === 'untrusted'],
  ['PC daemon control token generated', typeof cfg.controlToken === 'string' && cfg.controlToken.length >= 32],
  ['sanitize omits PC daemon control token', !('controlToken' in s)],
];

// Simulate PATCH activeProfileId: reflected in sanitized view; key VALUES never echoed.
const patched = sanitizeConfig({
  ...cfg,
  adapters: {
    claude: { ...cfg.adapters.claude, activeProfileId: 'claude:env:thirdparty' },
    codex: cfg.adapters.codex,
  },
});
checks.push(['PATCH activeProfileId reflected', patched.adapters.claude.activeProfileId === 'claude:env:thirdparty']);
checks.push(['sanitized carries no secret-shaped values', !/(token|apikey|api_key|authorization|credentials)/i.test(JSON.stringify(patched))]);

// N4: hand-edited config with portMin>max -> loadConfig falls back to defaults (not fail-fast,
// not silent OS-random). PATCH path already rejects via validateConfigPatch.
const tmpN4 = join(tmpdir(), `rd-n4-${process.pid}-${Date.now()}.json`);
writeFileSync(tmpN4, JSON.stringify({ gateway: { portMin: 20000, portMax: 18000, bindHost: '127.0.0.1' } }));
const cfgN4 = loadConfig(tmpN4, { generate: false });
checks.push(['N4: portMin>max falls back to default portMin', cfgN4.gateway.portMin === 18080]);
checks.push(['N4: portMin>max falls back to default portMax', cfgN4.gateway.portMax === 18099]);
try { unlinkSync(tmpN4); } catch { /* best-effort cleanup */ }

let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!ok) fail++;
}
const summary = `\nCONFIG UNIT: ${fail === 0 ? `ALL PASS (${checks.length})` : fail + ' FAILED'}\n`;
process.stdout.write(summary, () => process.exit(fail === 0 ? 0 : 1));
