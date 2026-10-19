import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRouting, resolveRoute, preflightRoute, selectSessionRoute, redact, ROLE_GROUP } from './routing.ts';
import { claudeArgs, codexArgs, routeEnvironment, runAgent } from './index.ts';
import type { AgentEvent, AgentRoute } from '../../shared/types.ts';

const route: AgentRoute = { runtime: 'codex', model: 'example/model', vision: true };
const config = () => ({ version: 1, routes: {
  global: route, project: { ...route, model: 'project' }, builder: { ...route, model: 'builder' }, role: { ...route, model: 'role' },
}, default: 'global', groups: { builder: 'builder' }, roles: { build_chunk: 'role' }, projects: { p: { default: 'project' } } });

test('all pipeline phases have a stable group; precedence selects whole routes', () => {
  const c = parseRouting(config());
  assert.equal(Object.keys(ROLE_GROUP).length, 16);
  assert.equal(resolveRoute(c, 'p', 'build_chunk')?.model, 'role');
  delete c.roles!.build_chunk;
  assert.equal(resolveRoute(c, 'p', 'build_chunk')?.model, 'builder');
  delete c.groups!.builder;
  assert.equal(resolveRoute(c, 'p', 'build_chunk')?.model, 'project');
  assert.equal(resolveRoute(c, 'other', 'build_chunk')?.model, 'example/model');
  delete c.default;
  assert.equal(resolveRoute(c, 'other', 'build_chunk'), null);
  assert.equal(resolveRoute(null, 'p', 'style'), null);
});

test('project role/group wins its global counterpart without inheriting provider fields', () => {
  const c = parseRouting(config());
  c.projects!.p = { roles: { build_chunk: 'project' }, groups: { director: 'project' } };
  assert.equal(resolveRoute(c, 'p', 'build_chunk')?.model, 'project');
  assert.equal(resolveRoute(c, 'p', 'style')?.model, 'project');
  const copy = resolveRoute(c, 'p', 'style')!;
  copy.model = 'changed';
  assert.equal(c.routes.project.model, 'project');
});

test('invalid configuration is rejected without echoing input', () => {
  for (const invalid of [
    { ...config(), roles: { typo: 'global' } }, { ...config(), groups: { critic: 'global' } },
    { ...config(), default: 'missing' }, { ...config(), apiKey: 'secret' },
    { ...config(), routes: { r: { runtime: 'codex', model: '' } } },
    { ...config(), routes: { r: { ...route, model: 'x & echo secret' } } },
    { ...config(), routes: { r: { ...route, provider: { id: 'x', baseUrl: 'https://example.org', protocol: 'chat', envKey: 'KEY' } } } },
    { ...config(), routes: { r: { ...route, provider: { id: 'x', baseUrl: 'https://user:secret@example.org', protocol: 'responses', envKey: 'KEY' } } } },
    { ...config(), routes: { r: { ...route, timeoutMs: 0 } } },
  ]) assert.throws(() => parseRouting(invalid), (e: Error) => /Model routing:/.test(e.message) && !e.message.includes('secret'));
});

test('vision, credentials and protocol preflight; unknown vision is explicitly unverified', () => {
  assert.throws(() => preflightRoute({ ...route, vision: false }, 'shot_qa'), /text-only/);
  assert.throws(() => preflightRoute({ ...route, vision: undefined }, 'critique'), /unverified/);
  preflightRoute({ ...route, vision: undefined }, 'build_chunk');
  const custom: AgentRoute = { ...route, provider: { id: 'gateway', protocol: 'responses', baseUrl: 'http://127.0.0.1:4000/v1', envKey: 'TEST_KEY' } };
  assert.throws(() => preflightRoute(custom, 'style', {}), /missing credential environment variable TEST_KEY/);
  preflightRoute(custom, 'style', { TEST_KEY: 'secret' });
  assert.throws(() => preflightRoute({ ...custom, runtime: 'claude' }, 'style'), /requires/);
});

test('active and interrupted sessions stay pinned, including legacy defaults', () => {
  assert.deepEqual(selectSessionRoute(route, { ...route, model: 'new' }, 'sid'), route);
  assert.equal(selectSessionRoute(null, route, 'sid'), null);
  assert.throws(() => selectSessionRoute(undefined, route, 'old-session'), /new project/);
  assert.deepEqual(selectSessionRoute(undefined, route), route);
});

test('native CLI arguments support new and resumed runs; credentials stay in child environment', () => {
  const custom: AgentRoute = { ...route, provider: { id: 'openrouter', protocol: 'responses', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'ROUTING_TEST_KEY' } };
  for (const sid of [null, 'session-id']) {
    const args = codexArgs(sid, 'C:/space dir', custom);
    assert.equal(args[args.indexOf('--model') + 1], route.model);
    assert.ok(args.includes('model_provider="reelmimic_route"'));
    assert.ok(args.includes('model_providers.reelmimic_route.env_key="ROUTING_TEST_KEY"'));
    assert.equal(args.includes('--resume'), false);
    assert.equal(args.includes('resume'), !!sid);
    assert.ok(!args.includes('secret'));
    const claude = claudeArgs(sid, { ...route, runtime: 'claude' });
    assert.ok(claude.includes('--model'));
    assert.equal(claude.includes('--resume'), !!sid);
  }
  const previous = { ...process.env };
  try {
    process.env.ROUTING_TEST_KEY = 'secret'; process.env.ANTHROPIC_API_KEY = 'old';
    const env = routeEnvironment({ ...custom, runtime: 'claude', provider: { ...custom.provider!, protocol: 'anthropic' } });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY, 'old');
    assert.equal(redact('secret old', process.env), '[redacted] [redacted]');
  } finally { process.env = previous; }
  assert.equal(codexArgs(null, '.').includes('--model'), false);
});

const temp = mkdtempSync(join(tmpdir(), 'reelmimic-routing-'));
after(() => rmSync(temp, { recursive: true, force: true }));
const cli = join(temp, 'fake-cli.mjs');
writeFileSync(cli, `
import { writeFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
const emit = o => console.log(JSON.stringify(o));
if (prompt === 'malformed') { console.log('not JSON'); process.exit(0); }
emit({type:'thread.started',thread_id:'test-session'});
if (prompt === 'wait') { setTimeout(() => writeFileSync('late.txt', 'bad'), 10000); }
else if (prompt === 'fail-before' || prompt === 'fail-after') {
  if (prompt === 'fail-after') {
    writeFileSync('side-effect.txt','once');
    emit({type:'item.started',item:{type:'command_execution',command:'write file'}});
  }
  console.error(process.env.ROUTING_TEST_KEY || 'quota');
  emit({type:'turn.failed',error:{message:'quota exhausted'}}); process.exitCode = 1;
} else {
  writeFileSync('output.txt', prompt);
  emit({type:'item.started',item:{type:'command_execution',command:'write file'}});
  emit({type:'item.completed',item:{type:'agent_message',text:'done'}});
  emit({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}});
}
`);

test('fake CLI writes files, streams events, resumes, reports only returned usage; failures never replay', async () => {
  const old = process.env.CODEX_BIN, key = process.env.ROUTING_TEST_KEY;
  process.env.CODEX_BIN = cli; process.env.ROUTING_TEST_KEY = 'do-not-leak-this-key';
  try {
    const events: AgentEvent[] = [];
    const invoke = (prompt: string, sessionId?: string) => runAgent({ kind: 'codex', cwd: temp, prompt, route, sessionId, onEvent: e => events.push(e) });
    const result = await invoke('build');
    assert.equal(result.ok, true); assert.equal(result.sessionId, 'test-session');
    assert.equal(readFileSync(join(temp, 'output.txt'), 'utf8'), 'build');
    assert.ok(events.some(e => e.type === 'tool'));
    assert.ok(events.some(e => e.type === 'done' && e.usage?.input_tokens === 12 && e.cost === null));
    assert.equal((await invoke('fix', result.sessionId!)).ok, true);
    assert.ok(JSON.parse(readFileSync(join(temp, 'args.json'), 'utf8')).includes('resume'));
    assert.equal((await invoke('malformed')).ok, false);
    for (const mode of ['fail-before', 'fail-after']) {
      events.length = 0;
      const failed = await invoke(mode);
      assert.equal(failed.ok, false);
      assert.equal(events.filter(e => e.type === 'session').length, 1);
      assert.ok(!JSON.stringify({ failed, events }).includes('do-not-leak-this-key'));
    }
    assert.equal(readFileSync(join(temp, 'side-effect.txt'), 'utf8'), 'once');
    events.length = 0;
    const controller = new AbortController();
    const promise = runAgent({ kind: 'codex', cwd: temp, prompt: 'wait', route, signal: controller.signal, onEvent: e => { if (e.type === 'session') controller.abort(); } });
    assert.equal((await promise).ok, false);
    assert.equal(existsSync(join(temp, 'late.txt')), false);
    assert.equal((await runAgent({ kind: 'codex', cwd: temp, prompt: 'wait', route: { ...route, timeoutMs: 1000 } })).ok, false);
    assert.equal((await runAgent({ kind: 'codex', cwd: temp, prompt: 'build', route, signal: controller.signal })).lastError, 'Cancelled');
  } finally {
    if (old === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = old;
    if (key === undefined) delete process.env.ROUTING_TEST_KEY; else process.env.ROUTING_TEST_KEY = key;
  }
});
