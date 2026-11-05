import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classify, freshOutput, newestVideo } from '../render.mts';
import { parse, resolvePath } from '../lib/shell.mts';

const B = resolvePath('/p/x/build', process.cwd());
const one = (src: string, cwd = B) => { const r = parse(src, cwd).map(classify).filter(Boolean); return r.length ? r[0] : null; };

test('film renders, with where they write', () => {
  assert.deepEqual(one('node render.mjs --encode --out=out/video.mp4'), { kind: 'film', out: `${B}/out/video.mp4`, engine: 'render.mjs' });
  assert.deepEqual(one('node render.mjs --clip --range=0:4'), { kind: 'film', out: `${B}/out/video.mp4`, engine: 'render.mjs' });
  assert.equal(one('node render.mjs --frames --workers=4 && node render.mjs --encode --out=out/video.mp4')?.kind, 'film');
  assert.deepEqual(one('npx hyperframes render --quality looks --output out.mp4'), { kind: 'film', out: `${B}/out.mp4`, engine: 'hyperframes' });
  assert.deepEqual(one('npx hyperframes render --quality draft'), { kind: 'film', out: null, engine: 'hyperframes' });
  assert.equal(one('npx remotion render src/index.ts Main out/v.mp4')?.out, `${B}/out/v.mp4`);
  assert.equal(one('ffmpeg -y -i v.mp4 -i mix.wav -c:v copy -shortest ../out/video.mp4')?.out, resolvePath('/p/x/out/video.mp4', process.cwd()));
});

test('review images are checks, not films', () => {
  for (const c of ['node render.mjs --sheet=0.5,1,1.5 --out=out/check/a.jpg', 'node render.mjs --strip=2.0:2.5 --crop-at=960,780,500,400 --out=out/check/feet.jpg', 'node render.mjs --stills=1.2 --out=out/stills'])
    assert.equal(one(c)?.kind, 'check', c);
  assert.deepEqual(one('python ../../.claude/skills/video-clone/scripts/hf_frames.py build --at 12.4 --out out/check'), { kind: 'check', out: `${B}/out/check`, engine: 'hf_frames' });
});

test('not renders', () => {
  for (const c of ['node render.mjs --frames --range=0:8 --workers=4', 'ffmpeg -i ref.mp4 -t 5 analysis/clip.mp4', 'npm test', 'node app/server/index.ts', 'cat render.mjs'])
    assert.equal(one(c), null, c);
});

test('only a freshly written file counts as the output', () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-render-')), now = Date.now();
  mkdirSync(join(d, 'out')); const f = join(d, 'out', 'video.mp4'); writeFileSync(f, 'x');
  const r = { kind: 'film' as const, out: f.replace(/\\/g, '/'), engine: 'render.mjs' };
  assert.equal(freshOutput(r, d, { withinMs: 60_000, now }), r.out);
  utimesSync(f, new Date(now - 3600_000), new Date(now - 3600_000));
  assert.equal(freshOutput(r, d, { withinMs: 60_000, now }), null, 'last run’s file left behind by a failed render');
  writeFileSync(join(d, 'renders.mp4'), 'y');
  assert.equal(newestVideo(d, { withinMs: 60_000 })?.endsWith('renders.mp4'), true, 'output not named: the newest fresh video');
  assert.equal(freshOutput({ ...r, out: null }, d, { withinMs: 60_000 })?.endsWith('renders.mp4'), true);
});

test('a render that named its output and did not write it wrote nothing (another fresh video is not it)', () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-named-'));
  writeFileSync(join(d, 'other.mp4'), 'fresh, from some other command');
  const r = { kind: 'film' as const, out: join(d, 'out', 'video.mp4').replace(/\\/g, '/'), engine: 'render.mjs' };
  assert.equal(freshOutput(r, d, { withinMs: 60_000 }), null);
  assert.equal(freshOutput({ ...r, out: null }, d, { withinMs: 60_000 })?.endsWith('other.mp4'), true, 'only an unnamed output is looked for');
});

test('with the call’s start time, a file from 30 s before it is a leftover (the window alone would take it)', () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-since-')), now = Date.now(), f = join(d, 'video.mp4');
  writeFileSync(f, 'x'); utimesSync(f, new Date(now - 30_000), new Date(now - 30_000));
  const r = { kind: 'film' as const, out: f.replace(/\\/g, '/'), engine: 'render.mjs' };
  assert.equal(freshOutput(r, d, { now }), r.out, 'window only: looks fresh');
  assert.equal(freshOutput(r, d, { since: now - 5_000, now }), null, 'started 5 s ago: written before this call');
  assert.equal(freshOutput(r, d, { since: now - 31_000, now }), r.out, 'written during this call');
});
