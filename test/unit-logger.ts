// Unit tests for logger secret redaction (review P1: primitive strings + stderr logged as
// {line: rawText} bypassed masking -- a CLI error embedding a token leaked into logs).
// Verifies value-level secret masking on string leaves. Masking lives in redact()/safeJson()
// which fmt() calls for every level, so testing via log.info covers the warn/error paths too.
// Run: npx tsx test/unit-logger.ts
import { log, setLogLevel, registerSecrets, clearSecrets, registerEnvSecrets, categorizeError, safeStderrSummary, safeFailure } from '../src/util/logger';

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

function captureStdout(fn: () => void): string {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    buf += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

setLogLevel('info');

// 1. Secret-named key still fully redacted; sibling preserved.
let out = captureStdout(() => log.info('t', { apiKey: 'sk-ant-SECRETKEY', extra: 'keep' }));
check('secret-named key -> [REDACTED]', out.includes('[REDACTED]'));
check('secret-named value not leaked', !out.includes('SECRETKEY'));
check('non-secret sibling preserved', out.includes('keep'));

// 2. Secret value inside a string leaf (the stderr-style {line: rawText} vector).
out = captureStdout(() => log.info('stderr', { line: 'error: invalid key sk-ant-LEAKEDTOKEN1234567890 rejected' }));
check('string-leaf masks sk- value', !out.includes('LEAKEDTOKEN1234567890'));
check('string-leaf shows sk-***', out.includes('sk-***'));

// 3. Bearer token inside a non-secret-named string value.
out = captureStdout(() => log.info('t', { header: 'Authorization: Bearer abcdef1234567890' }));
check('bearer in string masked', !out.includes('abcdef1234567890'));
check('bearer shows Bearer ***', out.includes('Bearer ***'));

// 4. 32+ consecutive hex chars (API key / hash) in a string value masked.
const hex40 = 'a'.repeat(40);
out = captureStdout(() => log.info('t', { msg: 'hash=' + hex40 }));
check('32+ hex masked', !out.includes(hex40));
check('hex shows ***', out.includes('***'));

// 5. Top-level primitive-string ctx masked (log.error('boom', 'token=...')).
out = captureStdout(() => log.info('boom', 'token=sk-ant-TOPLEAK1234567890'));
check('top-level string ctx masked', !out.includes('TOPLEAK1234567890'));
check('top-level shows sk-***', out.includes('sk-***'));

// 6. Non-secret plain string preserved (no over-redaction of normal text).
out = captureStdout(() => log.info('t', { note: 'session started normally' }));
check('plain text preserved', out.includes('session started normally'));

// 7. Short hex (<32 chars) NOT masked (avoid clobbering short ids / paths).
out = captureStdout(() => log.info('t', { id: 'abc1234' }));
check('short hex preserved', out.includes('abc1234'));

// 8. Registered exact-value secret (arbitrary format: AWS-style key, matches no pattern) is
//    masked -- the P1 fix for CLI stderr leaking custom-format tokens the pattern matcher misses.
clearSecrets();
const awsKey = 'AKIAIOSFODNN7EXAMPLE';
registerSecrets(awsKey);
out = captureStdout(() => log.info('stderr', { line: 'auth failed for AKIAIOSFODNN7EXAMPLE at us-east-1' }));
check('registered AWS-style secret masked', !out.includes(awsKey));
check('registered secret shows ***', out.includes('***'));
clearSecrets();
out = captureStdout(() => log.info('stderr', { line: 'auth failed for AKIAIOSFODNN7EXAMPLE' }));
check('after clearSecrets, non-pattern secret leaks again (registry was the mask)', out.includes(awsKey));

// §5: registerEnvSecrets registers arbitrary-format credential values BY KEY NAME from a
// subprocess env (nativeDefault process.env / Codex / custom Provider -- not just Claude
// profileEnv). Values matching no sk-/Bearer/hex pattern are still masked. This is the core
// §5 guarantee: arbitrary-format env credentials never appear in logs.
clearSecrets();
const envCreds = {
  PATH: '/usr/bin', // non-credential key -> must NOT be registered (so its value stays visible)
  ANTHROPIC_API_KEY: 'sk-ant-NATIVEDEFAULT9xyz', // nativeDefault (process.env style)
  CUSTOM_PROVIDER_TOKEN: 'prv_live_8c2f1a90bb77aa', // custom provider, arbitrary format
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // base64-ish, arbitrary
  OPENCODE_SERVER_PASSWORD: 'S3cr3t-pass-12345', // *PASSWORD* category
  Authorization: 'Bearer op-code-9988776655', // Authorization value
  SOME_BASE_URL: 'https://api.example.com', // base_url is NOT a credential key -> stays visible
};
registerEnvSecrets(envCreds);
const leakLine =
  'error: auth failed key=sk-ant-NATIVEDEFAULT9xyz token=prv_live_8c2f1a90bb77aa ' +
  'secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY pwd=S3cr3t-pass-12345 auth=Bearer op-code-9988776655 ' +
  'url=https://api.example.com path=/usr/bin';
// log.info writes to stdout (captured); fmt() is shared across levels so this covers warn/error too.
out = captureStdout(() => log.info('subprocess stderr summary', { line: leakLine }));
check('§5 nativeDefault sk- key masked (env)', !out.includes('sk-ant-NATIVEDEFAULT9xyz'));
check('§5 custom provider token masked (arbitrary format)', !out.includes('prv_live_8c2f1a90bb77aa'));
check('§5 AWS base64-style secret masked (arbitrary format)', !out.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'));
check('§5 PASSWORD-category value masked', !out.includes('S3cr3t-pass-12345'));
check('§5 Authorization Bearer value masked', !out.includes('op-code-9988776655'));
check('§5 non-credential base_url value NOT over-masked (stays visible)', out.includes('https://api.example.com'));
check('§5 PATH value not registered (non-credential key, stays visible)', out.includes('/usr/bin'));

// §5: safeStderrSummary redacts registered env secrets + hard-truncates to a fixed length.
const longSecret = 'AKIAIOSFODNN7EXAMPLE';
registerSecrets(longSecret);
const longStderr = 'error: '.repeat(60) + ' creds=' + longSecret + ' ' + 'x'.repeat(500);
const summary = safeStderrSummary(longStderr, 200);
check('§5 safeStderrSummary masks registered secret', !summary.includes(longSecret));
check('§5 safeStderrSummary truncated to <= 201 chars (200 + ellipsis)', summary.length <= 201);
check('§5 safeStderrSummary ends with ellipsis when truncated', summary.endsWith('…'));
const shortSummary = safeStderrSummary('small error line ' + longSecret, 200);
check('§5 safeStderrSummary masks secret even when under limit', !shortSummary.includes(longSecret));
clearSecrets();

// §5: categorizeError derives a safe, non-leaking category from stderr (best-effort).
check('§5 categorizeError auth', categorizeError('Error: 401 Unauthorized invalid API key') === 'auth');
check('§5 categorizeError rate-limit', categorizeError('429 Too Many Requests: rate limit exceeded') === 'rate-limit');
check('§5 categorizeError network', categorizeError('fetch failed: ECONNREFUSED 127.0.0.1:443') === 'network');
check('§5 categorizeError not-found', categorizeError('enoent: no such file or directory') === 'not-found');
check('§5 categorizeError unknown fallback', categorizeError('something weird happened') === 'unknown');
check('§5 categorizeError empty -> unknown', categorizeError('') === 'unknown');

registerSecrets('CUSTOM-SECRET-VALUE');
const failure = safeFailure('401 failed for CUSTOM-SECRET-VALUE');
check('failure wire shape categorizes auth', failure.category === 'auth');
check('failure wire shape redacts exact secret', !failure.summary.includes('CUSTOM-SECRET-VALUE'));
const objectFailure = safeFailure({ apiKey: 'OBJECT-SECRET' }, 'operation failed');
check('failure wire shape never serializes unknown objects', objectFailure.summary === 'operation failed');

clearSecrets();

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ' (' + pass + ' pass, ' + fail + ' fail)');
if (fail) process.exitCode = 1;
