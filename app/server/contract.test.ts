// contract.ts: what an agent-written file must look like before the server acts on it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFile, checkProduction } from './contract.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ok = (f: string, v: unknown) => assert.deepEqual(checkFile(f, JSON.stringify(v)), []);
const bad = (f: string, v: unknown, re: RegExp) => { const p = checkFile(f, typeof v === 'string' ? v : JSON.stringify(v)); assert.ok(p.some((x) => re.test(x)), p.join('\n') || 'no problems'); };

describe('production cast consistency', () => {
  const check = (plan: unknown, production: unknown, sheets: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'reelmimic-cast-'));
    try {
      mkdirSync(join(dir, 'build'));
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan));
      writeFileSync(join(dir, 'build/production.json'), JSON.stringify(production));
      for (const sheet of sheets) { mkdirSync(join(dir, 'out/check/cast'), { recursive: true }); writeFileSync(join(dir, sheet), 'jpg'); }
      return checkProduction(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const chunks = [{ id: 'C1', shots: ['S1'] }];
  const hero = { id: 'hero', file: 'build/hero.js', sheet: 'out/check/cast/sheet_hero.jpg' };
  test('empty or omitted character lists need no cast sheets', () => {
    assert.deepEqual(check({ characters: [], assets: [{ id: 'circle', status: 'drawn_in_code' }] }, { chunks, characters: [] }), []);
    assert.deepEqual(check({}, { chunks }), []);
  });
  test('nonempty planned cast cannot silently disappear from production', () => {
    assert.match(check({ characters: [{ id: 'hero' }] }, { chunks, characters: [] }).join('\n'), /planned character "hero" is missing/);
    assert.match(check({ characters: [{ id: 'hero' }] }, { chunks }).join('\n'), /planned character "hero" is missing/);
  });
  test('unexpected, substituted and duplicate cast IDs are rejected', () => {
    assert.match(check({ characters: [] }, { chunks, characters: [hero] }).join('\n'), /unplanned character "hero"/);
    assert.match(check({ characters: [{ id: 'cat' }] }, { chunks, characters: [hero] }).join('\n'), /planned character "cat" is missing/);
    assert.match(check({ characters: [{ id: 'hero' }, { id: 'hero' }] }, { chunks, characters: [hero] }).join('\n'), /duplicate character IDs/);
    assert.match(check({ characters: [{ id: 'hero' }] }, { chunks, characters: [hero, hero] }).join('\n'), /duplicate character IDs/);
  });
  test('real characters require lineup and individual sheets plus production file metadata', () => {
    const plan = { characters: [{ id: 'hero' }] }, prod = { chunks, characters: [hero] };
    assert.match(check(plan, prod).join('\n'), /sheet.jpg: required/);
    assert.match(check(plan, prod, ['out/check/cast/sheet.jpg']).join('\n'), /sheet_hero.jpg: missing/);
    assert.deepEqual(check(plan, prod, ['out/check/cast/sheet.jpg', hero.sheet]), []);
    assert.match(check(plan, { chunks, characters: [{ id: 'hero' }] }).join('\n'), /hero.file: required/);
    assert.match(check(plan, { chunks, characters: [{ id: 'hero' }] }).join('\n'), /hero.sheet: required/);
  });
  test('malformed production metadata is not interpreted as no cast', () => {
    assert.match(check({ characters: [] }, {}).join('\n'), /chunks: missing/);
    assert.match(check({ characters: 'none' }, { chunks, characters: [] }).join('\n'), /expected array/);
  });
});

describe('checkFile', () => {
  test('any .json must parse; files without a schema need nothing more', () => {
    bad('out/check/shots/C1.done.json', '{ oops', /not valid JSON/);
    ok('out/check/shots/C1.done.json', { anything: 1 });
  });
  test('plan.json: the CONTRACT.md example passes, wrong field types are named', () => {
    ok('plan.json', { version: 1, title: 'T', music: { file: 'inputs/song.mp3', section: { start_s: 100.84, end_s: 131.7 } }, characters: [{ id: 'zhai', name: '阿宅', design: '…' }], assets: [{ id: 'A1', status: 'to_fetch' }], required_inputs: [{ id: 'lyrics', kind: 'lyrics' }], shots: [{ id: 'S1', camera: { move: 'dolly_in' } }] });
    bad('plan.json', { characters: [{ name: 'no id' }] }, /plan\.json\.characters\[0\]\.id: missing/);
    bad('plan.json', { required_inputs: [{ id: 'x' }] }, /required_inputs\[0\]\.kind: missing/);
    bad('plan.json', [], /expected object, got array/);
  });
  test('production.json needs chunks with shots', () => {
    ok('build/production.json', { chunks: [{ id: 'C1', shots: ['S1', 'S2'] }], characters: [{ id: 'hero', file: 'build/hero.js', sheet: 'out/check/cast/sheet_hero.jpg' }] });
    bad('build/production.json', {}, /chunks: missing/);
    bad('build/production.json', { chunks: [] }, /at least 1/);
    bad('build/production.json', { chunks: [{ id: 'C1', shots: [] }] }, /chunks\[0\]\.shots: needs at least 1/);
  });
  test('reviews need a verdict; issues need their text', () => {
    ok('out/check/cast/review.json', { pass: true, issues: [] });
    ok('out/check/cast/review_hero.json', { issues: [{ issue: 'arm floats', severity: 'blocker' }] });
    ok('out/check/shots/S1.review.json', { shots: [{ id: 'S1', pass: false, issues: [{ time: 1.2, where: 'left', issue: 'seam' }] }] });
    bad('out/check/shots/S1.review.json', { summary: 'looks fine' }, /needs "pass", "issues" or "shots"/);
    bad('out/check/cast/review.json', { pass: 'yes' }, /pass: expected boolean/);
    bad('out/check/cast/review.json', { pass: false, issues: ['arm'] }, /issues\[0\]: expected object/);
    bad('out/check/cast/review.json', { pass: false, needs_user: [{ kind: 'lyrics' }] }, /needs_user\[0\]\.issue: missing/);
  });
  test('fixes files: a list or { fixes }', () => {
    ok('out/check/shots/C1.fixes.json', [{ shot: 'S1', change: 'x', status: 'fixed' }]);
    ok('out/check/cast/fixes_hero.json', { fixes: [{ status: 'shared', issue: 'rig neck' }] });
    bad('out/check/fixes.json', { done: true }, /expected array/);
  });
  test('critique: must_fix items need an issue (nulls are tolerated); display fields are free', () => {
    ok('out/check/critique.json', { pass: false, must_fix: [{ shot: 'S1', time: '3.2s', issue: 'seam' }, null], needs_user: [] });
    bad('out/check/critique.json', { must_fix: [{ shot: 'S1' }] }, /must_fix\[0\]/);
  });
});
