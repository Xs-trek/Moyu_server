// Offline native-history/effective-model test. Uses only temporary JSONL/config fixtures.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/accounts/service';
import { resolveClaudeEffectiveModel, resolveCodexEffectiveModel } from '../src/adapters/effective-model';
import { ClaudeStreamParser } from '../src/adapters/claude/parser';
import type { AdapterEvent } from '../src/adapters/types';
import type { AppConfig } from '../src/config/schema';
import { listNativeSessions, pageNativeMessages, readNativeSession } from '../src/history/native';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.error('  ✗ FAIL: ' + name);
  }
}

const root = mkdtempSync(join(tmpdir(), 'moyu-native-history-'));
const claudeDir = join(root, 'claude');
const codexDir = join(root, 'codex');
const claudeProject = join(claudeDir, 'projects', 'D--work');
const codexSessions = join(codexDir, 'sessions', '2026', '08', '09');
const claudeId = '11111111-1111-4111-8111-111111111111';
const codexId = '22222222-2222-4222-8222-222222222222';
mkdirSync(claudeProject, { recursive: true });
mkdirSync(codexSessions, { recursive: true });
writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
  model: 'opus',
  env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2' },
}));
writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-native"\n[features]\nhooks = true\n');

const claudeFile = join(claudeProject, `${claudeId}.jsonl`);
writeFileSync(claudeFile, [
  '{malformed',
  JSON.stringify({ type: 'user', timestamp: '2026-08-09T01:00:00.000Z', cwd: 'D:/work', message: { role: 'user', content: 'hello history' } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-09T01:00:01.000Z', cwd: 'D:/work', message: { id: 'a1', role: 'assistant', model: 'glm-5.2', content: [{ type: 'thinking', thinking: 'considering' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-09T01:00:02.000Z', cwd: 'D:/work', message: { id: 'a1', role: 'assistant', model: 'glm-5.2', content: [{ type: 'text', text: 'hello back' }] } }),
  JSON.stringify({ type: 'ai-title', sessionId: claudeId, aiTitle: 'Claude native title' }),
].join('\n') + '\n');

const codexFile = join(codexSessions, `rollout-2026-08-09T10-00-00-${codexId}.jsonl`);
writeFileSync(codexFile, [
  JSON.stringify({ timestamp: '2026-08-09T02:00:00.000Z', type: 'session_meta', payload: { id: codexId, cwd: 'D:/codex-work' } }),
  'not json',
  JSON.stringify({ timestamp: '2026-08-09T02:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-runtime', cwd: 'D:/codex-work' } }),
  JSON.stringify({ timestamp: '2026-08-09T02:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex question' }] } }),
  JSON.stringify({ timestamp: '2026-08-09T02:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer' }] } }),
].join('\n') + '\n');
writeFileSync(join(codexDir, 'session_index.jsonl'), JSON.stringify({
  id: codexId,
  thread_name: 'Codex native title',
  updated_at: '2026-08-09T02:00:03.000Z',
}) + '\n');

const config = {
  gateway: { portMin: 18080, portMax: 18099, bindHost: '127.0.0.1' },
  network: { publicNode: '', privateMode: true },
  defaultAdapter: 'claude',
  approvalTimeoutSec: 120,
  logLevel: 'warn',
  ptyAddon: { enabled: false },
  adapters: {
    claude: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', configDir: claudeDir },
    codex: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', approvalsReviewer: 'user', configDir: codexDir },
  },
} as AppConfig;

try {
  check('Claude alias resolves to provider-effective model', resolveClaudeEffectiveModel({ configuredDir: claudeDir }) === 'glm-5.2');
  check('Claude selected profile env wins alias resolution', resolveClaudeEffectiveModel({
    configuredDir: claudeDir,
    profileEnv: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'profile-model' },
  }) === 'profile-model');
  check('Codex root config model resolves', resolveCodexEffectiveModel({ configuredDir: codexDir }) === 'gpt-native');

  const before = readFileSync(claudeFile, 'utf8');
  const beforeMtime = statSync(claudeFile).mtimeMs;
  const accounts = new AccountService();
  const listed = await listNativeSessions(config, accounts, 10);
  check('native list returns both adapters', listed.items.length === 2);
  check('native list default offset remains compatible and exposes terminal cursor', listed.nextOffset === 2 && listed.hasMore === false);
  const firstListPage = await listNativeSessions(config, accounts, 1, 0);
  const secondListPage = await listNativeSessions(config, accounts, 1, firstListPage.nextOffset);
  const repeatedFirstPage = await listNativeSessions(config, accounts, 1, 0);
  check('native list first page exposes bounded continuation', firstListPage.items.length === 1 && firstListPage.hasMore && firstListPage.nextOffset === 1);
  check('native list nextOffset reaches the older distinct record', secondListPage.items.length === 1 && secondListPage.items[0]?.nativeSessionId !== firstListPage.items[0]?.nativeSessionId);
  check('native list final page closes pagination', secondListPage.hasMore === false && secondListPage.nextOffset === 2);
  check('native list ordering is stable for an unchanged snapshot', repeatedFirstPage.items[0]?.nativeSessionId === firstListPage.items[0]?.nativeSessionId);
  const claude = listed.items.find((item) => item.kind === 'claude');
  const codex = listed.items.find((item) => item.kind === 'codex');
  check('Claude list exposes native title/model/count', claude?.title === 'Claude native title' && claude.model === 'glm-5.2' && claude.messageCount === 2);
  check('Codex list uses index title and runtime model', codex?.title === 'Codex native title' && codex.model === 'gpt-runtime' && codex.messageCount === 2);
  check('native discovery is read-only', readFileSync(claudeFile, 'utf8') === before && statSync(claudeFile).mtimeMs === beforeMtime);

  const record = await readNativeSession('claude', claudeId, config, accounts);
  check('native session can be read by UUID', record?.item.nativeSessionId === claudeId);
  check('split Claude thinking/text records merge into one assistant message',
    record?.messages.length === 2 && record.messages[1]?.text === 'hello back' && record.messages[1]?.thinking === 'considering');
  const page = pageNativeMessages(record!, 1, 1);
  check('message page is Android-friendly object with cursor', page.items.length === 1 && page.nextAfter === 2 && page.latestSeq === 2);
  check('unknown UUID returns null', await readNativeSession('claude', '33333333-3333-4333-8333-333333333333', config, accounts) === null);

  const longClaudeId = '44444444-4444-4444-8444-444444444444';
  const longClaudeFile = join(claudeProject, `${longClaudeId}.jsonl`);
  const longClaudeLines = Array.from({ length: 5_002 }, (_, index) => JSON.stringify({
    type: 'user',
    timestamp: new Date(Date.UTC(2026, 7, 9, 3, 0, index)).toISOString(),
    cwd: 'D:/long-claude',
    message: { role: 'user', content: `claude message ${index}` },
  }));
  writeFileSync(longClaudeFile, longClaudeLines.join('\n') + '\n');
  const longClaudeBefore = statSync(longClaudeFile);
  const longClaude = await readNativeSession('claude', longClaudeId, config, accounts);
  const longClaudeAfter = statSync(longClaudeFile);
  check('long Claude history retains exactly the newest 5000 normalized messages',
    longClaude?.messages.length === 5_000 &&
    longClaude.messages[0]?.text === 'claude message 2' &&
    longClaude.messages.at(-1)?.text === 'claude message 5001');
  check('long Claude retained window is resequenced for native API cursors and resume seeding',
    longClaude?.messages[0]?.seq === 1 && longClaude.messages.at(-1)?.seq === 5_000 &&
    pageNativeMessages(longClaude!, 4_999, 100).items[0]?.text === 'claude message 5001' &&
    pageNativeMessages(longClaude!, 4_999, 100).latestSeq === 5_000);
  check('reading long Claude history does not modify its native file',
    longClaudeAfter.size === longClaudeBefore.size && longClaudeAfter.mtimeMs === longClaudeBefore.mtimeMs);

  const longCodexId = '55555555-5555-4555-8555-555555555555';
  const longCodexFile = join(codexSessions, `rollout-2026-08-09T11-00-00-${longCodexId}.jsonl`);
  // Force the 64 MiB reader to begin in the middle of an oversized malformed record. The
  // truncated first line must be discarded while every complete recent record remains usable.
  writeFileSync(longCodexFile, Buffer.alloc(64 * 1024 * 1024, 0x78));
  appendFileSync(longCodexFile, '\n' + JSON.stringify({
    timestamp: '2026-08-09T04:00:00.000Z',
    type: 'turn_context',
    payload: { model: 'gpt-long', cwd: 'D:/long-codex' },
  }) + '\n');
  const longCodexLines = Array.from({ length: 5_002 }, (_, index) => JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 7, 9, 5, 0, index)).toISOString(),
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `codex message ${index}` }] },
  }));
  appendFileSync(longCodexFile, longCodexLines.join('\n') + '\n');
  const longCodexBefore = statSync(longCodexFile);
  const longCodex = await readNativeSession('codex', longCodexId, config, accounts);
  const longCodexAfter = statSync(longCodexFile);
  check('tail reader drops a truncated first line and retains the newest 5000 Codex messages',
    longCodex?.messages.length === 5_000 &&
    longCodex.messages[0]?.text === 'codex message 2' &&
    longCodex.messages.at(-1)?.text === 'codex message 5001');
  check('long Codex metadata and contiguous API cursor semantics survive the tail window',
    longCodex?.item.cwd === 'D:/long-codex' && longCodex.item.model === 'gpt-long' &&
    longCodex.messages[0]?.seq === 1 && longCodex.messages.at(-1)?.seq === 5_000 &&
    pageNativeMessages(longCodex, 0, 1).nextAfter === 1 &&
    pageNativeMessages(longCodex, 4_999, 1).hasMore === false);
  check('reading the oversized Codex tail does not modify its native JSONL',
    longCodexAfter.size === longCodexBefore.size && longCodexAfter.mtimeMs === longCodexBefore.mtimeMs);

  const events: AdapterEvent[] = [];
  const parser = new ClaudeStreamParser((event) => events.push(event));
  parser.feed(JSON.stringify({ type: 'assistant', message: { model: 'glm-runtime', content: [] } }));
  parser.feed(JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }));
  const completed = events.find((event) => event.type === 'turn.completed');
  check('Claude runtime assistant model reaches turn.completed', completed?.type === 'turn.completed' && completed.model === 'glm-runtime');
  const imageParserEvents: AdapterEvent[] = [];
  const imageParser = new ClaudeStreamParser((event) => imageParserEvents.push(event));
  imageParser.feed(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } }));
  const imageOutput = imageParserEvents.find((event) => event.type === 'tool.output' && event.base64);
  check('Claude image tool result remains a typed artifact event', imageOutput?.type === 'tool.output' && imageOutput.mime === 'image/png');
  const boundedImageEvents: AdapterEvent[] = [];
  const boundedImageParser = new ClaudeStreamParser((event) => boundedImageEvents.push(event));
  boundedImageParser.feed(JSON.stringify({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: 'read-many', content: Array.from({ length: 5 }, (_, index) => ({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(`image${index}`).toString('base64') },
    })),
  }] } }));
  check('Claude tool result emits at most four image artifacts', boundedImageEvents.filter((event) => event.type === 'tool.output' && event.base64).length === 4);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'UNIT PASSED' : 'UNIT FAILED') + ` (${pass} pass, ${fail} fail)`);
if (fail) process.exitCode = 1;
