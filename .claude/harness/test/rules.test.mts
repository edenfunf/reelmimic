import assert from 'node:assert/strict';
import { test } from 'node:test';
import { block, problems, renderTable, ruleIds } from '../sync-rules.mts';
import { ENFORCEMENT } from '../rules.mts';

test('the repo is in step: CLAUDE.md, AGENTS.md, rules.mts, policies and docs/HARNESS.md', () => {
  assert.deepEqual(problems(), []);
});

test('rule ids are read from the shared block only', () => {
  const t = 'intro\n- `not-a-rule` above\n<!-- harness:shared x -->\n## 規則\n- `a-rule` 文字\n- plain line\n- `b2` more\n<!-- /harness:shared -->\n';
  const b = block(t, ['<!-- harness:shared', '<!-- /harness:shared -->']);
  assert.deepEqual(ruleIds(b!), ['a-rule', 'b2']);
  assert.equal(block('nothing here', ['<!-- a', '<!-- /a -->']), null);
});

test('the table marks rules nothing checks', () => {
  const rows = renderTable().split('\n').filter((l) => l.startsWith('| `'));
  assert.equal(rows.length, Object.keys(ENFORCEMENT).length);
  for (const [id, L] of Object.entries(ENFORCEMENT))
    assert.equal(rows.find((r) => r.startsWith(`| \`${id}\``))!.includes('⚠️ prompt only'), L.every((e) => e.layer === 'prompt'), id);
});
