// The job machine's bookkeeping: round limits, required inputs, approval gate, restart recovery.
// Runs against a throwaway projects folder (REELMIMIC_PROJECTS), never the real one. No agent is started.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-test-'));
process.env.REELMIMIC_PROJECTS = TMP;
const J = await import('./jobs.ts');
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const newJob = (extra = {}) => J.createJob({ id: `t-${++n}`, title: 'test', agent: 'claude', brief: 'a brief', reference: { type: 'url', src: 'https://example.com/v' }, ...extra });
const writePlan = (id: string, plan: object) => writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify(plan));

describe('cleanRounds', () => {
  test('keeps whole numbers in range and only the keys given', () => {
    assert.deepEqual(J.cleanRounds({ castRounds: 2, finalRounds: '5', other: 9 }), { castRounds: 2, finalRounds: 5 });
  });
  test('empty or null means back to the default', () => {
    assert.deepEqual(J.cleanRounds({ chunkRounds: '', castRounds: null }), { chunkRounds: null, castRounds: null });
  });
  test('rejects out of range and fractions', () => {
    assert.throws(() => J.cleanRounds({ castRounds: 0 }), /1 to 10/);
    assert.throws(() => J.cleanRounds({ castRounds: 11 }), /1 to 10/);
    assert.throws(() => J.cleanRounds({ chunkRounds: 2.5 }), /whole number/);
  });
  test('the edges of the range pass', () => {
    assert.deepEqual(J.cleanRounds({ castRounds: 1, finalRounds: 10 }), { castRounds: 1, finalRounds: 10 });
    assert.deepEqual(J.cleanRounds({ chunkRounds: '10' }), { chunkRounds: 10 });
  });
  test('non-numeric input is rejected like the rest', () => {
    assert.throws(() => J.cleanRounds({ castRounds: 'abc' }), /whole number/);
  });
});

describe('projectTitle', () => {
  test('uses the title when one is given', () => {
    assert.equal(J.projectTitle('My video', 'a brief', 'en'), 'My video');
  });
  test('falls back to the first non-empty line of the brief', () => {
    assert.equal(J.projectTitle('', '\n  \nA video about cats\nmore', 'en'), 'A video about cats');
    assert.equal(J.projectTitle('   ', 'Line one\r\nLine two', 'zh-TW'), 'Line one');
  });
  test('the placeholder follows the project language', () => {
    assert.equal(J.projectTitle('', '\n', 'en'), 'Untitled');
    assert.equal(J.projectTitle('', '', 'zh-TW'), '未命名');
    assert.equal(J.projectTitle(undefined, '', 'zh-CN'), '未命名');
  });
  test('cuts at 40 characters without splitting an emoji', () => {
    assert.equal(J.projectTitle('a'.repeat(39) + '🎬🎬', '', 'en'), 'a'.repeat(39) + '🎬');
  });
});

describe('project settings', () => {
  test('a new project uses the server defaults', () => {
    const { id } = newJob();
    assert.deepEqual(J.rounds(id), { castRounds: J.CONFIG.castRounds, chunkRounds: J.CONFIG.chunkRounds, finalRounds: J.CONFIG.finalRounds });
  });
  test('setRounds overrides one limit, and null resets it', () => {
    const { id } = newJob({ settings: { finalRounds: 4 } });
    assert.equal(J.rounds(id).finalRounds, 4);
    J.setRounds(id, { castRounds: 7 });
    assert.equal(J.rounds(id).castRounds, 7);
    assert.equal(J.rounds(id).finalRounds, 4);
    const snap = J.setRounds(id, { finalRounds: '' });
    assert.equal(snap.rounds.values.finalRounds, J.CONFIG.finalRounds);
    assert.equal(snap.rounds.defaults.castRounds, J.CONFIG.castRounds);
  });
});

describe('required inputs', () => {
  let id: string;
  before(() => {
    id = newJob().id;
    writePlan(id, { required_inputs: [{ id: 'lyrics', kind: 'lyrics', label: 'Lyrics' }, { id: 'logo', kind: 'image', label: 'Logo' }, { id: 'song', kind: 'audio', label: 'Song' }] });
  });
  const status = () => Object.fromEntries(J.snapshot(id).requiredInputs.map((r) => [r.id, r.status]));

  test('everything starts missing and approval is refused with 409', async () => {
    assert.deepEqual(status(), { lyrics: 'missing', logo: 'missing', song: 'missing' });
    await assert.rejects(J.approve(id), (e: Error & { code?: number }) => e.code === 409 && /Lyrics/.test(e.message));
  });
  test('waive and unwaive', () => {
    J.waive(id, 'song');
    assert.equal(status().song, 'waived');
    J.unwaive(id, 'song');
    assert.equal(status().song, 'missing');
  });
  test('a file uploaded for an item counts whatever its name', () => {
    mkdirSync(join(J.dirOf(id), 'inputs'), { recursive: true });
    writeFileSync(join(J.dirOf(id), 'inputs', 'IMG_0042.png'), '');
    assert.equal(J.provideInput(id, 'logo', ['inputs/IMG_0042.png']), true);
    assert.equal(status().logo, 'provided');
    assert.deepEqual(J.snapshot(id).requiredInputs.find((r) => r.id === 'logo')?.files, ['inputs/IMG_0042.png']);
  });
  test('an unknown item or no files is refused', () => {
    assert.equal(J.provideInput(id, 'nope', ['inputs/x.png']), false);
    assert.equal(J.provideInput(id, 'logo', []), false);
  });
  test('pasted lyrics satisfy the lyrics item', () => {
    writeFileSync(join(J.dirOf(id), 'inputs', 'lyrics.txt'), 'la la la\n');
    assert.equal(status().lyrics, 'provided');
  });
  test('a file named after the item id counts', () => {
    writeFileSync(join(J.dirOf(id), 'inputs', 'my-song.mp3'), '');
    assert.equal(status().song, 'provided');
    assert.deepEqual(J.openInputs(id), []);
  });
});

describe('restart recovery', () => {
  test('a job that was working is marked interrupted, a finished one is left alone', () => {
    const working = newJob().id, done = newJob().id;
    for (const [id, stage] of [[working, 'planning'], [done, 'done']] as const) {
      const f = join(J.dirOf(id), 'job.json');
      writeFileSync(f, JSON.stringify({ ...J.load(id), stage }));
    }
    J.recoverOrphans();
    const w = J.load(working);
    assert.equal(w.stage, 'error');
    assert.equal(w.failed, 'planning');
    assert.equal(w.chat.at(-1)?.role, 'system');
    assert.equal(J.load(done).stage, 'done');
  });
});

describe('project list', () => {
  test('lists every project, newest first', () => {
    const list = J.listJobs();
    assert.ok(list.length >= 5);
    const times = list.map((p) => p.updatedAt || '');
    assert.deepEqual(times, [...times].sort().reverse());
  });
});
