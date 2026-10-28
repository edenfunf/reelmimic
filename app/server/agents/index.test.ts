// Both CLIs' JSON streams must come out as the same normalised events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../../shared/types.ts';
import { feedStdout, noteDropped, parseClaude, parseCodex, parseOpencode } from './index.ts';

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

test('OpenCode stream', () => {
  const { events, st } = run(parseOpencode, [
    { type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'shell', state: { input: { command: 'python analyze.py ref.mp4' } } } },
    { type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'Done.' } },
    { type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', cost: 0.02 } },
  ]);
  assert.deepEqual(events, [
    { type: 'session', id: 'ses_1' },
    { type: 'tool', name: 'shell', detail: 'python analyze.py ref.mp4' },
    { type: 'text', text: 'Done.' },
  ]);
  assert.equal(st.sessionId, 'ses_1');
  assert.equal(st.text, 'Done.');
  assert.equal(st.cost, 0.02);
});

test('OpenCode provider error is not ok', () => {
  const { events, st } = run(parseOpencode, [{ type: 'error', error: { message: 'User not found.' } }]);
  assert.equal(st.ok, false);
  assert.deepEqual(events, [{ type: 'error', text: 'User not found.' }]);
});

test('long tool details are shortened', () => {
  const { events } = run(parseClaude, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x'.repeat(600) } }] } }]);
  const e = events[0] as Extract<AgentEvent, { type: 'tool' }>;
  assert.equal(e.detail.length, 401);
  assert.ok(e.detail.endsWith('…'));
});

test('non-JSON stdout lines are counted, valid lines still parse', () => {
  const events: AgentEvent[] = [], st = { sessionId: null, text: '', ok: false, cost: null, lastError: '' };
  const drop = { n: 0, sample: '' };
  const emit = (e: AgentEvent) => { if (e.type === 'error') st.lastError = e.text; events.push(e); };
  feedStdout('not json {', 'claude', emit, st, drop);
  feedStdout('{"type":"result","subtype":"success","is_error":false,"result":"hi"}', 'claude', emit, st, drop);
  assert.equal(drop.n, 1);
  assert.equal(drop.sample, 'not json {');
  assert.equal(st.text, 'hi');
  assert.equal(st.lastError, '');
});

test('an empty turn with dropped lines names the cause instead of going out blank', () => {
  const events: AgentEvent[] = [], st = { sessionId: null, text: '', ok: false, cost: null, lastError: '' };
  const emit = (e: AgentEvent) => { if (e.type === 'error') st.lastError = e.text; events.push(e); };
  noteDropped(st, { n: 3, sample: 'warn: x' }, emit);
  assert.equal(events.length, 1);
  assert.match(st.lastError, /dropped 3 non-JSON stdout/);
});

test('noteDropped stays quiet when there is output, no drops, or a prior error', () => {
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => events.push(e);
  noteDropped({ sessionId: null, text: 'hi', ok: true, cost: null, lastError: '' }, { n: 2, sample: 'x' }, emit);
  noteDropped({ sessionId: null, text: '', ok: false, cost: null, lastError: '' }, { n: 0, sample: '' }, emit);
  noteDropped({ sessionId: null, text: '', ok: false, cost: null, lastError: 'boom' }, { n: 2, sample: 'x' }, emit);
  assert.equal(events.length, 0);
});
