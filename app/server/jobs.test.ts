// The job machine's bookkeeping: round limits, required inputs, approval gate, restart recovery.
// Runs against a throwaway projects folder (REELMIMIC_PROJECTS), never the real one. No agent is started.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-test-'));
process.env.REELMIMIC_PROJECTS = TMP;
// Make every python spawn fail in this file's process: the alignment test needs the failure path.
process.env.PYTHON = 'rr-no-such-python';
const J = await import('./jobs.ts');
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const newJob = (extra = {}) => J.createJob({ id: `t-${++n}`, title: 'test', agent: 'claude', brief: 'a brief', reference: { type: 'url', src: 'https://example.com/v' }, ...extra });
const writePlan = (id: string, plan: object) => writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify(plan));

describe('engine resolution', () => {
  test('installed engines are the skill folders that carry a SKILL.md', () => {
    const engines = J.installedEngines();
    assert.ok(engines.includes('general-video'));
    assert.ok(engines.includes('seam-craft'));
    assert.deepEqual(engines, [...engines].sort());
  });
  test('resolveEngine trims, folds case, and refuses unknown names', () => {
    assert.deepEqual(J.resolveEngine('seam-craft'), { engine: 'seam-craft', resolvedFrom: null, fallback: false });
    assert.deepEqual(J.resolveEngine('  Seam-Craft '), { engine: 'seam-craft', resolvedFrom: 'Seam-Craft', fallback: false });
    assert.equal(J.resolveEngine('seam-crafi'), null);
    assert.equal(J.resolveEngine('   '), null);
  });
  test('a case-only mismatch freezes the folder spelling and rewrites route.json', () => {
    const { id } = newJob();
    mkdirSync(join(J.dirOf(id), 'analysis'), { recursive: true });
    writeFileSync(join(J.dirOf(id), 'analysis', 'route.json'), JSON.stringify({ engine: 'Seam-Craft', why: ['measured pacing'] }));
    const snap = J.snapshotEngine(id);
    assert.equal(snap?.engine, 'seam-craft');
    assert.equal(snap?.engineResolvedFrom, 'Seam-Craft');
    assert.ok(!snap?.fallback);
    const rewritten = JSON.parse(readFileSync(join(J.dirOf(id), 'analysis', 'route.json'), 'utf8'));
    assert.equal(rewritten.engine, 'seam-craft');
    assert.deepEqual(rewritten.why, ['measured pacing']);
    assert.ok(existsSync(join(J.dirOf(id), 'build', 'engine', 'seam-craft', 'SNAPSHOT.json')));
  });
  test('an unknown engine falls back to the default and records what was asked for', () => {
    const { id } = newJob();
    mkdirSync(join(J.dirOf(id), 'analysis'), { recursive: true });
    writeFileSync(join(J.dirOf(id), 'analysis', 'route.json'), JSON.stringify({ engine: 'painted-animaiton', why: [] }));
    const snap = J.snapshotEngine(id);
    assert.equal(snap?.engine, 'general-video');
    assert.equal(snap?.fallback, true);
    assert.equal(snap?.engineResolvedFrom, 'painted-animaiton');
    assert.equal(JSON.parse(readFileSync(join(J.dirOf(id), 'analysis', 'route.json'), 'utf8')).engine, 'painted-animaiton');
    assert.ok(existsSync(join(J.dirOf(id), 'build', 'engine', 'general-video', 'SNAPSHOT.json')));
  });
  test('no route.json still means no snapshot', () => {
    assert.equal(J.snapshotEngine(newJob().id), null);
  });
});

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

describe('isVideoName', () => {
  test('accepts the video extensions in any letter case', () => {
    for (const name of ['clip.mp4', 'CLIP.MOV', 'a.b.MkV', '參考影片.webm', 'x.avi', 'x.m4v', 'x.mpg', 'x.mpeg']) assert.ok(J.isVideoName(name), name);
  });
  test('rejects subtitles, documents, images and names with no extension', () => {
    for (const name of ['subs.srt', 'brief.pdf', 'poster.png', 'song.mp3', 'clip.mp4.txt', 'reference', '.mp4']) assert.ok(!J.isVideoName(name), name);
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
  test('a new project gets the default (measured) quality and uses that preset', () => {
    const { id } = newJob();
    const P = J.CONFIG.presets.fine;
    assert.equal(J.snapshot(id).quality, 'fine');
    assert.deepEqual(J.rounds(id), { castRounds: P.castRounds, chunkRounds: P.chunkRounds, finalRounds: P.finalRounds });
  });
  test('a project made before quality modes runs the fine line', () => {
    const { id } = newJob();
    const j = J.load(id); delete j.quality; writeFileSync(join(J.dirOf(id), 'job.json'), JSON.stringify(j));
    assert.equal(J.snapshot(id).quality, 'fine');
    assert.equal(J.rounds(id).chunkRounds, J.CONFIG.chunkRounds);
  });
  test('changing the quality changes the defaults; the own settings still win', () => {
    const { id } = newJob({ settings: { finalRounds: 4 } });
    J.setQuality(id, 'fast');
    assert.equal(J.rounds(id).chunkRounds, J.CONFIG.presets.fast.chunkRounds);
    assert.equal(J.rounds(id).finalRounds, 4);
    assert.throws(() => J.setQuality(id, 'ultra'), /quality must be/);
  });
  test('setRounds overrides one limit, and null resets it', () => {
    const { id } = newJob({ settings: { finalRounds: 4 } });
    assert.equal(J.rounds(id).finalRounds, 4);
    J.setRounds(id, { castRounds: 7 });
    assert.equal(J.rounds(id).castRounds, 7);
    assert.equal(J.rounds(id).finalRounds, 4);
    const snap = J.setRounds(id, { finalRounds: '' });
    assert.equal(snap.rounds.values.finalRounds, J.CONFIG.presets.fine.finalRounds);
    assert.equal(snap.rounds.defaults.castRounds, J.CONFIG.presets.fine.castRounds);
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
  test('an unwritable event log warns once in chat instead of losing history silently', async () => {
    const S = await import('./store.ts');
    const cid = newJob().id;
    writeFileSync(join(J.dirOf(cid), 'logs'), 'x');   // block the log path (disk-full/locked-folder land here)
    S.log(cid, { type: 'text', text: 'hello' });
    S.log(cid, { type: 'text', text: 'world' });
    const texts = J.load(cid).chat.map((c) => c.text || '');
    assert.equal(texts.filter((t) => /not writable|寫不進去/.test(t)).length, 1);
    assert.ok(S.recentLog(cid).some((e) => (e as { text?: string }).text === 'hello'));
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

const S = await import('./store.ts');
const I = await import('./inputs.ts');
describe('event log', () => {
  test('an event goes to events.jsonl and the snapshot, without rewriting job.json', () => {
    const { id } = newJob();
    const before = readFileSync(join(J.dirOf(id), 'job.json'), 'utf8');
    S.log(id, { type: 'text', text: 'hello' });
    assert.equal(readFileSync(join(J.dirOf(id), 'job.json'), 'utf8'), before);
    assert.equal(J.snapshot(id).job.log.at(-1)?.type, 'text');
    assert.match(readFileSync(join(J.dirOf(id), 'logs', 'events.jsonl'), 'utf8'), /hello/);
    assert.ok(!('log' in JSON.parse(before)));
  });
  test('after a restart the latest 600 come back from the tail of events.jsonl', () => {
    const id = 'restart-log', d = J.dirOf(id);
    mkdirSync(join(d, 'logs'), { recursive: true });
    writeFileSync(join(d, 'job.json'), JSON.stringify({ id, title: 't', agent: 'claude', stage: 'done', chat: [], needs: [], pipeline: {} }));
    writeFileSync(join(d, 'logs', 'events.jsonl'), Array.from({ length: 700 }, (_, i) => JSON.stringify({ ts: 't', type: 'text', text: `e${i}` })).join('\n') + '\n');
    const log = J.snapshot(id).job.log as { text?: string }[];
    assert.equal(log.length, 600);
    assert.equal(log[0].text, 'e100');
    assert.equal(log.at(-1)!.text, 'e699');
  });
  test('a project from before events.jsonl keeps its log: moved out of job.json on first write', () => {
    const id = 'old-log', d = J.dirOf(id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'job.json'), JSON.stringify({ id, title: 't', agent: 'claude', stage: 'done', chat: [], needs: [], pipeline: {}, log: [{ ts: 't', type: 'text', text: 'old' }] }));
    J.waive(id, 'x');   // any write
    assert.ok(!('log' in JSON.parse(readFileSync(join(d, 'job.json'), 'utf8'))));
    assert.match(readFileSync(join(d, 'logs', 'events.jsonl'), 'utf8'), /"old"/);
    assert.equal((J.snapshot(id).job.log[0] as { text?: string }).text, 'old');
  });
});

describe('lyric alignment notices', () => {
  test('a failed alignment is surfaced in the chat instead of vanishing', async () => {
    const { id } = newJob();
    mkdirSync(join(J.dirOf(id), 'inputs'), { recursive: true });
    writeFileSync(join(J.dirOf(id), 'inputs', 'lyrics.txt'), 'la la la\n');
    writeFileSync(join(J.dirOf(id), 'inputs', 'song.mp3'), '');
    writePlan(id, { music: { file: 'inputs/song.mp3' } });
    const r = await I.alignIfReadyWithNotice(id);
    assert.ok(r === null || r.ok === false, 'alignment must not report success without python');
    const last = J.load(id).chat.at(-1);
    assert.equal(last?.role, 'system');
    assert.match(last?.text || '', /could not be timed|無法為歌詞對時/);
    assert.ok(!existsSync(join(J.dirOf(id), 'analysis', 'lyrics', 'subs.lrc')), 'no subs.lrc without a run');
  });
});
