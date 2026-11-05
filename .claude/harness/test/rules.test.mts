import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchored, block, problems, renderTable, ruleIds } from '../sync-rules.mts';
import { ENFORCEMENT } from '../rules.mts';

test('the repo is in step: CLAUDE.md, AGENTS.md, rules.mts, policies and docs/HARNESS.md', () => {
  assert.deepEqual(problems(), []);
});

test('an anchor in a comment does not count; in code or a string it does', () => {
  const ts = [
    '// contactSheet() builds the sheet',
    '/* reviewFix is gone */',
    "const url = 'http://x/*not a comment*/', re = /[\"'`]\\/\\//g, n = a / b / c;",
    'const p = `out/check/shots/*.review.json ${k ? `S${n}` : \'\'} 每鏡 ≥ 4`; // trailing stop_hook_active',
    'if (e.stop_hook_active) liveCode();',
  ].join('\n');
  assert.equal(anchored(ts, 'a.mts', 'contactSheet'), false);
  assert.equal(anchored(ts, 'a.mts', 'reviewFix'), false);
  assert.equal(anchored(ts, 'a.mts', 'not a comment'), true, '/* inside a string');
  assert.equal(anchored(ts, 'a.mts', '每鏡 ≥ 4'), true, 'after a template nested in ${ }');
  assert.equal(anchored(ts, 'a.mts', 'stop_hook_active'), true);
  assert.equal(anchored(ts, 'a.mts', 'liveCode'), true);
  assert.equal(anchored('stop_hook_active_x = 1', 'a.ts', 'stop_hook_active'), false, 'a whole word');
  assert.equal(anchored("# ASSETS.md\nx = 1", 'f.py', 'ASSETS.md'), false);
  assert.equal(anchored("p = 'ASSETS.md'  # write it", 'f.py', 'ASSETS.md'), true);
  assert.equal(anchored('"""\n# not a comment: ASSETS.md\n"""', 'f.py', 'ASSETS.md'), true, 'inside a docstring');
  assert.equal(anchored('echo "not restarting" # fine', 'r.sh', 'not restarting'), true);
  assert.equal(anchored('n=${#a} # x', 'r.sh', 'n=${#a}'), true, '# inside a word is not a comment');
  assert.equal(anchored('<!-- 目前只做 2D -->\ntext', 'S.md', '目前只做 2D'), false);
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
