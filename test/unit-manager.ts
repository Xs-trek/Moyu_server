// Unit tests for SessionManager incremental history (issue: tool.output must be
// backfillable via /messages?after=<seq>). Drives a mock adapter handle's event callback
// directly -- no real CLI, 0 quota, 0 network.
//   tool.start creates a tool msg at seq S; tool.output mutates it. The fix bumps the
//   mutated msg's seq to the current seq + sorts history() by seq, so a client that saw
//   tool.start at seq S and reconnects with ?after=S still receives the streamed output.
// Run: npx tsx test/unit-manager.ts
import { SessionManager, resolveSessionWorkingDirectory } from '../src/session/manager';
import { AdapterManager } from '../src/adapters/manager';
import type { Adapter, AdapterEvent, AuthProfile, SessionHandle, SessionOpts } from '../src/adapters/types';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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

// Mock adapter: captures the manager-registered event callback so the test can emit events.
let emit: (e: AdapterEvent) => void = () => {};
let rejectSend = false;
let selectedEffort: string | undefined;
let selectedModel: string | undefined;
let selectedPermissionMode: string | undefined;
let capturedSessionOpts: SessionOpts | undefined;
const handle: SessionHandle = {
  sessionId: 'mock',
  cliSessionRef: 'mock',
  onEvent(cb) {
    emit = cb;
    return () => {
      emit = () => {};
    };
  },
  async send() {
    if (rejectSend) throw new Error('queue full');
  },
  async interrupt() {},
  async history() {
    return [];
  },
  async resolveApproval() {},
  async setEffort(effort) { selectedEffort = effort; },
  async setModel(model) { selectedModel = model; },
  async setPermissionMode(mode) { selectedPermissionMode = mode; },
  async dispose() {},
};
const adapter: Adapter = {
  kind: 'claude',
  displayName: 'mock',
  capabilities: {
    streaming: { text: true, thinking: false, tools: true },
    resume: true,
    interrupt: true,
    accountProfiles: false,
    approval: { transport: 'native', semantics: 'native', policies: [] },
    configuration: { model: false, modelSelection: 'freeform' as const, effortLevels: ['low', 'medium', 'high'], permissionModes: ['plan', 'auto', 'acceptEdits'], sandboxModes: [], reviewers: [] },
  },
  async isAvailable() {
    return true;
  },
  async detect() {
    return { adapter: 'claude', mode: 'none', hasCredentials: false } as AuthProfile;
  },
  async startSession(opts) {
    capturedSessionOpts = opts;
    return handle;
  },
};

const adapters = new AdapterManager();
adapters.register(adapter);
let observedNowMs = 1_000;
const mgr = new SessionManager(adapters, undefined, () => observedNowMs);
const sid = await mgr.create('claude', {});
check('omitted cwd reaches the native adapter as the user home, never daemon cwd', capturedSessionOpts?.cwd === resolve(homedir()));
check('session summary reports the same neutral default cwd', mgr.summary(sid)?.cwd === resolve(homedir()));
check('explicit user cwd remains the resolved native working directory',
  resolveSessionWorkingDirectory('test-workspace') === resolve('test-workspace'));

// Drive a realistic turn: user msg -> turn.started -> tool.start -> tool.output x2 ->
// tool.done -> text.done.
await mgr.send(sid, { text: 'list files' });
emit({ type: 'turn.started' });
observedNowMs = 3_500;
emit({ type: 'tool.start', toolCallId: 't1', tool: 'Bash', input: { command: 'ls' } });
// Capture the seq a client would have recorded at tool.start (before output streamed).
const toolStartSeq = mgr.history(sid).find((m) => m.toolCallId === 't1')!.seq;
emit({ type: 'tool.output', toolCallId: 't1', text: 'file1\n' });
emit({ type: 'tool.output', toolCallId: 't1', text: 'file2\n' });
emit({ type: 'tool.done', toolCallId: 't1', isError: false });
emit({ type: 'text.done', text: 'done listing' });

let runningEffortRejected = false;
try { await mgr.setEffort(sid, 'high'); } catch { runningEffortRejected = true; }
check('effort change is rejected while a turn runs', runningEffortRejected);
emit({ type: 'turn.completed', usage: { inputTokens: 10, outputTokens: 3 }, model: 'runtime-native-model' });
const completedEnvelope = mgr.sync(sid, 0).events.find((item) => item.event.type === 'turn.completed');
check('completed turn carries the locally observed end-to-end duration',
  completedEnvelope?.event.type === 'turn.completed'
    && completedEnvelope.event.performance?.observedDurationMs === 2_500);
const effortSummary = await mgr.setEffort(sid, 'high');
check('effort change reaches the native session handle', selectedEffort === 'high');
check('session summary exposes selected effort', effortSummary.effort === 'high');
check('session summary adopts runtime model', effortSummary.model === 'runtime-native-model');
const modelSummary = await mgr.setModel(sid, 'claude-sonnet');
check('model change reaches native argv state', selectedModel === 'claude-sonnet');
check('requested model remains distinct from last runtime model', modelSummary.model === 'claude-sonnet' && modelSummary.runtimeModel === 'runtime-native-model');
const modeSummary = await mgr.setPermissionMode(sid, 'auto');
check('permission mode change reaches native session state', selectedPermissionMode === 'auto' && modeSummary.permissionMode === 'auto');

const all = mgr.history(sid);
const toolMsg = all.find((m) => m.toolCallId === 't1')!;
check('tool msg has accumulated output', toolMsg.toolOutput === 'file1\nfile2\n');
check('tool msg seq bumped past tool.start seq', toolMsg.seq > toolStartSeq);
check('assistant msg persisted', all.some((m) => m.role === 'assistant' && m.text === 'done listing'));
check('user msg persisted', all.some((m) => m.role === 'user' && m.text === 'list files'));

// Full history is sorted by seq (push order != seq order after the bump).
const seqs = all.map((m) => m.seq);
check('history sorted by seq', JSON.stringify(seqs) === JSON.stringify([...seqs].sort((a, b) => a - b)));

// BACKFILL (the regression): client saw tool.start at seq=toolStartSeq, reconnects, asks
// for everything after that seq. Must include the tool msg (now with output) + assistant.
const backfill = mgr.history(sid, toolStartSeq);
check(
  'backfill after tool.start seq includes tool msg WITH output',
  backfill.some((m) => m.toolCallId === 't1' && m.toolOutput === 'file1\nfile2\n'),
);
check('backfill includes assistant msg', backfill.some((m) => m.role === 'assistant'));
// Before the fix the tool msg kept seq=toolStartSeq, so ?after=toolStartSeq excluded it
// (seq not strictly greater) and the streamed output was lost on reconnect.
check('backfill excludes the user msg already seen', backfill.every((m) => m.role !== 'user'));

// BOUND (review P2: messages[] + toolOutput grew unbounded). toolOutput over 256KB truncates.
emit({ type: 'tool.start', toolCallId: 't2', tool: 'Bash', input: { command: 'big' } });
emit({ type: 'tool.output', toolCallId: 't2', text: 'x'.repeat(300_000) });
const t2msg = mgr.history(sid).find((m) => m.toolCallId === 't2')!;
check('toolOutput over 256KB is truncated', t2msg.toolOutput!.length < 300_000);
check('toolOutput truncation marker present', t2msg.toolOutput!.endsWith('…[truncated]'));

// messages cap: flood > 1000 tool.start events -> capped (oldest dropped, recent retained).
for (let i = 0; i < 1100; i++) {
  emit({ type: 'tool.start', toolCallId: 'flood' + i, tool: 'Bash', input: {} });
}
check('messages capped at MAX_MESSAGES_PER_SESSION', mgr.history(sid).length <= 1000);
check('messages cap retained the most recent event', mgr.history(sid).some((m) => m.toolCallId === 'flood1099'));

rejectSend = true;
const beforeRejected = mgr.history(sid).length;
try {
  await mgr.send(sid, { text: 'must not persist' });
} catch {
  // Expected adapter rejection.
}
check('rejected input is not persisted in history', !mgr.history(sid).some((message) => message.text === 'must not persist'));
check('rejected input restores history capacity eviction', mgr.history(sid).length === beforeRejected);

// Compatibility terminal events without turn.started still use accepted-input timing.
rejectSend = false;
observedNowMs = 5_000;
const terminalOnlySid = await mgr.create('claude', {});
await mgr.send(terminalOnlySid, { text: 'terminal-only adapter turn' });
observedNowMs = 6_200;
emit({ type: 'turn.completed', usage: { outputTokens: 12 } });
const terminalOnlyCompleted = mgr.sync(terminalOnlySid, 0).events.find((item) => item.event.type === 'turn.completed');
check('terminal-only adapter completion falls back to accepted-input timing',
  terminalOnlyCompleted?.event.type === 'turn.completed'
    && terminalOnlyCompleted.event.performance?.observedDurationMs === 1_200);

// A failure before turn.started consumes its pending timestamp and cannot contaminate the next
// healthy turn in the same session.
observedNowMs = 7_000;
await mgr.send(terminalOnlySid, { text: 'guard fails before start' });
observedNowMs = 7_200;
emit({ type: 'turn.failed', category: 'unknown', summary: 'guard failed' });
observedNowMs = 8_000;
await mgr.send(terminalOnlySid, { text: 'next healthy turn' });
observedNowMs = 8_100;
emit({ type: 'turn.started' });
observedNowMs = 9_000;
emit({ type: 'turn.completed', usage: { outputTokens: 10 } });
const healthyTerminal = mgr.sync(terminalOnlySid, 0).events.filter((item) => item.event.type === 'turn.completed').at(-1);
check('pre-start failure cannot leak its timestamp into the next turn',
  healthyTerminal?.event.type === 'turn.completed'
    && healthyTerminal.event.performance?.observedDurationMs === 1_000);

console.log(`\n${fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED'} (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
