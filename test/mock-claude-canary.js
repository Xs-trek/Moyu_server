import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const stateDir = process.env.TEST_CLAUDE_CANARY_DIR;
if (!stateDir) process.exit(9);
mkdirSync(stateDir, { recursive: true });

function increment(name) {
  const path = join(stateDir, name);
  let value = 0;
  try { value = Number(readFileSync(path, 'utf8')) || 0; } catch { /* first run */ }
  value++;
  writeFileSync(path, String(value));
  return value;
}

if (args.includes('--init-only')) {
  const probe = increment('probe-count');
  const sources = args.indexOf('--setting-sources');
  if (sources < 0 || args[sources + 1] !== '') process.exit(8);
  const settingsAt = args.indexOf('--settings');
  const settingsPath = settingsAt >= 0 ? args[settingsAt + 1] : undefined;
  if (!settingsPath) process.exit(7);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const hook = settings?.hooks?.SessionStart?.[0]?.hooks?.[0];
  if (!hook?.command || !Array.isArray(hook.args)) process.exit(6);
  const descriptorPath = hook.args.at(-1);
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  writeFileSync(join(stateDir, `probe-${probe}-nonce`), String(descriptor.probeNonce ?? ''));
  if (probe === Number(process.env.TEST_CLAUDE_FAIL_PROBE_AT ?? '0')) {
    // Simulate a suppressed SessionStart hook while an old marker is present. The production
    // preflight must compare the fresh nonce, not merely trust marker existence.
    let previousNonce = '';
    try { previousNonce = readFileSync(join(stateDir, 'last-probe-nonce'), 'utf8'); } catch { /* no prior probe */ }
    if (previousNonce && descriptor.probePath) {
      writeFileSync(descriptor.probePath, previousNonce);
      writeFileSync(join(stateDir, 'stale-marker-written'), '1');
    }
    process.exit(0);
  }
  const result = spawnSync(hook.command, hook.args, {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
    encoding: 'utf8',
    windowsHide: true,
  });
  writeFileSync(join(stateDir, 'probe-result'), JSON.stringify({
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
    command: hook.command,
    args: hook.args,
  }));
  if (result.status === 0) writeFileSync(join(stateDir, 'last-probe-nonce'), String(descriptor.probeNonce ?? ''));
  process.exit(result.status ?? 5);
}

increment('turn-count');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\n');
});
