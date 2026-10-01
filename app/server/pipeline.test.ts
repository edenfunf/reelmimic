// The whole production line with a fake agent: every turn writes the files its step must produce (as a real agent
// would, per CONTRACT.md), and each scenario decides which reviews pass. Checks the order of steps and where it ends.
import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AgentRun } from './agents/index.ts';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-pipe-'));
process.env.REELMIMIC_PROJECTS = TMP;
after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------- the fake agent ----------
interface Scenario {
  chars: string[];                                         // character ids
  chunks: { id: string; shots: string[] }[];
  castPass: (who: string, round: number) => boolean;       // who: a character id, 'lineup' or 'serial'
  shotPass: (shot: string, round: number) => boolean;
  sharedFix?: (chunk: string, call: number) => boolean;    // the builder reports a shared-file problem instead
  castShared?: (char: string, call: number) => boolean;
  critique: (round: number) => { must?: number; needs?: number };
  buildDelayMs?: number;                                   // let the per-shot watcher (every 4 s) pick shots up
  onCall?: (name: string) => void;                         // runs as each turn starts (e.g. the user clicks Cancel)
}
let S: Scenario;
let calls: string[] = [];
const count: Record<string, number> = {};
const bump = (k: string) => (count[k] = (count[k] || 0) + 1);

function outputs(prompt: string, dir: string): [string, Record<string, unknown>] {
  const m = (re: RegExp) => prompt.match(re);
  const json = (o: unknown) => o;
  let r: RegExpMatchArray | null;
  if (m(/## 步驟：風格拆解/)) return ['style', { 'analysis/STYLE.md': '# 2D', 'analysis/route.json': { engine: 'no-such-engine' } }];
  if (m(/## 步驟：前製企劃/)) return ['plan', { 'plan.json': { title: 'T', version: 1, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js` })) }, 'STORYBOARD.md': '# SB' }];
  if ((r = m(/## 步驟：做角色「[^」]+」[\s\S]*?只寫 (\S+?)：/))) return [`pre_cast`, { [r[1]]: '// character' }];
  if (m(/## 步驟：整合前製結果/)) return ['plan_frames', { 'plan.json': { title: 'T', version: 2, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js` })) } }];
  if (m(/## 步驟：依使用者意見修改企劃/)) return ['replan', { 'plan.json': { title: 'T', version: 3 } }];
  if (m(/## 步驟：製作準備/)) return ['setup', {
    'build/production.json': { chunks: S.chunks, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js`, sheet: `out/check/cast/sheet_${id}.jpg` })) },
    'out/check/cast/sheet.jpg': 'jpg', ...Object.fromEntries(S.chars.map((id) => [`out/check/cast/sheet_${id}.jpg`, 'jpg'])) }];
  if (m(/## 步驟：角色關/)) {
    const round = +(m(/第 (\d+) 輪/)?.[1] || 1), ch = m(/結果寫到 out\/check\/cast\/review_(\S+?)\.json/)?.[1];
    const who = ch || (m(/只看並排圖/) ? 'lineup' : 'serial'), ok = S.castPass(who, round);
    return [`cast_qa:${who}`, { [ch ? `out/check/cast/review_${ch}.json` : 'out/check/cast/review.json']: json({ pass: ok, issues: ok ? [] : [{ issue: 'arm floats', severity: 'blocker' }] }) }];
  }
  if (m(/## 步驟：修角色/)) {
    const ch = m(/修正紀錄寫到 out\/check\/cast\/fixes_(\S+?)\.json/)?.[1];
    if (m(/只處理各角色 agent 回報需要改共用骨架/)) return ['cast_fix:shared', { 'out/check/cast/sheet.jpg': 'jpg' }];
    if (ch) {
      const shared = S.castShared?.(ch, bump(`cs-${ch}`));
      return [`cast_fix:${ch}`, { [`out/check/cast/sheet_${ch}.jpg`]: 'jpg', [`out/check/cast/fixes_${ch}.json`]: shared ? [{ status: 'shared', issue: 'rig neck' }] : [{ issue: 'arm', change: 'fixed' }] }];
    }
    return ['cast_fix:serial', { 'out/check/cast/sheet.jpg': 'jpg', 'out/check/cast/fixes.json': [{ issue: 'arm', change: 'fixed' }] }];
  }
  if ((r = m(/## 步驟：製作鏡頭段 (\S+?)：(.+)/))) {
    const shots = r[2].trim().split('、');
    return [`build:${r[1]}`, { ...Object.fromEntries(shots.map((s) => [`out/check/shots/${s}.done.json`, { id: s }])), [`out/check/shots/${r[1]}.done.json`]: { shots: shots.map((id) => ({ id })) } }];
  }
  if ((r = m(/## 步驟：審查鏡頭 (\S+?)（屬於段落 (\S+?)，第 (\d+) 輪）/))) {
    const [sid, round] = [r[1], +r[3]], ok = S.shotPass(sid, round), out = m(/寫 (out\/check\/shots\/\S+?\.review\.json)（JSON）/)![1];
    return [`shot_qa:${sid}:${round}`, { [out]: { shots: [{ id: sid, pass: ok, issues: ok ? [] : [{ issue: 'seam', severity: 'blocker' }] }] } }];
  }
  if ((r = m(/## 步驟：修鏡頭段 (\S+?)（/))) {
    const c = r[1], shared = S.sharedFix?.(c, bump(`sf-${c}`)), shot = S.chunks.find((x) => x.id === c)!.shots[0];
    return [`fix:${c}`, { [`out/check/shots/${c}.fixes.json`]: shared ? [{ status: 'shared', shot, issue: 'rig hand' }] : [{ shot, change: 'fixed' }] }];
  }
  if ((r = m(/## 步驟：修共用檔（鏡頭段 (\S+?) /))) return [`shared_fix:${r[1]}`, { [`out/check/shots/${r[1]}.shared.json`]: [{ api: 'handR' }] }];
  if (m(/## 步驟：組裝成片/)) return ['assemble', { 'out/video.mp4': 'mp4' }];
  if (m(/獨立評審/)) {
    const round = bump(`critique-${dir}`), c = S.critique(round);
    return [`critique`, { 'out/check/critique.json': { must_fix: Array.from({ length: c.must || 0 }, (_, i) => ({ shot: 'S1', issue: `must ${i}` })), needs_user: Array.from({ length: c.needs || 0 }, () => ({ kind: 'text', issue: 'confirm the lyric' })) } }];
  }
  if (m(/## 步驟：修改成片/)) return ['revise', { 'out/video.mp4': 'mp4', 'out/check/fixes.json': [{ status: 'fixed' }] }];
  throw new Error('fake agent: unknown step\n' + prompt.slice(0, 300));
}

async function fakeAgent({ cwd, prompt, onEvent }: AgentRun) {
  const dir = resolve(cwd, prompt.match(/專案資料夾：(\S+?)[（。]/)![1]);
  const [name, files] = outputs(prompt, dir);
  calls.push(name);
  S.onCall?.(name);
  if (name.startsWith('build:') && S.buildDelayMs) {   // shot files first, the segment file after the delay
    const entries = Object.entries(files), last = entries.pop()!;
    for (const [f, v] of entries) put(dir, f, v);
    await new Promise((r) => setTimeout(r, S.buildDelayMs));
    put(dir, ...last);
  } else for (const [f, v] of Object.entries(files)) put(dir, f, v);
  onEvent?.({ type: 'session', id: `sess-${calls.length}` });
  return { sessionId: `sess-${calls.length}`, text: `did ${name}`, ok: true, code: 0, stderr: '', lastError: '' };
}
function put(dir: string, f: string, v: unknown) {
  const p = join(dir, f); mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
}

mock.module('./agents/index.ts', { namedExports: { runAgent: fakeAgent, agentStatus: () => ({ claude: 'fake', codex: null }) } });
const J = await import('./jobs.ts');

// ---------- helpers ----------
let n = 0;
function newProject(stage: 'plan_review' | 'error', extra: Record<string, unknown> = {}) {
  const id = `p-${++n}`;
  J.createJob({ id, title: 't', agent: 'claude', brief: 'make a video', reference: { type: 'url', src: 'https://example.com' } });
  const f = join(J.dirOf(id), 'job.json');
  writeFileSync(f, JSON.stringify({ ...J.load(id), stage, ...extra }));
  if (stage === 'plan_review') writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1 }));
  return id;
}
const base = (o: Partial<Scenario> = {}): Scenario => ({
  chars: ['hero'], chunks: [{ id: 'C1', shots: ['S1'] }, { id: 'C2', shots: ['S2'] }],
  castPass: () => true, shotPass: () => true, critique: () => ({}), ...o,
});
beforeEach(() => { calls = []; for (const k of Object.keys(count)) delete count[k]; });

describe('pre-production', () => {
  test('retrying a failed style step runs style → plan → characters → plan frames, then waits for approval', async () => {
    S = base({ chars: ['hero', 'cat'] });
    const id = newProject('error', { failed: 'styling' });
    await J.retry(id);
    assert.equal(J.load(id).stage, 'plan_review');
    assert.deepEqual(calls.slice(0, 2), ['style', 'plan']);
    assert.deepEqual(calls.slice(2, 4), ['pre_cast', 'pre_cast']);
    assert.equal(calls[4], 'plan_frames');
    assert.ok(existsSync(join(J.dirOf(id), 'build', 'hero.js')));
  });
});

describe('production', () => {
  test('happy path: one character, two segments, final review passes → done', async () => {
    S = base();
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'done', j.error || '');
    assert.equal(calls[0], 'setup');
    assert.ok(calls.includes('cast_qa:serial'));
    assert.deepEqual(calls.filter((c) => c.startsWith('build:')).sort(), ['build:C1', 'build:C2']);
    assert.deepEqual(calls.slice(-2), ['assemble', 'critique']);
    assert.deepEqual(Object.values(j.pipeline.chunks!).map((c) => c.state), ['passed', 'passed']);
    assert.equal(j.pipeline.cast?.pass, true);
    assert.ok(j.approvedAt);
  });

  test('failed reviews are fixed and re-reviewed: cast round 2, shot round 2, one revise', async () => {
    S = base({ castPass: (_w, r) => r >= 2, shotPass: (s, r) => s !== 'S2' || r >= 2, critique: (r) => ({ must: r === 1 ? 1 : 0 }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.deepEqual(calls.filter((c) => c.startsWith('cast')), ['cast_qa:serial', 'cast_fix:serial', 'cast_qa:serial']);
    assert.ok(calls.indexOf('fix:C2') > calls.indexOf('shot_qa:S2:1'));
    assert.ok(calls.includes('shot_qa:S2:2'));
    assert.ok(!calls.includes('fix:C1'));
    assert.deepEqual(calls.slice(-3), ['critique', 'revise', 'critique']);
    assert.equal(J.load(id).critiqueRounds, 2);
  });

  test('shot reviews start while the builder is still working (per-shot watcher)', async () => {
    S = base({ chunks: [{ id: 'C1', shots: ['S1', 'S2'] }], buildDelayMs: 4600 });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done');
    // both shots were reviewed exactly once in round 1, not re-reviewed after the build finished
    assert.equal(calls.filter((c) => c.startsWith('shot_qa:S1:1')).length, 1);
    assert.equal(calls.filter((c) => c.startsWith('shot_qa:S2:1')).length, 1);
  });

  test('parallel cast gate: each character reviewed on its own, then one line-up check', async () => {
    S = base({ chars: ['hero', 'cat'], castPass: (w, r) => w !== 'cat' || r >= 2 });
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'done', j.error || '');
    const cast = calls.filter((c) => c.startsWith('cast'));
    assert.deepEqual(cast.filter((c) => c.includes('hero')), ['cast_qa:hero']);
    assert.deepEqual(cast.filter((c) => c.includes('cat')), ['cast_qa:cat', 'cast_fix:cat', 'cast_qa:cat']);
    assert.equal(cast.at(-1), 'cast_qa:lineup');
    assert.equal(j.pipeline.cast?.mode, 'parallel');
    assert.deepEqual(Object.values(j.pipeline.cast!.chars!).map((c) => c.state), ['passed', 'passed']);
  });

  test('a character fix that needs the shared rig goes to the director, then that character is re-checked', async () => {
    S = base({ chars: ['hero', 'cat'], castPass: (w, r) => w !== 'cat' || r >= 2, castShared: (_c, call) => call === 1 });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    const i = calls.indexOf('cast_fix:shared');
    assert.ok(i > calls.indexOf('cast_fix:cat'));
    assert.ok(calls.slice(i).includes('cast_qa:cat'));
  });

  test('a shot problem in a shared file: director fixes it, builder applies it in the same round', async () => {
    S = base({ shotPass: (s, r) => s !== 'S1' || r >= 2, sharedFix: (_c, call) => call === 1 });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    const seq = calls.filter((c) => /C1|S1/.test(c));
    assert.deepEqual(seq.slice(seq.indexOf('fix:C1')), ['fix:C1', 'shared_fix:C1', 'fix:C1', 'shot_qa:S1:2']);
  });
});

describe('pauses', () => {
  test('a segment that hits its round limit pauses for the user; accepting it finishes the film', async () => {
    S = base({ shotPass: (s) => s !== 'S2' });
    const id = newProject('plan_review');
    J.setRounds(id, { chunkRounds: 1 });
    await J.approve(id);
    let j = J.load(id);
    assert.equal(j.stage, 'needs_input');
    assert.equal(j.pipeline.chunks!.C2.state, 'failed');
    assert.ok(!calls.includes('assemble'));
    assert.match(j.chat.at(-1)!.text, /C2/);
    calls = [];
    await J.accept(id);
    j = J.load(id);
    assert.equal(j.stage, 'done', j.error || '');
    assert.equal(j.pipeline.chunks!.C2.acceptedByUser, true);
    assert.deepEqual(calls, ['assemble', 'critique']);
  });

  test('the cast gate stops at its round limit instead of looping', async () => {
    S = base({ castPass: () => false });
    const id = newProject('plan_review');
    J.setRounds(id, { castRounds: 2 });
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'needs_input');
    assert.equal(calls.filter((c) => c === 'cast_qa:serial').length, 2);
    assert.ok(!calls.includes('assemble'));
  });

  test('something only the user can give pauses the job and is listed as a need', async () => {
    S = base({ critique: () => ({ needs: 1 }) });
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'needs_input');
    assert.equal(j.needs.length, 1);
    assert.equal(j.needs[0].from, 'critic');
  });

  test('a user note after the film is done triggers a revise and a fresh final review', async () => {
    S = base();
    const id = newProject('plan_review');
    await J.approve(id);
    calls = [];
    await J.message(id, 'make the title bigger', { time: 3.2 });
    const j = J.load(id);
    assert.equal(j.stage, 'done');
    assert.deepEqual(calls, ['revise', 'critique']);
    assert.ok(j.chat.some((c) => c.role === 'user' && c.text.startsWith('［3.2 秒］')));
  });

  test('a note during plan review replans', async () => {
    S = base();
    const id = newProject('plan_review');
    await J.message(id, 'shorter please');
    assert.deepEqual(calls, ['replan']);
    assert.equal(J.load(id).stage, 'plan_review');
    assert.equal(JSON.parse(readFileSync(join(J.dirOf(id), 'plan.json'), 'utf8')).version, 3);
  });
});

describe('cancel', () => {
  test('cancel during the shot line starts no more segments, and retry carries on', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ id: `C${i + 1}`, shots: [`S${i + 1}`] }));
    let id = '';
    S = base({ chunks, onCall: (name) => { if (name === 'build:C1') J.cancel(id); } });
    id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'error');
    assert.equal(j.failed, 'producing');
    assert.equal(j.error, '已取消');
    const builds = calls.filter((c) => c.startsWith('build:')).length;
    assert.ok(builds <= J.CONFIG.builders, `${builds} segments started after cancel`);
    assert.ok(!calls.includes('assemble'));
    S.onCall = undefined; calls = [];
    await J.retry(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
  });
});
