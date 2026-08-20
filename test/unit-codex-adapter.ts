// OFFLINE codex adapter unit test (#1). Drives the real CodexSession exec-streaming code path
// against test/mock-codex-exec.cjs (a deterministic JSONL emitter) instead of the real `codex`
// CLI, so NO account / NO network / NO VM writes are involved.
//
// Covers:
//  (0) buildCodexExecArgs regression -- the 0-PERCEPTION invariant: args contain `exec`/`--json`
//      + hook injection and NEVER `app-server`/`initialize`/`clientInfo`/`remote-dashboard`.
//  (1) JSONL -> AdapterEvent mapping (turn.started / text.delta / text.done / tool.start /
//      tool.output / tool.done / turn.completed usage / turn.failed).
//  (2) Approval bridge: the registered PreToolUse hook handler (routed by a local session key
//      the backend sessionId) emits approval.request, awaits resolveApproval, and returns a
//      CodexHookResponse (allow echoes updatedInput; deny carries a reason). Includes 'never'
//      (auto-allow, no approval.request) and 'allow_session' (subsequent same-tool auto-allow).
//  (3) #4 create-or-dispose: adapter.startSession rejects on init failure AND does not leak the
//      hook handler (create-or-dispose reclaims it).
//  (4) #5 dispose awaits child exit (kills a hanging mock and resolves promptly).
//  (5) #6 bounded stderr: >64KB stderr does not crash the turn.
import {
  CodexSession,
  CODEX_MAX_JSONL_LINE_CHARS,
  buildCodexExecArgs,
  buildCodexSpawnEnv,
} from '../src/adapters/codex/session';
import type { CodexSessionOpts } from '../src/adapters/codex/session';
import type { AdapterEvent } from '../src/adapters/types';
import type { ApprovalPolicy, SandboxMode, ApprovalsReviewer } from '../src/config/schema';
import type { CodexHookResponse } from '../src/approval/bridge';
import { HookRegistry } from '../src/api/hooks';
import { createCodexAdapter } from '../src/adapters/codex/adapter';
import { isSupportedCodexVersion } from '../src/adapters/codex/protocol';
import { scrubMoyuEnv } from '../src/util/runtime';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK = join(fileURLToPath(new URL('.', import.meta.url)), 'mock-codex-exec.cjs');

interface MakeOpts {
  policy?: ApprovalPolicy;
  scenario?: string;
  hooks: HookRegistry;
  resume?: boolean;
}

function makeOpts(o: MakeOpts): CodexSessionOpts {
  const policy = o.policy ?? 'untrusted';
  const scenario = o.scenario ?? 'text+tool';
  const sessionId = `test-${policy}-${scenario}`;
  return {
    sessionId,
    // resume: external codex threadId (!== sessionId) => runTurn takes the resume branch.
    cliSessionRef: o.resume ? 'existing-codex-thread-id' : sessionId,
    port: 0,
    hooks: o.hooks,
    approvalTimeoutSec: 5,
    approvalPolicy: policy,
    sandbox: 'workspace-write' as SandboxMode,
    approvalsReviewer: 'user' as ApprovalsReviewer,
    spawnBin: process.execPath,
    spawnArgs: [MOCK, '--scenario', scenario],
  };
}

function find<T extends AdapterEvent['type']>(evs: AdapterEvent[], t: T) {
  return evs.find((e) => e.type === t) as Extract<AdapterEvent, { type: T }> | undefined;
}
function count(evs: AdapterEvent[], t: string): number {
  return evs.filter((e) => e.type === t).length;
}
function waitForEvent(events: AdapterEvent[], type: AdapterEvent['type'], timeoutMs = 5000): Promise<AdapterEvent> {
  const found = events.find((e) => e.type === type);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const f = events.find((e) => e.type === type);
      if (f) {
        clearInterval(iv);
        resolve(f);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${type}`));
      }
    }, 10);
    iv.unref?.();
  });
}

let failures = 0;
function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`PASS - ${label}`);
  } else {
    console.log(`FAIL - ${label}`);
    failures++;
  }
}

// ---- (0) buildCodexExecArgs: 0-perception invariant ----
function testBuildArgs(): void {
  const args = buildCodexExecArgs(
    { cwd: '/tmp/w', extraDirs: ['/x'], model: 'gpt-5', effort: 'high', approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', approvalTimeoutSec: 120, hookConfigPath: '/tmp/data.json' },
    { text: 'hi' },
    null,
  );
  const j = args.join(' ');
  check(args[0] === 'exec', 'args: starts with exec');
  check(args.includes('--json'), 'args: --json present');
  check(args.includes('--strict-config'), 'args: --strict-config present');
  check(args.includes('--dangerously-bypass-hook-trust'), 'args: --dangerously-bypass-hook-trust');
  check(j.includes('--cd /tmp/w'), 'args: --cd cwd');
  check(j.includes('--sandbox workspace-write'), 'args: --sandbox');
  check(j.includes('--add-dir /x'), 'args: --add-dir');
  check(j.includes('model_reasoning_effort=high'), 'args: native reasoning effort override');
  check(j.includes('approval_policy=never'), 'args: native approval is disabled in headless exec');
  check(j.includes('approvals_reviewer=user'), 'args: approvals_reviewer override');
  // #1 0-PERCEPTION invariant: the prior app-server path sent clientInfo:{name:"remote-dashboard"}.
  check(!j.includes('app-server'), '#1 regression: NO app-server in args');
  check(!j.includes('initialize'), '#1 regression: NO initialize RPC in args');
  check(!j.includes('clientInfo'), '#1 regression: NO clientInfo in args');
  check(!j.includes('remote-dashboard'), '#1 regression: NO remote-dashboard identity in args');
  // #1 hook injection present:
  check(j.includes('hooks.PreToolUse'), '#1: PreToolUse hook injected via -c');
  check(!j.includes('curl'), '#1: no external curl dependency');
  check(j.includes('local-check') && j.includes('/tmp/data.json'), '#1: built-in local check receives private descriptor path');
  // Source-mode tests necessarily include the repository path in the tsx bootstrap. The
  // compiled executable surface is covered by unit-hook-command; here verify the retired
  // sink-specific subcommand cannot re-enter the generated Codex hook definition.
  check(!j.includes('hook-relay'), '#1: hook definition drops the retired hook subcommand');
  check(!j.includes('RD_HOOK_'), '#1: no hook routing environment markers');
  check(j.includes('commandWindows'), '#1: Codex 0.146 commandWindows field present');
  check(j.includes('exit 2') && j.includes('$LASTEXITCODE'), '#1: relay spawn failure is fail-closed on Unix and Windows PowerShell');
  check(!args.includes('hi') && args.at(-1) === '-', 'args: prompt is stdin, not argv');
  const forbiddenConfigFlags = [
    '--ignore-user-config',
    '--ignore-rules',
    '--disable-skills',
    '--disable-mcp',
    '--no-mcp',
  ];
  check(
    forbiddenConfigFlags.every((flag) => !args.includes(flag)),
    'args: native user config, instructions, skills and MCP discovery are not disabled',
  );

  const resumeArgs = buildCodexExecArgs(
    { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', approvalTimeoutSec: 120, hookConfigPath: '/tmp/data.json' },
    { text: 'more' },
    'thread-abc',
  );
  check(resumeArgs.join(' ').includes('resume thread-abc'), 'args: resume <threadId> form for subsequent turns');
  check(resumeArgs.at(-1) === '-', 'args: resumed prompt is stdin');
  const imageArgs = buildCodexExecArgs(
    { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', approvalTimeoutSec: 120, hookConfigPath: '/tmp/data.json' },
    { text: 'look', attachments: [{ path: '/tmp/one.png' }, { path: '/tmp/two.jpg' }] },
    null,
  );
  check(imageArgs.join(' ').includes('--image /tmp/one.png --image /tmp/two.jpg -'), 'args: new-turn images precede stdin marker');
  const resumeImageArgs = buildCodexExecArgs(
    { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', approvalTimeoutSec: 120, hookConfigPath: '/tmp/data.json' },
    { text: 'look again', attachments: [{ path: '/tmp/one.png' }] },
    'thread-abc',
  );
  check(resumeImageArgs.join(' ').includes('resume thread-abc --image /tmp/one.png -'), 'args: resumed image uses ResumeArgs placement');
  check(isSupportedCodexVersion('codex-cli 0.146.2'), 'version: 0.146.x accepted');
  check(!isSupportedCodexVersion('codex-cli 0.147.0'), 'version: protocol drift rejected');
  const maxEightMiBBase64Chars = Math.ceil((8 * 1024 * 1024) / 3) * 4;
  check(CODEX_MAX_JSONL_LINE_CHARS > maxEightMiBBase64Chars * 4, 'reader: adapter-local line cap accommodates four 8 MiB base64 images');
}

// ---- (v3) buildCodexSpawnEnv: codexHome CODEX_HOME injection + precedence scrub ----
function testBuildSpawnEnv(): void {
  const prevKey = process.env.CODEX_API_KEY;
  const prevAt = process.env.CODEX_ACCESS_TOKEN;
  const prevOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.CODEX_API_KEY = 'shell-key';
  process.env.CODEX_ACCESS_TOKEN = 'shell-at';
  process.env.OPENAI_API_KEY = 'shell-openai-key';
  try {
    process.env.RD_HOOK_SECRET = 'must-not-leak';
    process.env.MOYU_INTERNAL = 'must-not-leak';
    process.env.REMOTE_DASHBOARD_CONFIG = 'must-not-leak';
    process.env.rD_hOoK_mIxEd = 'must-not-leak';
    process.env.mOyU_mIxEd = 'must-not-leak';
    process.env.Remote_Dashboard_Config = 'must-not-leak';
    process.env.SAFE_RELAY_URL = 'https://user.invalid';
    process.env.PHONE_MODEL = 'user-value';
    process.env.MOBILE_SDK = 'user-value';
    process.env.DEVICE_ID = 'user-value';
    // nativeDefault: no integration markers, no CODEX_HOME, shell auth env preserved.
    const env0 = buildCodexSpawnEnv(undefined);
    check(env0.RD_HOOK_SECRET === undefined, 'spawnEnv: hook secret scrubbed');
    check(env0.MOYU_INTERNAL === undefined, 'spawnEnv: moyu marker scrubbed');
    check(env0.REMOTE_DASHBOARD_CONFIG === undefined, 'spawnEnv: gateway config marker scrubbed');
    check(env0.rD_hOoK_mIxEd === undefined && env0.mOyU_mIxEd === undefined && env0.Remote_Dashboard_Config === undefined,
      'spawnEnv: integration markers are scrubbed case-insensitively');
    check(env0.SAFE_RELAY_URL === 'https://user.invalid' && env0.PHONE_MODEL === 'user-value' &&
      env0.MOBILE_SDK === 'user-value' && env0.DEVICE_ID === 'user-value',
      'spawnEnv: ordinary user relay/phone/mobile/device variables are preserved');
    const productDir = join(process.cwd(), 'moyu-runtime');
    const runtimeExecutable = join(productDir, process.platform === 'win32' ? 'moyu.exe' : 'moyu');
    const pathScrub = scrubMoyuEnv({
      PATH: ['C:/safe-system', productDir, 'C:/general-tools'].join(delimiter),
      _: runtimeExecutable,
    }, runtimeExecutable);
    check(!pathScrub.PATH?.includes(productDir) && pathScrub.PATH?.includes('C:/general-tools'),
      'spawnEnv: exact product runtime directory is removed without filtering generic PATH entries');
    check(pathScrub._ === undefined, 'spawnEnv: product runtime executable marker is removed');
    const genericRuntime = process.platform === 'win32' ? 'C:/bin/moyu.exe' : '/usr/local/bin/moyu';
    const genericScrub = scrubMoyuEnv({ _: genericRuntime }, genericRuntime);
    check(genericScrub._ === undefined, 'spawnEnv: product executable marker is removed from generic install directories');
    check(env0.CODEX_HOME === undefined, 'spawnEnv: no CODEX_HOME for nativeDefault');
    check(env0.CODEX_API_KEY === 'shell-key', 'spawnEnv: nativeDefault preserves shell CODEX_API_KEY');
    check(env0.CODEX_ACCESS_TOKEN === 'shell-at', 'spawnEnv: nativeDefault preserves shell CODEX_ACCESS_TOKEN');
    check(env0.OPENAI_API_KEY === 'shell-openai-key', 'spawnEnv: nativeDefault preserves shell OPENAI_API_KEY');

    // codexHome profile: CODEX_HOME injected; CODEX_API_KEY / CODEX_ACCESS_TOKEN scrubbed (they
    // take precedence over auth.json in codex load_auth and would override the switched account).
    const env1 = buildCodexSpawnEnv({ CODEX_HOME: '/home/user/.codex-acctB' });
    check(env1.CODEX_HOME === '/home/user/.codex-acctB', 'spawnEnv: codexHome injects CODEX_HOME');
    check(env1.CODEX_API_KEY === undefined, 'spawnEnv: codexHome scrubs CODEX_API_KEY (would override auth.json)');
    check(env1.CODEX_ACCESS_TOKEN === undefined, 'spawnEnv: codexHome scrubs CODEX_ACCESS_TOKEN (would override auth.json)');
    check(env1.OPENAI_API_KEY === undefined, 'spawnEnv: codexHome scrubs inherited OPENAI_API_KEY');
    const env2 = buildCodexSpawnEnv({
      CODEX_HOME: '/home/user/.codex-volcengine',
      OPENAI_API_KEY: 'selected-openai-key',
      ARK_API_KEY: 'selected-ark-key',
    });
    check(env2.OPENAI_API_KEY === 'selected-openai-key' && env2.ARK_API_KEY === 'selected-ark-key',
      'spawnEnv: selected official/custom provider keys apply after inherited auth isolation');
  } finally {
    delete process.env.RD_HOOK_SECRET;
    delete process.env.MOYU_INTERNAL;
    delete process.env.REMOTE_DASHBOARD_CONFIG;
    delete process.env.rD_hOoK_mIxEd;
    delete process.env.mOyU_mIxEd;
    delete process.env.Remote_Dashboard_Config;
    delete process.env.SAFE_RELAY_URL;
    delete process.env.PHONE_MODEL;
    delete process.env.MOBILE_SDK;
    delete process.env.DEVICE_ID;
    if (prevKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = prevKey;
    if (prevAt === undefined) delete process.env.CODEX_ACCESS_TOKEN; else process.env.CODEX_ACCESS_TOKEN = prevAt;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAiKey;
  }
}

// ---- (1) JSONL parser ----
async function runParserScenario(scenario: string): Promise<AdapterEvent[]> {
  const hooks = new HookRegistry();
  const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario }));
  const events: AdapterEvent[] = [];
  let turnDone: () => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    turnDone = resolve;
    setTimeout(() => reject(new Error('timeout waiting for turn end')), 8000).unref?.();
  });
  session.onEvent((e) => {
    events.push(e);
    if (e.type === 'turn.completed' || e.type === 'turn.failed') turnDone();
  });
  await session.init();
  await session.send({ text: 'hi' });
  await done;
  await session.dispose();
  return events;
}

async function testParser(): Promise<void> {
  // text+tool
  let evs = await runParserScenario('text+tool');
  check(evs.some((e) => e.type === 'turn.started'), '[text+tool] turn.started emitted');
  check(find(evs, 'text.delta')?.text === 'Hello from mock codex', '[text+tool] text.delta mapped');
  check(find(evs, 'text.done')?.text === 'Hello from mock codex', '[text+tool] text.done flushed');
  const ts = find(evs, 'tool.start');
  check(ts?.tool === 'Bash' && (ts!.input as { command?: string })?.command === 'echo hello', `[text+tool] tool.start Bash/command (got: ${JSON.stringify(ts?.input)})`);
  check(find(evs, 'tool.output')?.text === 'hello\n', `[text+tool] tool.output plain-text (got ${JSON.stringify(find(evs, 'tool.output')?.text)})`);
  check(find(evs, 'tool.done')?.isError === false, '[text+tool] tool.done isError=false');
  const tc = find(evs, 'turn.completed');
  check(tc?.usage?.inputTokens === 100 && tc?.usage?.outputTokens === 50 && tc?.usage?.cacheReadTokens === 80, '[text+tool] turn.completed usage mapped');
  check(tc?.usage?.cacheWriteTokens === 10, '[text+tool] turn.completed cacheWriteTokens mapped (VM-verified field cache_write_input_tokens)');
  console.log('      [text+tool] event seq:', evs.map((e) => e.type).join(','));

  // tool-failed
  evs = await runParserScenario('tool-failed');
  check(find(evs, 'tool.done')?.isError === true, '[tool-failed] tool.done isError=true (status=failed)');

  // text-only (no tool)
  evs = await runParserScenario('text-only');
  check(find(evs, 'text.done')?.text === 'plain text reply', '[text-only] text.done');
  check(count(evs, 'tool.start') === 0, '[text-only] no tool.start');
  check(!!find(evs, 'turn.completed'), '[text-only] turn.completed');

  // turn-failed
  evs = await runParserScenario('turn-failed');
  const failed = find(evs, 'turn.failed');
  check(!!failed, '[turn-failed] turn.failed emitted');
  check(failed?.category === 'auth', '[turn-failed] safe failure category mapped');
  check(!failed?.summary.includes('THIS_MUST_BE_REDACTED'), '[turn-failed] provider error secret redacted');
  check(count(evs, 'turn.completed') === 0, '[turn-failed] no turn.completed');

  evs = await runParserScenario('reasoning+mcp');
  check(count(evs, 'thinking.delta') === 2 && count(evs, 'thinking.done') === 1, '[reasoning+mcp] thinking stream mapped');
  check(find(evs, 'tool.start')?.tool === 'MCP:demo/lookup', '[reasoning+mcp] MCP tool mapped');
  check(find(evs, 'tool.output')?.text === '{"ok":true}', '[reasoning+mcp] MCP output mapped');

  evs = await runParserScenario('generic-tool');
  check(find(evs, 'tool.start')?.tool === 'CLI:web_search', '[generic-tool] unknown CLI item remains visible');
  check(find(evs, 'tool.output')?.text === '{"hits":2}', '[generic-tool] unknown CLI output remains visible');
  check(find(evs, 'tool.done')?.isError === false, '[generic-tool] generic completion mapped');

  evs = await runParserScenario('image-tools');
  const mcpStart = evs.find((event) => event.type === 'tool.start' && event.tool === 'MCP:browser/screenshot') as
    Extract<AdapterEvent, { type: 'tool.start' }> | undefined;
  const mcpOutputs = evs.filter((event) => event.type === 'tool.output' && event.toolCallId === mcpStart?.toolCallId) as
    Array<Extract<AdapterEvent, { type: 'tool.output' }>>;
  const mcpText = mcpOutputs.filter((event) => typeof event.text === 'string');
  const mcpImages = mcpOutputs.filter((event) => typeof event.base64 === 'string');
  check(mcpText.some((event) => event.text?.includes('captured')), '[image-tools] MCP text output remains visible');
  check(mcpText.every((event) => !event.text?.includes('iVBORw0KGgo=')), '[image-tools] image base64 is removed from text output');
  check(mcpImages.length === 4, '[image-tools] MCP retains at most four image blocks across update/completed snapshots');
  check(mcpImages[0]?.base64 === 'iVBORw0KGgo=' && mcpImages[0]?.mime === 'image/png' && mcpImages[0]?.name === 'screen.png', '[image-tools] data/mimeType/name image shape mapped');
  check(mcpImages[1]?.base64 === '/9j/' && mcpImages[1]?.mime === 'image/jpeg' && mcpImages[1]?.name === 'photo.jpg', '[image-tools] base64/mime_type/filename image shape mapped');
  check(mcpImages.some((event) => event.mime === 'image/tiff'), '[image-tools] unknown mime reaches ArtifactStore for lightweight rejection');
  check(!mcpImages.some((event) => event.base64 === 'RklGVEg='), '[image-tools] fifth image block is dropped');
  check(evs.indexOf(mcpText[0]!) < evs.indexOf(mcpImages[0]!), '[image-tools] image events follow text tool.output');

  const genericOutputStart = evs.find((event) => event.type === 'tool.start' && event.tool === 'CLI:browser_capture') as
    Extract<AdapterEvent, { type: 'tool.start' }> | undefined;
  const genericOutputImage = evs.find((event) => event.type === 'tool.output' && event.toolCallId === genericOutputStart?.toolCallId && event.base64) as
    Extract<AdapterEvent, { type: 'tool.output' }> | undefined;
  check(genericOutputImage?.base64 === '/9j/' && genericOutputImage.mime === 'image/jpeg', '[image-tools] generic output.content image mapped');
  const genericResultStart = evs.find((event) => event.type === 'tool.start' && event.tool === 'CLI:browser_result') as
    Extract<AdapterEvent, { type: 'tool.start' }> | undefined;
  const genericResultImage = evs.find((event) => event.type === 'tool.output' && event.toolCallId === genericResultStart?.toolCallId && event.base64) as
    Extract<AdapterEvent, { type: 'tool.output' }> | undefined;
  check(genericResultImage?.base64 === 'R0lGODlh' && genericResultImage.mime === 'image/gif', '[image-tools] generic result.content image mapped');
}

async function testNativeThreadIdentity(): Promise<void> {
  const hooks = new HookRegistry();
  const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'text-only' }));
  const events: AdapterEvent[] = [];
  session.onEvent((event) => events.push(event));
  await session.init();
  await session.send({ text: 'identity' });
  await waitForEvent(events, 'turn.completed');
  check(session.cliSessionRef === 'mock-thread-1234', '[thread identity] summary exposes native Codex thread id after thread.started');
  await session.dispose();
}

// ---- (2) Approval bridge (handleHook via the registered hook handler) ----
async function testApprovalBridge(): Promise<void> {
  // untrusted + allow
  {
    const hooks = new HookRegistry();
    const events: AdapterEvent[] = [];
    const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'text-only' }));
    session.onEvent((e) => events.push(e));
    await session.init();
    const entry = hooks.get(session.sessionId);
    check(!!entry, 'bridge: hook registered under backend sessionId');
    check(typeof entry?.secret === 'string' && entry.secret!.length > 0, 'bridge: per-session secret set');

    const p = entry!.handler({ tool_name: 'Bash', tool_input: { command: 'echo hi' } });
    const ar = (await waitForEvent(events, 'approval.request')) as Extract<AdapterEvent, { type: 'approval.request' }>;
    check(ar.kind === 'command' && ar.tool === 'Bash', 'bridge allow: approval.request kind=command tool=Bash');
    check(ar.choices.includes('allow') && ar.choices.includes('deny'), 'bridge allow: choices present');
    session.resolveApproval(ar.approvalId, 'allow');
    const resp = (await p) as CodexHookResponse;
    check(resp.hookSpecificOutput.permissionDecision === 'allow', 'bridge allow: decision=allow');
    check(
      !!resp.hookSpecificOutput.updatedInput && (resp.hookSpecificOutput.updatedInput as { command?: string }).command === 'echo hi',
      'bridge allow: updatedInput echoed (codex requires updatedInput on allow)',
    );
    check(find(events, 'approval.resolved')?.decision === 'allow', 'bridge allow: approval.resolved=allow');
    await session.dispose();
  }

  // untrusted + deny
  {
    const hooks = new HookRegistry();
    const events: AdapterEvent[] = [];
    const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'text-only' }));
    session.onEvent((e) => events.push(e));
    await session.init();
    const entry = hooks.get(session.sessionId)!;
    const p = entry.handler({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    const ar = (await waitForEvent(events, 'approval.request')) as Extract<AdapterEvent, { type: 'approval.request' }>;
    session.resolveApproval(ar.approvalId, 'deny');
    const resp = (await p) as CodexHookResponse;
    check(resp.hookSpecificOutput.permissionDecision === 'deny', 'bridge deny: decision=deny');
    check(resp.hookSpecificOutput.permissionDecisionReason === 'approval was not granted', 'bridge deny: neutral permissionDecisionReason');
    check(find(events, 'approval.resolved')?.decision === 'deny', 'bridge deny: approval.resolved=deny');
    await session.dispose();
  }

  // never policy -> auto-allow, NO approval.request
  {
    const hooks = new HookRegistry();
    const events: AdapterEvent[] = [];
    const session = new CodexSession(makeOpts({ policy: 'never', hooks, scenario: 'text-only' }));
    session.onEvent((e) => events.push(e));
    await session.init();
    const entry = hooks.get(session.sessionId)!;
    const resp = (await entry.handler({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })) as CodexHookResponse;
    check(resp.hookSpecificOutput.permissionDecision === 'allow', 'bridge never: auto-allow (no remote round-trip)');
    check(count(events, 'approval.request') === 0, 'bridge never: no approval.request emitted');
    await session.dispose();
  }

  // allow_session -> first call asks, second call (same tool) auto-allows
  {
    const hooks = new HookRegistry();
    const events: AdapterEvent[] = [];
    const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'text-only' }));
    session.onEvent((e) => events.push(e));
    await session.init();
    const entry = hooks.get(session.sessionId)!;
    const p1 = entry.handler({ tool_name: 'Bash', tool_input: { command: 'echo a' } });
    const ar1 = (await waitForEvent(events, 'approval.request')) as Extract<AdapterEvent, { type: 'approval.request' }>;
    session.resolveApproval(ar1.approvalId, 'allow_session');
    const r1 = (await p1) as CodexHookResponse;
    check(r1.hookSpecificOutput.permissionDecision === 'allow', 'bridge allow_session: first call allow');
    const before = count(events, 'approval.request');
    const r2 = (await entry.handler({ tool_name: 'Bash', tool_input: { command: 'echo b' } })) as CodexHookResponse;
    const after = count(events, 'approval.request');
    check(r2.hookSpecificOutput.permissionDecision === 'allow', 'bridge allow_session: second call auto-allow');
    check(after === before, 'bridge allow_session: second call skipped approval.request (autoAllow set)');
    await session.dispose();
  }
}

// ---- (3) #4 create-or-dispose ----
async function testCreateOrDispose(): Promise<void> {
  const hooks = new HookRegistry();
  // Pre-register a hook under 'clash-id' with a DIFFERENT owner so session.init()'s register
  // (owner=sessionId) clashes -> init throws. This deterministically forces an init failure
  // regardless of whether codex is installed.
  hooks.register(
    'clash-id',
    'other-owner',
    () => Promise.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }),
    'other-secret',
  );
  const adapter = createCodexAdapter({
    port: 0,
    hooks,
    approvalTimeoutSec: 5,
    adapterConfig: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', bin: process.execPath },
  });
  // The fixture uses Node as the spawn binary. Skip only the adapter's 0.146 version probe;
  // the test target is create-or-dispose after session.init reaches the hook clash.
  (adapter as unknown as { compatibleBin: string }).compatibleBin = process.execPath;
  let err: unknown = null;
  try {
    await adapter.startSession({ sessionId: 'clash-id', cliSessionRef: 'clash-id' });
  } catch (e) {
    err = e;
  }
  check(err instanceof Error, '#4 startSession rejects on init failure (hook clash)');
  const entry = hooks.get('clash-id');
  check(entry?.owner === 'other-owner', '#4 failed init did not leak/overwrite the hook (create-or-dispose reclaimed partial session)');
}

// ---- (4) #5 dispose awaits child exit ----
async function testDisposeAwaitsExit(): Promise<void> {
  const hooks = new HookRegistry();
  const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'hang' }));
  const events: AdapterEvent[] = [];
  session.onEvent((e) => events.push(e));
  await session.init();
  const tSend = Date.now();
  const sendP = session.send({ text: 'hi' }).catch(() => {}); // mock hangs (stays alive)
  await sendP;
  check(Date.now() - tSend < 500, '#5 send acknowledges before the turn finishes');
  await waitForEvent(events, 'turn.started'); // proves spawn + parser ran
  const t0 = Date.now();
  await session.dispose();
  const dt = Date.now() - t0;
  check(dt < 5000, `#5 dispose resolved within 5s (got ${dt}ms) -- awaited child exit, did not hang`);
  await sendP;
  check(!find(events, 'turn.failed'), '#5 dispose does not publish a stale failure after teardown');
  check(hooks.get(session.sessionId) === undefined, '#5 dispose unregistered the hook handler');
}

// ---- (5) #6 bounded stderr ----
async function testBoundedStderr(): Promise<void> {
  const hooks = new HookRegistry();
  const session = new CodexSession(makeOpts({ policy: 'untrusted', hooks, scenario: 'stderr-flood' }));
  const events: AdapterEvent[] = [];
  let turnDone: () => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    turnDone = resolve;
    setTimeout(() => reject(new Error('timeout')), 8000).unref?.();
  });
  session.onEvent((e) => {
    events.push(e);
    if (e.type === 'turn.completed' || e.type === 'turn.failed') turnDone();
  });
  await session.init();
  await session.send({ text: 'hi' });
  await done;
  await session.dispose();
  check(!!find(events, 'turn.completed'), '#6 >64KB stderr did not crash the turn (bounded accumulation)');
}

async function main(): Promise<void> {
  testBuildArgs();
  testBuildSpawnEnv();
  await testParser();
  await testNativeThreadIdentity();
  await testApprovalBridge();
  await testCreateOrDispose();
  await testDisposeAwaitsExit();
  await testBoundedStderr();

  const summary = `\nCODEX ADAPTER UNIT (#1): ${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}\n`;
  process.stdout.write(summary, () => process.exit(failures === 0 ? 0 : 1));
}

main().catch((e) => {
  console.error('codex adapter unit test crashed:', e);
  process.stderr.write(String(e?.stack ?? e) + '\n', () => process.exit(1));
});
