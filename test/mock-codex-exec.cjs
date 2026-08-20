#!/usr/bin/env node
'use strict';
// Mock `codex exec --json` for unit-codex-adapter.ts (#1). Emits deterministic JSONL
// ThreadEvents to stdout. Scenario selected via `--scenario <name>`. NO network, NO account,
// NO real codex -- purely offline event-shape coverage for the exec JSONL parser.
//
// NOTE: this mock is NOT real codex, so it does NOT fire the PreToolUse hook relay. The
// approval BRIDGE is exercised separately by calling the registered hook handler directly.
// The mock only covers JSONL -> AdapterEvent mapping + lifecycle.

const scenario = (() => {
  const i = process.argv.indexOf('--scenario');
  return i >= 0 ? process.argv[i + 1] : 'text+tool';
})();

const THREAD_ID = 'mock-thread-1234';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function agentMessage() {
  emit({ type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'Hello from mock codex' } });
  emit({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'Hello from mock codex' } });
}

function commandExecution(opts) {
  emit({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'echo hello', status: 'in_progress' } });
  emit({ type: 'item.updated', item: { id: 'cmd-1', type: 'command_execution', command: 'echo hello', aggregated_output: 'hello\n', status: 'in_progress' } });
  emit({
    type: 'item.completed',
    item: {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'echo hello',
      aggregated_output: 'hello\n',
      exit_code: 0,
      status: opts.failed ? 'failed' : 'completed',
    },
  });
}

if (scenario === 'text+tool' || scenario === 'tool-failed') {
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  agentMessage();
  commandExecution({ failed: scenario === 'tool-failed' });
  emit({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80, cache_write_input_tokens: 10 } });
  process.exit(0);
} else if (scenario === 'text-only') {
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'item.started', item: { id: 'msg-1', type: 'agent_message', text: 'plain text reply' } });
  emit({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'plain text reply' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
} else if (scenario === 'turn-failed') {
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'turn.failed', error: '401 rejected sk-test-THIS_MUST_BE_REDACTED' });
  process.exit(0);
} else if (scenario === 'reasoning+mcp') {
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'item.started', item: { id: 'reason-1', type: 'reasoning', text: 'plan' } });
  emit({ type: 'item.updated', item: { id: 'reason-1', type: 'reasoning', text: 'plan safely' } });
  emit({ type: 'item.completed', item: { id: 'reason-1', type: 'reasoning', text: 'plan safely' } });
  emit({ type: 'item.started', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'demo', tool: 'lookup', arguments: { q: 'x' }, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'mcp-1', type: 'mcp_tool_call', server: 'demo', tool: 'lookup', arguments: { q: 'x' }, result: { ok: true }, status: 'completed' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } });
  process.exit(0);
} else if (scenario === 'generic-tool') {
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'item.started', item: { id: 'web-1', type: 'web_search', input: { query: 'docs' }, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'web-1', type: 'web_search', input: { query: 'docs' }, result: { hits: 2 }, status: 'completed' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } });
  process.exit(0);
} else if (scenario === 'image-tools') {
  const png = 'iVBORw0KGgo=';
  const jpeg = '/9j/';
  const gif = 'R0lGODlh';
  const unknown = 'SUkqAA==';
  const fifth = 'RklGVEg=';
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'item.started', item: { id: 'mcp-image', type: 'mcp_tool_call', server: 'browser', tool: 'screenshot', arguments: {}, status: 'in_progress' } });
  emit({
    type: 'item.updated',
    item: {
      id: 'mcp-image', type: 'mcp_tool_call', server: 'browser', tool: 'screenshot', arguments: {}, status: 'in_progress',
      result: { content: [
        { type: 'text', text: 'captured' },
        { type: 'image', data: png, mimeType: 'image/png', name: 'screen.png' },
      ] },
    },
  });
  emit({
    type: 'item.completed',
    item: {
      id: 'mcp-image', type: 'mcp_tool_call', server: 'browser', tool: 'screenshot', arguments: {}, status: 'completed',
      result: { content: [
        { type: 'text', text: 'captured' },
        { type: 'image', data: png, mimeType: 'image/png', name: 'screen.png' },
        { type: 'image', base64: jpeg, mime_type: 'image/jpeg', filename: 'photo.jpg' },
        { type: 'image', data: gif, mimeType: 'image/gif' },
        { type: 'image', base64: unknown, mime_type: 'image/tiff' },
        { type: 'image', data: fifth, mimeType: 'image/webp' },
      ] },
    },
  });
  emit({ type: 'item.started', item: { id: 'generic-output-image', type: 'browser_capture', input: {}, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'generic-output-image', type: 'browser_capture', input: {}, output: { content: [{ type: 'image', base64: jpeg, mime_type: 'image/jpeg' }] }, status: 'completed' } });
  emit({ type: 'item.started', item: { id: 'generic-result-image', type: 'browser_result', input: {}, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'generic-result-image', type: 'browser_result', input: {}, result: { content: [{ type: 'image', data: gif, mimeType: 'image/gif' }] }, status: 'completed' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } });
  process.exit(0);
} else if (scenario === 'hang') {
  // Emits turn.started then stays alive until killed (#5 dispose-awaits-exit test).
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  setInterval(() => {}, 60000);
} else if (scenario === 'stderr-flood') {
  // Writes > STDERR_CAP (64KB) to stderr (#6 bounded-stderr test).
  process.stderr.write('x'.repeat(128 * 1024));
  emit({ type: 'thread.started', thread_id: THREAD_ID });
  emit({ type: 'turn.started', turn_id: 'mock-turn-1' });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
} else {
  emit({ type: 'error', message: 'unknown scenario: ' + scenario });
  process.exit(1);
}
