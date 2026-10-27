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
process.env.PRERENDER_WAIT_MS = '2000';   // assembly gives up on a stuck background render after 2 s here
after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------- the fake agent ----------
interface Scenario {
  chars: string[];                                         // character ids
  chunks: { id: string; shots: string[] }[];
  castPass: (who: string, round: number) => boolean;       // who: a character id, 'lineup' or 'serial'
  shotPass: (shot: string, round: number) => boolean;
  sharedFix?: (chunk: string, call: number) => boolean;    // the builder reports a shared-file problem instead
  castShared?: (char: string, call: number) => boolean;
  critique: (round: number) => { must?: number; needs?: number; lostPeak?: boolean; items?: { shot: string; issue: string }[] };
  buildDelayMs?: number;                                   // let the per-shot watcher (every 4 s) pick shots up
  prerender?: string;                                      // production.json prerender command
  blockers?: number;                                       // blocker issues in a failing shot review (default 1)
  crash?: (step: string) => string | null;                 // this turn fails with that error text, writing nothing
  holdMs?: (step: string) => number;                       // this turn takes that long (ends early when cancelled)
  broken?: (step: string) => 'once' | 'always' | null;     // its JSON files come out unreadable; 'once': the format fix repairs them
  say?: (step: string) => string | null;                   // this turn succeeds and replies with that text
}
const pending = new Map<string, { files: [string, unknown][]; always: boolean }>();   // per project: the good files a format fix writes
let S: Scenario;
let calls: string[] = [];
const count: Record<string, number> = {};
const bump = (k: string) => (count[k] = (count[k] || 0) + 1);

function outputs(prompt: string, dir: string): [string, Record<string, unknown>] {
  const m = (re: RegExp) => prompt.match(re);
  const json = (o: unknown) => o;
  let r: RegExpMatchArray | null;
  if (m(/## 步驟：風格拆解/)) return ['style', { 'analysis/STYLE.md': '# 2D', 'analysis/route.json': { engine: 'no-such-engine' }, 'analysis/peaks.json': [{ id: 'P1', hit: 2 }] }];
  if (m(/## 步驟：前製企劃/)) return ['plan', { 'plan.json': { title: 'T', version: 1, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js` })) }, 'STORYBOARD.md': '# SB' }];
  if ((r = m(/## 步驟：做角色「[^」]+」[\s\S]*?只寫 (\S+?)：/))) return [`pre_cast`, { [r[1]]: '// character' }];
  if (m(/## 步驟：整合前製結果/)) return ['plan_frames', { 'plan.json': { title: 'T', version: 2, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js` })) } }];
  if (m(/## 步驟：依使用者意見修改企劃/)) return ['replan', { 'plan.json': { title: 'T', version: 3 } }];
  if (m(/## 步驟：製作準備/)) return ['setup', {
    'build/production.json': { ...(S.prerender ? { prerender: { cwd: '.', cmd: S.prerender } } : {}), chunks: S.chunks, characters: S.chars.map((id) => ({ id, name: id, file: `build/${id}.js`, sheet: `out/check/cast/sheet_${id}.jpg` })) },
    ...(S.chars.length ? { 'out/check/cast/sheet.jpg': 'jpg' } : {}), ...Object.fromEntries(S.chars.map((id) => [`out/check/cast/sheet_${id}.jpg`, 'jpg'])) }];   // no cast → no sheet
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
    return [`shot_qa:${sid}:${round}`, { [out]: { shots: [{ id: sid, pass: ok, issues: ok ? [] : Array.from({ length: S.blockers ?? 1 }, (_, i) => ({ issue: `seam ${i}`, severity: 'blocker' })) }] } }];
  }
  if ((r = m(/## 步驟：修鏡頭段 (\S+?)（/))) {
    const c = r[1], shared = S.sharedFix?.(c, bump(`sf-${c}`)), shot = S.chunks.find((x) => x.id === c)!.shots[0];
    return [`fix:${c}`, { [`out/check/shots/${c}.fixes.json`]: shared ? [{ status: 'shared', shot, issue: 'rig hand' }] : [{ shot, change: 'fixed' }] }];
  }
  if ((r = m(/## 步驟：修共用檔（鏡頭段 (\S+?) /))) return [`shared_fix:${r[1]}`, { [`out/check/shots/${r[1]}.shared.json`]: [{ api: 'handR' }] }];
  if (m(/## 步驟：組裝成片/)) return ['assemble', { 'out/video.mp4': 'mp4' }];
  if (m(/獨立評審/)) {
    const round = bump(`critique-${dir}`), c = S.critique(round);
    return [`critique`, { 'out/check/critique.json': { peaks: [{ id: 'P1', verdict: c.lostPeak ? 'ref_better' : 'equal', why: 'smaller hit' }], must_fix: c.items ?? Array.from({ length: c.must || 0 }, (_, i) => ({ shot: 'S1', issue: `must ${i}` })), needs_user: Array.from({ length: c.needs || 0 }, () => ({ kind: 'text', issue: 'confirm the lyric' })) } }];
  }
  if (m(/## 步驟：修改成片/)) return ['revise', { 'out/video.mp4': 'mp4', 'out/check/fixes.json': [{ status: 'fixed' }] }];
  throw new Error('fake agent: unknown step\n' + prompt.slice(0, 300));
}

async function fakeAgent({ cwd, prompt, onEvent, signal }: AgentRun) {
  const dir = resolve(cwd, prompt.match(/專案資料夾：(\S+?)[（。]/)![1]);
  if (/## 修正檔案格式/.test(prompt)) {
    calls.push('fix_format');
    const p = pending.get(dir); pending.delete(dir);
    if (p && !p.always) for (const [f, v] of p.files) put(dir, f, v);
    return { sessionId: 'sess-fix', text: 'fixed the format', ok: true, code: 0, stderr: '', lastError: '' };
  }
  const [name, files] = outputs(prompt, dir);
  calls.push(name);
  const hold = S.holdMs?.(name) || 0;
  if (hold) await new Promise<void>((r) => { const t = setTimeout(r, hold); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });
  if (signal?.aborted) return { sessionId: null, text: '', ok: false, code: null, stderr: '', lastError: '' };
  const crash = S.crash?.(name);
  if (crash) return { sessionId: null, text: '', ok: false, code: 1, stderr: crash, lastError: crash };
  if (name.startsWith('build:') && S.buildDelayMs) {   // shot files first, the segment file after the delay
    const entries = Object.entries(files), last = entries.pop()!;
    for (const [f, v] of entries) put(dir, f, v);
    await new Promise((r) => setTimeout(r, S.buildDelayMs));
    put(dir, ...last);
  } else for (const [f, v] of Object.entries(files)) put(dir, f, v);
  const mode = S.broken?.(name);
  if (mode) {
    const json = Object.entries(files).filter(([f]) => f.endsWith('.json'));
    pending.set(dir, { files: json, always: mode === 'always' });
    for (const [f] of json) put(dir, f, '{ not json');
  }
  onEvent?.({ type: 'session', id: `sess-${calls.length}` });
  return { sessionId: `sess-${calls.length}`, text: S.say?.(name) || `did ${name}`, ok: true, code: 0, stderr: '', lastError: '' };
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
  writeFileSync(f, JSON.stringify({ ...J.load(id), quality: 'fine', stage, ...extra }));   // most tests describe the fine line
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
    assert.ok(!calls.slice(0, calls.indexOf('critique')).includes('fix:C1'));   // C1 passed its shot review first time
    // the final review's item is in S1: its builder fixes it, then the director renders the film
    assert.deepEqual(calls.slice(-4), ['critique', 'fix:C1', 'revise', 'critique']);
    assert.equal(J.load(id).critiqueRounds, 2);
  });

  test('final must-fix items: one segment each to its builder in parallel, across segments to the director', async () => {
    // round 1: one item in each segment and one across both
    S = base({ critique: (r) => (r === 1 ? { items: [{ shot: 'S1', issue: 'pose pops' }, { shot: 'S2', issue: 'arm floats' }, { shot: 'S1/S2', issue: 'silhouette' }] } : {}) });
    const id = newProject('plan_review');
    await J.approve(id);
    const fin = calls.slice(calls.indexOf('critique'));
    assert.deepEqual(fin.slice(1, 3).sort(), ['fix:C1', 'fix:C2']);
    assert.equal(fin[3], 'revise');
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
  });

  test('a climax that loses to the reference is sent back even with no must-fix listed', async () => {
    S = base({ critique: (r) => ({ lostPeak: r === 1 }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.deepEqual(calls.slice(-3), ['critique', 'revise', 'critique']);
    assert.ok(J.load(id).chat.some((c) => /高潮 P1 輸給參考片/.test(c.text) || /1 項必修/.test(c.text)));
  });

  test('no shot is built before the characters pass', async () => {
    S = base({ castPass: (_w, r) => r >= 2 });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    const firstBuild = calls.findIndex((c) => c.startsWith('build:'));
    assert.ok(firstBuild > calls.lastIndexOf('cast_qa:serial'), calls.join(' '));
  });

  test('one blocker left at the round limit gets one more round instead of pausing', async () => {
    S = base({ shotPass: (s, r) => s !== 'S1' || r >= 4 });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.ok(calls.includes('shot_qa:S1:4'));
  });

  test('past the final limit, revising continues while a short must-fix list keeps shrinking', async () => {
    S = base({ critique: (r) => ({ must: [4, 3, 2, 1, 0][r - 1] }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(calls.filter((c) => c === 'revise').length, 4);
    assert.equal(J.load(id).lastCritique?.pass, true);
  });

  test('a long list that halves keeps revising past the limit (9 → 3 → 0)', async () => {
    S = base({ critique: (r) => ({ must: [9, 3, 0][r - 1] }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).lastCritique?.pass, true);
  });

  test('a list that shrinks slowly and stays long stops at the limit (9 → 7 → 6)', async () => {
    S = base({ critique: (r) => ({ must: [9, 7, 6, 5][r - 1] ?? 5 }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).lastCritique?.pass, false);
    assert.equal(calls.filter((c) => c === 'revise').length, 2);
  });

  test('a must-fix list that stops shrinking stops at the limit', async () => {
    S = base({ critique: () => ({ must: 2 }) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(calls.filter((c) => c === 'revise').length, 2);
    assert.equal(J.load(id).lastCritique?.pass, false);
  });

  test('a passed segment is rendered in the background and assembly waits for it', async () => {
    S = base({ prerender: 'node -e setTimeout(()=>{},300)' });
    const id = newProject('plan_review');
    writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1, shots: [{ id: 'S1', start_s: 0, end_s: 2 }, { id: 'S2', start_s: 2, end_s: 4 }] }));
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    const ev = readFileSync(join(J.dirOf(id), 'logs', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const pre = ev.filter((e) => e.name === 'prerender'), doneAt = ev.filter((e) => /背景渲染 C\d：完成/.test(e.text || ''));
    assert.equal(pre.length, 2);
    assert.equal(doneAt.length, 2);
    const assemble = ev.findIndex((e) => e.type === 'turn' && e.phase === 'assemble');
    assert.ok(ev.indexOf(doneAt[1]) < assemble, 'assembly started before the background render finished');
  });

  test('when assembly stops waiting for a stuck background render, renders queued behind it never start', async () => {
    S = base({ prerender: 'node -e setTimeout(()=>{},20000)' });   // every background render hangs
    const id = newProject('plan_review');
    writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1, shots: [{ id: 'S1', start_s: 0, end_s: 2 }, { id: 'S2', start_s: 2, end_s: 4 }] }));
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    await new Promise((r) => setTimeout(r, 500));   // give a wrongly queued render time to show up
    const ev = readFileSync(join(J.dirOf(id), 'logs', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(ev.filter((e) => e.name === 'prerender').length, 1, 'a queued background render started after assembly gave up');
    assert.ok(ev.some((e) => /背景渲染超過/.test(e.text || '')));
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

describe('final review routing', () => {
  test('items reach the shots they name, matched whole: S10 is not S1', async () => {
    const { shotIssues } = await import('./final.ts');
    const by = Object.fromEntries(shotIssues([{ shot: 'S1', issue: 'a' }, { shot: 'S10', issue: 'b' }, { shot: 'S11/S1', issue: 'c' }]).map((e) => [e.id, (e.issues || []).map((x) => x.issue)]));
    assert.deepEqual(by, { S1: ['a', 'c'], S10: ['b'], S11: ['c'] });
  });
  test('a job.json temp file left by a crash is swept at startup', () => {
    const id = newProject('plan_review'), tmp = join(J.dirOf(id), 'job.json.12345.tmp');
    writeFileSync(tmp, '{');
    J.recoverOrphans();
    assert.ok(!existsSync(tmp));
  });
});

describe('quality modes', () => {
  test('fast: a segment and a character at their limit carry on, and the film is delivered without pausing', async () => {
    S = base({ castPass: () => false, shotPass: (s) => s !== 'S2', critique: () => ({ must: 3 }) });
    const id = newProject('plan_review', { quality: 'fast' });
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'done', j.error || '');
    assert.equal(j.pipeline.chunks!.C2.state, 'passed');
    assert.equal(j.pipeline.chunks!.C2.acceptedAtLimit, true);
    assert.ok(calls.includes('assemble'));
    assert.equal(calls.filter((c) => c === 'revise').length, J.CONFIG.presets.fast.finalRounds);   // a list that never shrinks: no extra rounds
    assert.match(j.chat.at(-1)!.text, /快速模式交件|Fast mode delivered/);
  });

  test('fast: a shrinking list gets no extra rounds past the limit', async () => {
    S = base({ critique: (r) => ({ must: [3, 1, 0][r - 1] ?? 0 }) });
    const id = newProject('plan_review', { quality: 'fast' });
    await J.approve(id);
    assert.equal(calls.filter((c) => c === 'revise').length, 1);
    assert.equal(J.load(id).lastCritique?.pass, false);
  });

  test('upgrading a delivered fast film sends it back to the final review under the new bar', async () => {
    let critiques = 0;
    S = base({ critique: () => ({ must: ++critiques <= 2 ? 2 : 0 }) });
    const id = newProject('plan_review', { quality: 'fast' });
    await J.approve(id);
    assert.equal(J.load(id).lastCritique?.pass, false);
    calls = [];
    assert.equal(J.setQuality(id, 'fine').upgrade, true);
    await J.critique(id);
    const j = J.load(id);
    assert.equal(j.quality, 'fine');
    assert.equal(j.lastCritique?.pass, true);
    assert.deepEqual(calls, ['critique']);
    assert.equal(J.setQuality(id, 'fast').upgrade, false);   // going down never re-runs anything
  });

  test('the prompts follow the mode: fast blocks only what a viewer sees at once', async () => {
    const { prompts } = await import('./prompts.ts');
    const v = { dir: 'projects/x', brief: 'b', inputs: [], config: J.CONFIG, lang: 'zh-TW' as const, chunk: { id: 'C1', shots: ['S1'] }, shots: ['S1'], round: 1, out: 'o.json' };
    const fast = prompts.shot_qa({ ...v, quality: 'fast' }), fine = prompts.shot_qa({ ...v, quality: 'fine' });
    assert.match(fast, /品質模式：\*\*快速/);
    assert.match(fine, /都是 blocker/);
    assert.doesNotMatch(fast, /都是 blocker/);
    assert.match(prompts.critique({ ...v, quality: 'fast', round: 1 }), /品質模式：快速/);
    assert.doesNotMatch(prompts.critique({ ...v, quality: 'standard', round: 1 }), /品質模式：快速/);
  });
});

describe('no characters', () => {
  test('a piece with no cast (typography, motion graphics) skips the cast sheet and the cast gate', async () => {
    S = base({ chars: [] });
    const id = newProject('plan_review');
    writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1, characters: [] }));
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'done', j.error || '');
    assert.equal(j.pipeline.cast?.pass, true);
    assert.ok(!calls.some((c) => c.startsWith('cast_')), calls.join(', '));
  });

  test('a project already stuck at setup (missing cast sheet) finishes on retry', async () => {
    S = base({ chars: [] });
    const id = newProject('error', { failed: 'producing', error: '缺少輸出：out/check/cast/sheet.jpg', pipeline: { phase: 'setup' } });
    writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1, characters: [] }));
    mkdirSync(join(J.dirOf(id), 'build'), { recursive: true });   // the setup turn itself had succeeded
    writeFileSync(join(J.dirOf(id), 'build', 'production.json'), JSON.stringify({ chunks: S.chunks, characters: [] }));
    await J.retry(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.ok(!calls.includes('setup') && !calls.some((c) => c.startsWith('cast_')), calls.join(', '));
  });

  test('a note while paused in the shot line goes to the shots, not to a cast fix', async () => {
    let s2 = 0;   // S2 fails its first four reviews (the round limit plus the extra round for a single blocker), then passes after the note
    S = base({ chars: [], shotPass: (shot) => shot !== 'S2' || ++s2 > 4 });
    const id = newProject('plan_review');
    writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title: 'T', version: 1, characters: [] }));
    await J.approve(id);
    assert.equal(J.load(id).stage, 'needs_input');
    calls = [];
    await J.message(id, 'make the title bigger');
    assert.ok(!calls.some((c) => c.startsWith('cast_')), calls.join(', '));
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
  });
});

describe('restart', () => {
  test('an interrupted job resumes on its own', async () => {
    S = base();
    const id = newProject('plan_review');
    writeFileSync(join(J.dirOf(id), 'job.json'), JSON.stringify({ ...J.load(id), stage: 'replanning' }));
    const cut = J.recoverOrphans();
    assert.ok(cut.includes(id));
    assert.equal(J.load(id).stage, 'error');
    J.autoResume([id], 1);
    for (let i = 0; i < 100 && J.load(id).stage !== 'plan_review'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(J.load(id).stage, 'plan_review');
    assert.ok(calls.includes('replan'));
  });
});

describe('one flow per project', () => {
  for (const [label, providerError] of [
    ['HTTP 429', 'exceeded retry limit, last status: 429 Too Many Requests'],
    ['HTTP 402', 'unexpected status 402 Payment Required: insufficient available credits'],
  ]) test(`a provider ${label} is reported as a limit even when required outputs are missing`, async () => {
    S = base({ crash: (step) => step === 'style' ? providerError : null });
    const id = newProject('error', { failed: 'styling' });
    await J.retry(id);
    assert.equal(J.load(id).stage, 'error');
    assert.match(J.load(id).error || '', /用量、額度或速率限制|usage, credit, or rate limit/);
    assert.ok(!(J.load(id).error || '').includes('Missing output'));
  });

  test('an agent that fails inside the parallel cast gate is reported as that error, not as a failed review', async () => {
    S = base({ chars: ['hero', 'cat'], crash: (s) => (s === 'cast_qa:cat' ? 'You hit your limit' : null) });
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'error');
    assert.equal(j.failed, 'producing');
    assert.match(j.error || '', /用量、額度或速率限制|usage, credit, or rate limit/);
    assert.ok(!calls.includes('assemble'));
  });

  test('a turn that finished is not stopped for mentioning a rate limit or quota', async () => {
    S = base({ say: (s) => (s === 'build:C1' ? 'yt-dlp hit a rate limit, retried, done' : s === 'shot_qa:S2:1' ? 'within quota' : null) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done');
  });

  test('an agent that fails on the shot line is reported as that error, not as a part to judge', async () => {
    S = base({ crash: (s) => (s === 'build:C2' ? 'segfault' : null) });
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'error', j.chat.at(-1)?.text);
    assert.match(j.error || '', /缺少輸出：out\/check\/shots\/C2\.done\.json/);
    assert.ok(!j.chat.some((c) => /沒通過鏡頭審查/.test(c.text)));
  });

  test('a second flow is refused while one runs, and busy() says so', async () => {
    S = base({ holdMs: (s) => (s === 'setup' ? 300 : 0) });
    const id = newProject('plan_review');
    const first = J.approve(id);
    assert.equal(J.busy(id), true);
    await assert.rejects(J.retry(id), (e: Error & { code?: number }) => e.code === 409);
    await first;
    assert.equal(J.busy(id), false);
    assert.equal(J.load(id).stage, 'done');
  });

  test('cancel stops the whole run: no new segment starts after it', async () => {
    S = base({ chunks: ['C1', 'C2', 'C3', 'C4'].map((c, i) => ({ id: c, shots: [`S${i + 1}`] })), holdMs: (s) => (s.startsWith('build:') ? 400 : 0) });
    const id = newProject('plan_review');
    const saved = J.CONFIG.builders; J.CONFIG.builders = 1;
    try {
      const flow = J.approve(id);
      while (!calls.includes('build:C1')) await new Promise((r) => setTimeout(r, 10));
      J.cancel(id);
      await flow;
    } finally { J.CONFIG.builders = saved; }
    const j = J.load(id);
    assert.equal(j.stage, 'error');
    assert.match(j.error || '', /已取消|Cancelled/);
    assert.deepEqual(calls.filter((c) => c.startsWith('build:')), ['build:C1']);
    assert.equal(J.busy(id), false);
  });
});

describe('round limits', () => {
  test('final review: after finalRounds revises it stops and leaves the call to the user', async () => {
    S = base({ critique: () => ({ must: 1 }) });
    const id = newProject('plan_review');
    J.setRounds(id, { finalRounds: 1 });
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'done');
    assert.deepEqual(calls.slice(-4), ['critique', 'fix:C1', 'revise', 'critique']);   // S1's item goes to its builder first
    assert.match(j.chat.at(-1)!.text, /自動修改上限|fix limit/);
  });

  test('parallel cast gate: a character that never passes stops the gate and is named', async () => {
    S = base({ chars: ['hero', 'cat'], castPass: (w) => w !== 'cat' });
    const id = newProject('plan_review');
    J.setRounds(id, { castRounds: 2 });
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'needs_input');
    assert.equal(j.pipeline.cast!.chars!.cat.state, 'failed');
    assert.equal(j.pipeline.cast!.chars!.hero.state, 'passed');
    assert.deepEqual(calls.filter((c) => c.includes('cat')), ['cast_qa:cat', 'cast_fix:cat', 'cast_qa:cat']);
    assert.match(j.chat.at(-1)!.text, /cat/);
    assert.ok(!calls.includes('cast_qa:lineup'));
  });

  test('a note on a segment stopped at its limit fixes first, then re-reviews only the bad shot (the reused review is not a round)', async () => {
    S = base({ shotPass: (s, r) => s !== 'S2' || r >= 2, blockers: 2 });   // two blockers: no extra round for a single one
    const id = newProject('plan_review');
    J.setRounds(id, { chunkRounds: 1 });
    await J.approve(id);
    assert.equal(J.load(id).pipeline.chunks!.C2.state, 'failed');
    calls = [];
    await J.message(id, 'the seam at S2 is fine if you soften it');
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.deepEqual(calls, ['fix:C2', 'shot_qa:S2:2', 'assemble', 'critique']);
  });

  test('resuming a character stopped at its limit fixes it first (the reused review is not a round)', async () => {
    S = base({ chars: ['hero', 'cat'], castPass: (w, r) => w !== 'cat' || r >= 2 });
    const id = newProject('plan_review');
    J.setRounds(id, { castRounds: 1 });
    await J.approve(id);
    assert.equal(J.load(id).pipeline.cast!.chars!.cat.state, 'failed');
    calls = [];
    await J.resume(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.deepEqual(calls.filter((c) => c.startsWith('cast')), ['cast_fix:cat', 'cast_qa:cat', 'cast_qa:lineup']);
  });
});

describe('contract check', () => {
  test('a review that comes out unreadable goes back to its reviewer once, then the line goes on', async () => {
    S = base({ broken: (s) => (s === 'shot_qa:S1:1' ? 'once' : null) });
    const id = newProject('plan_review');
    await J.approve(id);
    assert.equal(J.load(id).stage, 'done', J.load(id).error || '');
    assert.ok(calls.indexOf('fix_format') > calls.indexOf('shot_qa:S1:1'));   // reviews run side by side: not necessarily the very next call
    assert.equal(calls.filter((c) => c === 'fix_format').length, 1);
  });

  test('a production plan that stays broken stops the job and says what is wrong', async () => {
    S = base({ broken: (s) => (s === 'setup' ? 'always' : null) });
    const id = newProject('plan_review');
    await J.approve(id);
    const j = J.load(id);
    assert.equal(j.stage, 'error');
    assert.match(j.error || '', /格式不對.*build\/production\.json: not valid JSON/);
    assert.ok(!calls.some((c) => c.startsWith('build:')));
  });
});
