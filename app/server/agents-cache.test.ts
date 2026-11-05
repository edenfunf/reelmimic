import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentCache, ttlFromEnv, DEFAULT_TTL_MS, MISS_TTL_MS } from './agents-cache.ts';
import type { AgentStatus } from '../shared/types.ts';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
// A detector whose answers are scripted per call; counts the calls
function detector(answer: (call: number) => AgentStatus) {
  const d = { calls: 0, detect: async () => answer(++d.calls) };
  return d;
}
const tick = () => new Promise((r) => setImmediate(r));

test('reuses the detection inside the ttl', async () => {
  const c = clock(), d = detector((n) => ({ claude: `v${n}`, codex: 'codex 1', opencode: 'opencode 1' }));
  const status = createAgentCache(d.detect, 1000, c.now);
  assert.equal((await status()).claude, 'v1');
  c.advance(999);
  assert.equal((await status()).claude, 'v1');
  assert.equal(d.calls, 1);
});

test('a stale answer is served at once and refreshed in the background', async () => {
  const c = clock(), d = detector((n) => ({ claude: `v${n}`, codex: 'codex 1', opencode: 'opencode 1' }));
  const status = createAgentCache(d.detect, 1000, c.now);
  await status();
  c.advance(1000);
  assert.equal((await status()).claude, 'v1');   // no request waits on the re-probe
  await tick();
  assert.equal(d.calls, 2);
  assert.equal((await status()).claude, 'v2');
});

test('a missing agent is re-checked sooner, so a new install shows up without a restart', async () => {
  const c = clock(), d = detector((n) => ({ claude: 'claude 1', codex: n > 1 ? 'codex 1' : null, opencode: 'opencode 1' }));
  const status = createAgentCache(d.detect, DEFAULT_TTL_MS, c.now);
  assert.equal((await status()).codex, null);
  c.advance(MISS_TTL_MS);
  await status();
  await tick();
  assert.equal((await status()).codex, 'codex 1');
});

test('refresh waits for a new probe', async () => {
  const c = clock(), d = detector((n) => ({ claude: null, codex: n > 1 ? 'codex 1' : null, opencode: null }));
  const status = createAgentCache(d.detect, DEFAULT_TTL_MS, c.now);
  await status();
  assert.equal((await status(true)).codex, 'codex 1');
});

test('concurrent requests share one probe', async () => {
  const d = detector(() => ({ claude: 'claude 1', codex: null, opencode: null }));
  const status = createAgentCache(d.detect, 1000, clock().now);
  await Promise.all([status(), status(), status(true)]);
  assert.equal(d.calls, 1);
});

test('a ttl of zero disables the cache', async () => {
  const d = detector(() => ({ claude: null, codex: null, opencode: null }));
  const status = createAgentCache(d.detect, 0, () => 0);
  await status();
  await status();
  assert.equal(d.calls, 2);
});

test('AGENTS_TTL_MS: only a real non-negative number overrides the default', () => {
  assert.equal(ttlFromEnv(undefined), DEFAULT_TTL_MS);
  assert.equal(ttlFromEnv(''), DEFAULT_TTL_MS);
  assert.equal(ttlFromEnv('5m'), DEFAULT_TTL_MS);
  assert.equal(ttlFromEnv('-1'), DEFAULT_TTL_MS);
  assert.equal(ttlFromEnv('0'), 0);
  assert.equal(ttlFromEnv('60000'), 60000);
});
