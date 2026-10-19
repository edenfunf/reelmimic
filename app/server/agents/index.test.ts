// Both CLIs' JSON streams must come out as the same normalised events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../../shared/types.ts';
import { codexArgs, parseClaude, parseCodex } from './index.ts';

test('CODEX_MODEL is the legacy default; explicit role routing takes precedence', () => {
  const previous = process.env.CODEX_MODEL;
  try {
    process.env.CODEX_MODEL = 'gpt-5.6-sol';
    for (const session of [null, 'existing-session']) {
      const args = codexArgs(session, 'project');
      assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
      const routed = codexArgs(session, 'project', { runtime: 'codex', model: 'role-model' });
      assert.equal(routed.filter((arg) => arg === '--model').length, 1);
      assert.equal(routed[routed.indexOf('--model') + 1], 'role-model');
    }
    delete process.env.CODEX_MODEL;
    assert.equal(codexArgs(null, 'project').includes('--model'), false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previous;
  }
});

const run = (parse: typeof parseClaude, lines: object[]) => {
  const events: AgentEvent[] = [], st = { sessionId: null, text: '', ok: false, cost: null, lastError: '' };
  for (const l of lines) parse(l, (e) => events.push(e), st);
  return { events, st };
};

test('Claude Code stream', () => {
  const { events, st } = run(parseClaude, [
    { type: 'system', session_id: 's1' },
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'thinking', thinking: 'plan the shots' },
      { type: 'tool_use', name: 'Bash', input: { command: 'python analyze.py ref.mp4' } },
      { type: 'text', text: 'Done.' },
    ] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'All done.', total_cost_usd: 0.42 },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 's1' },
    { type: 'thinking', text: 'plan the shots' },
    { type: 'tool', name: 'Bash', detail: 'python analyze.py ref.mp4' },
    { type: 'text', text: 'Done.' },
  ]);
  assert.equal(st.ok, true);
  assert.equal(st.text, 'All done.');
  assert.equal(st.cost, 0.42);
});

test('Claude Code error result is not ok', () => {
  const { st } = run(parseClaude, [{ type: 'result', subtype: 'error_max_turns', is_error: true }]);
  assert.equal(st.ok, false);
});

test('Codex stream', () => {
  const { events, st } = run(parseCodex, [
    { type: 'thread.started', thread_id: 't1' },
    { type: 'item.started', item: { type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js' }, { path: 'b.js' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Built it.' } },
    { type: 'turn.completed' },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 't1' },
    { type: 'tool', name: 'shell', detail: 'ls' },
    { type: 'tool', name: 'edit', detail: 'a.js, b.js' },
    { type: 'text', text: 'Built it.' },
  ]);
  assert.equal(st.ok, true);
});

test('Codex failure emits an error', () => {
  const { events, st } = run(parseCodex, [{ type: 'turn.failed', error: { message: 'usage limit reached' } }]);
  assert.equal(st.ok, false);
  assert.deepEqual(events, [{ type: 'error', text: 'usage limit reached' }]);
});

test('long tool details are shortened', () => {
  const { events } = run(parseClaude, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x'.repeat(600) } }] } }]);
  const e = events[0] as Extract<AgentEvent, { type: 'tool' }>;
  assert.equal(e.detail.length, 401);
  assert.ok(e.detail.endsWith('…'));
});
