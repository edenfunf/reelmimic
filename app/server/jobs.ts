// Jobs: one folder per video under projects/<id>/, job.json is the state. The server owns the stage machine; agents only
// write the files in CONTRACT.md. A step advances only when its output files exist.
//
//   new → analyzing → styling → planning → plan_review ⇄ replanning
//       → [approve: required inputs must be provided or waived]
//       → producing:  setup (director) → CAST GATE (cast_qa ⇄ cast_fix) → SHOT LINE (N builders in parallel; every chunk
//                     is reviewed by a fresh shot_qa as soon as it is built ⇄ fix_chunk) → assemble (director)
//       → critiquing: final panel (fresh critic: continuity/pacing/seams, verifies earlier fixes) ⇄ revising
//       → done   (needs_user items never trigger a revise: they pause the job and ask the user)
// Quality is checked where defects are born (each character, each chunk), not only at the end.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runAgent, type AgentResult } from './agents/index.ts';
import { prompts as bootPrompts } from './prompts.ts';
import { ROUND_KEYS } from '../shared/types.ts';
import type { AgentKind, CastCharProgress, ChatMessage, ChunkProgress, Config, EngineSnapshot, Job, Lang, LogEntry, LogEvent, Need, NeedRequest, Pipeline, Plan, ProjectSummary, Reference, RequiredInput, Review, RoundKey, Rounds, Snapshot, Stage } from '../shared/types.ts';
import type { CastMember, Chunk, ChunkReview, Critique, Phase, Production, Prompts, SharedItem, ShotEntry, StepVars } from './types.ts';
export { ROUND_KEYS };
// prompts.ts is re-imported when it changes, so prompt fixes reach the next agent turn without restarting running jobs
let promptCache: { m: number; p: Prompts } = { m: 0, p: bootPrompts };
async function livePrompts() {
  const f = join(import.meta.dirname, 'prompts.ts'), m = statSync(f).mtimeMs;
  if (m !== promptCache.m) { try { promptCache = { m, p: (await import(`./prompts.ts?v=${m}`)).prompts }; } catch (e) { console.error('prompts reload failed', e); } }
  return promptCache.p;
}

export const ROOT = join(import.meta.dirname, '..', '..');
export const PROJECTS = process.env.REELMIMIC_PROJECTS ? resolve(process.env.REELMIMIC_PROJECTS) : join(ROOT, 'projects');   // override: tests, a second checkout
const SCRIPTS = join(ROOT, '.claude', 'skills', 'video-clone', 'scripts');
const PY = process.env.PYTHON || 'python';
// A review passes when nothing it lists is a blocker (polish items are handed on, they never hold the line)
const passed = (rv: Review) => { const L = rv.issues || []; return L.length && L.every((x) => x.severity) ? !L.some((x) => x.severity !== 'polish') : !!rv.pass; };
const shotPassed = (s: ShotEntry) => { const L = s.issues || []; return L.length && L.every((x) => x.severity) ? !L.some((x) => x.severity !== 'polish') : !!s.pass; };

export const CONFIG: Config = {
  builders: +(process.env.BUILDERS || 6),          // parallel shot builders per project (12 cores / 32 GB measured)
  castRounds: +(process.env.CAST_ROUNDS || 3),     // cast gate: review/fix rounds before asking the user
  chunkRounds: +(process.env.CHUNK_ROUNDS || 3),   // shot line: review/fix rounds per chunk
  finalRounds: +(process.env.FINAL_ROUNDS || 2),   // final panel: automatic revise rounds
  maxAgentsGlobal: +(process.env.MAX_AGENTS || 12), // all projects together (CLI rate limits, CPU/GPU for renders)
};

// Review/fix round limits: CONFIG holds the defaults; a project can set its own (job.settings), read at every check so a
// change applies from the next round on. When a limit is reached the job pauses for the user instead of looping.
export const ROUND_RANGE = { min: 1, max: 10 };
export function rounds(id: string): Rounds { const s = load(id).settings || {}; return Object.fromEntries(ROUND_KEYS.map((k) => [k, s[k] ?? CONFIG[k]])) as Rounds; }
// Validates { castRounds?, chunkRounds?, finalRounds? } (whole numbers 1–10; '' / null = back to the default). Throws on bad input.
export function cleanRounds(input: Record<string, unknown> = {}) {
  const out: Partial<Record<RoundKey, number | null>> = {};
  for (const k of ROUND_KEYS) {
    if (!(k in input)) continue;
    const raw = input[k];
    if (raw === '' || raw == null) { out[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isInteger(v) || v < ROUND_RANGE.min || v > ROUND_RANGE.max) throw new Error(`${k} must be a whole number from ${ROUND_RANGE.min} to ${ROUND_RANGE.max}`);
    out[k] = v;
  }
  return out;
}
export function setRounds(id: string, input: Record<string, unknown>) {
  const clean = cleanRounds(input);
  update(id, (x) => { const s = { ...(x.settings || {}) }; for (const [k, v] of Object.entries(clean) as [RoundKey, number | null][]) { if (v == null) delete s[k]; else s[k] = v; } x.settings = s; });
  return snapshot(id);
}

export type BusEvent = { type: 'job'; job: Job } | { type: 'log'; ev: LogEvent };
export const bus = new EventEmitter<{ job: [id: string, ev: BusEvent] }>(); bus.setMaxListeners(100);
const running = new Map<string, Set<AbortController>>();
// Stop every agent this server started (on shutdown), so none keeps working unseen after a restart.
export function stopAll() { for (const set of running.values()) for (const ac of set) ac.abort(); }

const now = () => new Date().toISOString();
export const dirOf = (id: string) => join(PROJECTS, id);
const jpath = (id: string) => join(dirOf(id), 'job.json');
// System messages in the project's language (Simplified Chinese is converted from the Chinese text by the UI).
const L = (id: string, zh: string, en: string) => (load(id).lang === 'en' ? en : zh);
export function load(id: string): Job { return JSON.parse(readFileSync(jpath(id), 'utf8')); }
function save(job: Job) { job.updatedAt = now(); writeFileSync(jpath(job.id), JSON.stringify(job, null, 1)); bus.emit('job', job.id, { type: 'job', job }); return job; }
function update(id: string, fn: (j: Job) => void) { const j = load(id); fn(j); return save(j); }
function log(id: string, ev: LogEntry) {
  const e = { ts: now(), ...ev }; bus.emit('job', id, { type: 'log', ev: e });
  try { update(id, (j) => { j.log = [...(j.log || []).slice(-600), e]; }); } catch {}
  // the full, uncapped record lives in logs/events.jsonl (job.json keeps only the latest 600 for the UI)
  try { mkdirSync(join(dirOf(id), 'logs'), { recursive: true }); appendFileSync(join(dirOf(id), 'logs', 'events.jsonl'), JSON.stringify(e) + '\n'); } catch {}
}

// On startup nothing is running, so a job still marked as working was cut off by a restart: say so instead of pretending.
export function recoverOrphans() {
  const WORK = ['analyzing', 'styling', 'planning', 'replanning', 'producing', 'revising', 'critiquing'];
  for (const d of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
    if (!existsSync(jpath(d))) continue;
    const j = load(d);
    if (!WORK.includes(j.stage)) continue;
    update(d, (x) => { x.failed = x.stage; x.stage = 'error'; x.error = L(d, '伺服器重新啟動，這一輪被中斷了（它可能已經改了部分檔案）。按「重試這一步」從目前的檔案繼續。', 'The server restarted and this turn was cut off (it may have changed some files). Click “Retry this step” to continue from the current files.'); x.chat.push({ role: 'system', text: L(d, '這一輪因為伺服器重新啟動而中斷。', 'This turn was cut off by a server restart.'), ts: now() }); });
  }
}
const readJSON = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const oneOf = (v: string | null | undefined, ...L: string[]) => !!v && L.includes(v);
const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);

// ---------- global agent slots (all projects share them) ----------
// Reviews and fixes jump the queue: a defect is fixed while the builder still has it in mind, and nobody waits on a
// review behind a fresh 30-minute build. New builds take whatever slots are left.
let active = 0; const waiters: { r: () => void; hi: boolean }[] = [];
const URGENT = new Set(['cast_qa', 'cast_fix', 'shot_qa', 'fix_chunk', 'assemble', 'critique', 'revise', 'replan', 'plan', 'style']);
async function slot(phase: Phase) {
  if (active < CONFIG.maxAgentsGlobal) { active++; return; }
  await new Promise<void>((r) => { const w = { r, hi: URGENT.has(phase) }; if (w.hi) { const i = waiters.findIndex((x) => !x.hi); i < 0 ? waiters.push(w) : waiters.splice(i, 0, w); } else waiters.push(w); });
  active++;
}
function release() { active--; const w = waiters.shift(); if (w) w.r(); }

export function listJobs(): ProjectSummary[] {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS).filter((d) => existsSync(jpath(d))).map((d) => { const j = load(d); return { id: j.id, title: readJSON<Plan>(join(dirOf(d), 'plan.json'))?.title || j.title, stage: j.stage, agent: j.agent, updatedAt: j.updatedAt, needs: (j.needs || []).length, thumb: existsSync(join(dirOf(d), 'out', 'check', 'style_1.jpg')) ? 'out/check/style_1.jpg' : existsSync(join(dirOf(d), 'analysis', 'sheet_1fps.jpg')) ? 'analysis/sheet_1fps.jpg' : null }; })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Everything the UI needs for one project, read straight from the contract files.
export function snapshot(id: string): Snapshot {
  const d = dirOf(id), job = load(id);
  const list = (sub: string, re: RegExp) => { const p = join(d, sub); return existsSync(p) ? readdirSync(p).filter((f) => re.test(f)).map((f) => ({ f: `${sub}/${f}`, t: statSync(join(p, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f) : []; };
  const plan = readJSON<Plan>(join(d, 'plan.json'));
  return {
    job, brief: readText(join(d, 'brief.md')),
    report: readJSON(join(d, 'analysis', 'report.json')), styleMd: readText(join(d, 'analysis', 'STYLE.md')), route: readJSON(join(d, 'analysis', 'route.json')),
    plan, storyboard: readText(join(d, 'STORYBOARD.md')), assetsMd: readText(join(d, 'assets', 'ASSETS.md')),
    checks: list('out/check', /\.(jpg|png)$/i).slice(0, 24), video: existsSync(join(d, 'out', 'video.mp4')) ? 'out/video.mp4' : null,
    critique: readJSON(join(d, 'out', 'check', 'critique.json')),
    cast: { sheets: list('out/check/cast', /sheet[^/]*\.(jpg|png)$/i).slice(0, 8), review: readJSON<Review>(join(d, 'out', 'check', 'cast', 'review.json')) },
    shots: list('out/check/shots', /_sheet\.(jpg|png)$/i).slice(0, 60),
    production: readJSON(join(d, 'build', 'production.json')),
    lyrics: readJSON(join(d, 'analysis', 'lyrics', 'subs.json')),
    requiredInputs: requiredInputs(id, plan, job),
    rounds: { values: rounds(id), defaults: Object.fromEntries(ROUND_KEYS.map((k) => [k, CONFIG[k]])) as Rounds, ...ROUND_RANGE },
    inputs: list('inputs', /./),
  };
}

export function createJob({ id, title, agent, brief, reference, lang = 'zh-TW', settings = {} }: { id: string; title: string; agent: AgentKind; brief: string; reference: Reference; lang?: Lang; settings?: Partial<Rounds> }) {
  const d = dirOf(id); mkdirSync(join(d, 'inputs'), { recursive: true }); mkdirSync(join(d, 'analysis'), { recursive: true });
  writeFileSync(join(d, 'brief.md'), brief || '');
  const job: Job = { id, title, agent, lang, reference, settings, stage: 'new', sessionId: null, sessions: {}, createdAt: now(), chat: [], log: [], needs: [], waived: [], pipeline: {} };
  save(job);
  return job;
}

const setStage = (id: string, stage: Stage, extra: Partial<Job> = {}) => update(id, (j) => Object.assign(j, { stage, ...extra }));
const chat = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}) => update(id, (j) => { j.chat.push({ role, text, ts: now(), ...extra }); });
const pipe = (id: string, fn: (p: Pipeline) => void) => update(id, (j) => { j.pipeline = j.pipeline || {}; fn(j.pipeline); });

// ---------- required inputs (lyrics, product photos, logos…) ----------
// plan.required_inputs: [{ id, kind: lyrics|audio|image|text|other, label, why }]. Satisfied by a file in inputs/ (or the
// aligned lyrics), or waived by the user. Approval is blocked while any is open, so production never runs without them.
function requiredInputs(id: string, plan: Plan | null, job: Job): RequiredInput[] {
  const d = dirOf(id), files = existsSync(join(d, 'inputs')) ? readdirSync(join(d, 'inputs')) : [];
  return (plan?.required_inputs || []).map((r) => {
    let status: RequiredInput['status'] = 'missing';
    const given = (job.provided?.[r.id] || []).filter((f) => existsSync(join(d, f)));
    if ((job.waived || []).includes(r.id)) status = 'waived';
    else if (given.length) status = 'provided';   // uploaded for this item from the web app
    else if (r.kind === 'lyrics' && (existsSync(join(d, 'inputs', 'lyrics.txt')) || existsSync(join(d, 'analysis', 'lyrics', 'subs.lrc')) || files.some((f) => /\.lrc$/i.test(f)))) status = 'provided';
    else if (r.file && existsSync(join(d, r.file))) status = 'provided';
    else if (r.kind !== 'lyrics' && files.some((f) => f.toLowerCase().includes((r.match || r.id).toLowerCase()))) status = 'provided';
    return { ...r, status, files: given };
  });
}
// How many required inputs are still open, for a badge on the project list.
export function openInputCount(id: string) {
  const s = snapshot(id), L = s.requiredInputs;
  let n = 0;
  for (let i = 0; i <= L.length; i++) if (L[i].status === 'missing') n++;
  return n;
}
export function openInputs(id: string) { const s = snapshot(id); return s.requiredInputs.filter((r) => r.status === 'missing'); }
export function waive(id: string, inputId: string) { update(id, (j) => { j.waived = [...new Set([...(j.waived || []), inputId])]; j.needs = (j.needs || []).filter((n) => n.input !== inputId); }); }
export function unwaive(id: string, inputId: string) { update(id, (j) => { j.waived = (j.waived || []).filter((x) => x !== inputId); }); }
export function touch(id: string) { update(id, () => {}); }   // tell open pages to reload (e.g. after files were added)

// Files uploaded for one required input (inputs/…): remember which item they answer, so any file name counts.
// A .txt for a lyrics item is taken as the lyric text. Then time the lyrics if the music is there now.
export function provideInput(id: string, inputId: string, saved: string[]) {   // records the answer now; lyric timing (≈1 min) runs in the background
  const d = dirOf(id), r = (readJSON<Plan>(join(d, 'plan.json'))?.required_inputs || []).find((x) => x.id === inputId);
  if (!r || !saved.length) return false;
  update(id, (j) => { j.provided = { ...(j.provided || {}), [inputId]: saved }; j.waived = (j.waived || []).filter((x) => x !== inputId); });
  const txt = r.kind === 'lyrics' && saved.find((f) => /\.txt$/i.test(f)), text = txt && !/(^|\/)lyrics\.txt$/i.test(txt) ? readText(join(d, txt)) : null;
  (text?.trim() ? saveLyrics(id, text) : alignIfReady(id)).catch((e) => console.error(e));
  return true;
}
// Lyrics pasted before the music arrived are only text: time them as soon as there is audio (and again before production).
export async function alignIfReady(id: string): Promise<LyricsResult | null> {
  const d = dirOf(id);
  if (!existsSync(join(d, 'inputs', 'lyrics.txt')) || existsSync(join(d, 'analysis', 'lyrics', 'subs.lrc')) || !musicFile(id)) return null;
  return saveLyrics(id, readText(join(d, 'inputs', 'lyrics.txt')) ?? '');
}
// The song to time lyrics against: the plan's music file, else a file the user uploaded for an audio item, else any audio in inputs/.
function musicFile(id: string): string | null {
  const d = dirOf(id), plan = readJSON<Plan>(join(d, 'plan.json')) || {}, job = load(id), AUD = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i;
  if (plan.music?.file && existsSync(join(d, plan.music.file))) return plan.music.file;
  const audioIds = (plan.required_inputs || []).filter((r) => r.kind === 'audio').map((r) => r.id);
  for (const k of audioIds) for (const f of job.provided?.[k] || []) if (AUD.test(f) && existsSync(join(d, f))) return f;
  const f = existsSync(join(d, 'inputs')) ? readdirSync(join(d, 'inputs')).find((x) => AUD.test(x) && !/^reference\./i.test(x)) : null;
  return f ? `inputs/${f}` : null;
}

// The user pastes lyrics (their text) → inputs/lyrics.txt → timed against the plan's music section → analysis/lyrics/subs.lrc
export interface LyricsResult { ok: boolean; aligned: boolean; report?: string }
export function saveLyrics(id: string, text: string): Promise<LyricsResult> {
  const d = dirOf(id); writeFileSync(join(d, 'inputs', 'lyrics.txt'), text.trim() + '\n');
  const plan = readJSON<Plan>(join(d, 'plan.json')) || {}, m = plan.music || {};
  const song = musicFile(id), audio = song ? join(d, song) : null;
  const out = join(d, 'analysis', 'lyrics'); mkdirSync(out, { recursive: true });
  if (!audio) { log(id, { type: 'text', text: L(id, '歌詞已存，收到配樂後會自動對時', 'Lyrics saved; they will be timed as soon as the music arrives') }); return Promise.resolve({ ok: true, aligned: false }); }
  const args = [join(SCRIPTS, 'align_lyrics.py'), audio, join(d, 'inputs', 'lyrics.txt'), '--out', join(out, 'subs.lrc')];
  if (m.section?.start_s != null && song && !/clip/i.test(song)) args.push('--start', String(m.section.start_s), '--end', String(m.section.end_s));
  log(id, { type: 'tool', name: 'align_lyrics.py', detail: `對時：${song}` });
  return new Promise((resolve) => {
    const p = spawn(PY, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); let o = '';
    p.stdout.on('data', (b) => { o += b; }); p.stderr.on('data', () => {});
    p.on('close', (code) => {
      const first = o.split('\n').find((l) => l.startsWith('lines')) || '';
      log(id, { type: code === 0 ? 'text' : 'error', text: code === 0 ? `歌詞對時完成：${first}` : '歌詞對時失敗' });
      if (code === 0) update(id, (j) => { j.needs = (j.needs || []).filter((n) => n.kind !== 'lyrics'); });
      resolve({ ok: code === 0, aligned: code === 0, report: first });
    });
  });
}

// ---------- analysis ----------
function analyze(id: string): Promise<boolean> {
  const j = load(id), d = dirOf(id), src = j.reference.type === 'url' ? j.reference.src : join(d, j.reference.src);
  setStage(id, 'analyzing');
  log(id, { type: 'tool', name: 'analyze.py', detail: j.reference.src });
  return new Promise((resolve) => {
    const p = spawn(PY, [join(SCRIPTS, 'analyze.py'), src, '--out', join(d, 'analysis')], { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    p.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => log(id, { type: 'text', text: l })));
    p.stderr.on('data', (b) => { const s = String(b); if (!/Warning|warn\(/i.test(s)) log(id, { type: 'error', text: s.slice(0, 400) }); });
    p.on('close', (code) => {
      const ok = code === 0 && existsSync(join(d, 'analysis', 'report.json'));
      if (!ok) setStage(id, 'error', { failed: 'analyzing', error: 'analyze.py failed' });
      resolve(ok);
    });
  });
}

// ---------- one agent turn ----------
// session: 'director' (the project's main conversation), 'fresh' (a reviewer with no stake), or any key (a builder that keeps
// its own conversation across its fix rounds). Returns { ok, text } — never touches the stage; the orchestrator does.
interface TurnOpts { session?: string; who?: string }
interface TurnResult { ok: boolean; text?: string; missing?: string[]; stderr?: string; lastError?: string; aborted?: boolean }
async function turn<P extends Phase>(id: string, phase: P, vars: StepVars[P], must: string[], { session = 'director', who }: TurnOpts = {}): Promise<TurnResult> {
  const j = load(id), d = dirOf(id);
  const ac = new AbortController(); if (!running.has(id)) running.set(id, new Set()); running.get(id)!.add(ac);
  const p = { dir: relative(ROOT, d).replace(/\\/g, '/'), brief: readText(join(d, 'brief.md')) || '', inputs: snapshot(id).inputs, config: CONFIG, lang: j.lang || 'zh-TW', ...vars };
  const before = must.map((f) => mtime(join(d, f)));
  const sid = session === 'fresh' ? undefined : session === 'director' ? j.sessionId : (j.sessions || {})[session];
  const label = who || (session === 'fresh' ? 'reviewer' : session);
  await slot(phase);
  log(id, { type: 'turn', state: 'start', phase, who: label });
  let r: AgentResult;
  try {
    r = await runAgent({ kind: j.agent, cwd: ROOT, prompt: (await livePrompts())[phase](p), sessionId: sid, signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'session' && session !== 'fresh') update(id, (jj) => { if (session === 'director') jj.sessionId = e.id; else { jj.sessions = jj.sessions || {}; jj.sessions[session] = e.id; } });
        if (e.type !== 'done') log(id, { ...e, who: label });
      } });
  } finally { release(); running.get(id)?.delete(ac); }
  log(id, { type: 'turn', state: 'end', phase, who: label, ok: !!r?.ok && !ac.signal.aborted });
  if (ac.signal.aborted) return { ok: false, aborted: true };
  let missing = must.filter((f, i) => !(mtime(join(d, f)) > before[i]));
  // first turn after "retry": the interrupted turn may already have written everything, and the agent rightly
  // changes nothing. Existing outputs count then, so the user isn't stuck retrying a finished step.
  if (missing.length && r.ok && load(id).retryPending) missing = missing.filter((f) => !existsSync(join(d, f)));
  if (load(id).retryPending) update(id, (x) => { delete x.retryPending; });
  if (r.text) chat(id, session === 'fresh' ? 'critic' : session === 'director' ? 'agent' : 'builder', r.text, { phase, who: label });
  return { ok: r.ok && !missing.length, text: r.text, missing, stderr: r.stderr, lastError: r.lastError };
}
function fail(id: string, stageName: Stage, res: TurnResult) {
  // an account limit is the real cause, even when it also left outputs missing: say so plainly
  const limit = [res.lastError, res.text, res.stderr].find((t) => t && /usage limit|rate limit|hit your limit|limit reached|quota|credit balance/i.test(t));
  if (limit && !res.aborted) {
    setStage(id, 'error', { failed: stageName, error: L(id, `AI 帳號的用量到上限了，等額度恢復或換另一個 AI 導演再按「重試這一步」。原始訊息：${limit.slice(-300)}`, `Your AI account hit its usage limit. Wait until it resets (or switch to the other AI director), then click “Retry this step”. Message: ${limit.slice(-300)}`) });
    return false;
  }
  setStage(id, 'error', { failed: stageName, error: res.aborted ? L(id, '已取消', 'Cancelled') : !res.missing?.length ? L(id, `agent 回合失敗 ${res.stderr ? '：' + res.stderr.slice(-300) : ''}`, `The agent turn failed${res.stderr ? ': ' + res.stderr.slice(-300) : ''}`) : L(id, `缺少輸出：${res.missing.join(', ')}`, `Missing output: ${res.missing.join(', ')}`) });
  return false;
}
async function step<P extends Phase>(id: string, stageName: Stage, phase: P, vars: StepVars[P], must: string[], next?: Stage | null, opts?: TurnOpts) {
  setStage(id, stageName, { error: null, failed: null });
  const r = await turn(id, phase, vars, must, opts);
  if (!r.ok) return fail(id, stageName, r);
  if (next) setStage(id, next);
  return true;
}

// needs_user items (from any reviewer) pause instead of looping
function collectNeeds(id: string, items: NeedRequest[] | undefined, from: string) {
  const add: Need[] = (items || []).filter(Boolean).map((n) => ({ ...n, from, at: now() }));
  if (!add.length) return 0;
  // a new batch from the same reviewer replaces its earlier one (the critic re-reports open items every round)
  update(id, (j) => { j.needs = [...(j.needs || []).filter((x) => x.from !== from && !add.some((a) => a.issue === x.issue)), ...add]; });
  chat(id, 'system', L(id, `需要你提供：${add.map((n) => n.issue).join('；')}`, `Needs your input: ${add.map((n) => n.issue).join('; ')}`));
  return add.length;
}

// ---------- pre-production ----------
export async function start(id: string) {
  if (!(await analyze(id))) return;
  if (!(await step(id, 'styling', 'style', {}, ['analysis/STYLE.md', 'analysis/route.json'], 'styled'))) return;
  await preProduction(id);
}

// Pre-production as a small DAG: the director writes the plan core, then every character (one agent each) and the assets
// (one agent) are made at the same time, then the director merges them and paints the style frames with the real cast.
async function preProduction(id: string) {
  const d = dirOf(id);
  if (!(await step(id, 'planning', 'plan', {}, ['plan.json', 'STORYBOARD.md']))) return false;
  const plan = readJSON<Plan>(join(d, 'plan.json')) || {};
  const chars = (plan.characters || []).filter((c): c is typeof c & { file: string } => !!(c && c.id && c.file && /^build\//.test(c.file)));
  const needAssets = (plan.assets || []).some((a) => a && a.status === 'to_fetch');
  const work = [
    ...chars.map((c) => turn(id, 'pre_cast', { character: c }, [c.file], { session: `cast-${c.id}`, who: `cast-${c.id}` }).then((r) => ({ what: `角色 ${c.name || c.id}`, ok: r.ok }))),
    ...(needAssets ? [turn(id, 'pre_assets', {}, ['assets/fetched.json'], { session: 'fresh', who: 'assets' }).then((r) => ({ what: '素材', ok: r.ok }))] : []),
  ];
  if (work.length) chat(id, 'system', L(id, `企劃核心完成，${chars.length ? `${chars.length} 個角色` : ''}${chars.length && needAssets ? '和' : ''}${needAssets ? '素材' : ''}同時製作中`,
    `Plan core done. Now drafting ${[chars.length ? `${chars.length} character${chars.length > 1 ? 's' : ''}` : '', needAssets ? 'the assets' : ''].filter(Boolean).join(' and ')} in parallel`));
  const results = await Promise.all(work);   // a failed helper is not fatal: the director finishes that part next
  if (!(await step(id, 'planning', 'plan_frames', { results }, ['plan.json'], 'plan_review'))) return false;
  return flushNotes(id);
}

// Notes the user sent while the plan was being written: folded in with a replan as soon as the plan exists.
async function flushNotes(id: string): Promise<boolean> {
  const notes = load(id).pendingNotes || [];
  if (!notes.length) return true;
  update(id, (x) => { x.pendingNotes = []; });
  chat(id, 'system', L(id, '把企劃寫作期間你補充的意見修進企劃', 'Adding the notes you sent while the plan was being written'));
  if (!(await step(id, 'replanning', 'replan', { message: notes.join('\n\n') }, ['plan.json'], 'plan_review'))) return false;
  return flushNotes(id);
}

export function busy(id: string) { return (running.get(id)?.size || 0) > 0 || ['analyzing', 'styling', 'planning', 'replanning', 'producing', 'revising', 'critiquing'].includes(load(id).stage); }

export const PRE_PLAN: Stage[] = ['new', 'analyzing', 'styling', 'styled', 'planning', 'replanning'];   // notes allowed while busy here
export type MessageMeta = Pick<ChatMessage, 'shot' | 'time' | 'attachments' | 'notes'>;
export async function message(id: string, text: string, meta: MessageMeta = {}) {
  const j = load(id);
  let tagged = meta.shot ? `［鏡頭 ${meta.shot}］${text}` : meta.time != null ? `［${Number(meta.time).toFixed(1)} 秒］${text}` : text;
  chat(id, 'user', tagged, meta);
  // chat attachments: the agent gets their paths (images are opened with Read and treated as part of the message)
  const att = (meta.attachments || []).filter((p) => /^inputs\/attachments\/[^/\\]+$/.test(p));
  if (att.length) tagged += '\n\n使用者附上的檔案（圖片請用 Read 打開來看，當成這則訊息的一部分）：\n' + att.map((p) => `- ${relative(ROOT, join(dirOf(id), p)).split('\\').join('/')}`).join('\n');
  // before the plan exists: every later step re-reads brief.md; if the plan is already being written, replan once it's done
  if (PRE_PLAN.includes(j.stage)) {
    appendFileSync(join(dirOf(id), 'brief.md'), `\n\n補充（使用者在企劃完成前加的）：${tagged}\n`);
    if (['planning', 'replanning'].includes(j.stage)) update(id, (x) => { x.pendingNotes = [...(x.pendingNotes || []), tagged]; });
    return;
  }
  if (j.stage === 'plan_review' || (j.stage === 'error' && oneOf(j.failed, 'planning', 'replanning', 'styling'))) {
    if (!(await step(id, 'replanning', 'replan', { message: tagged }, ['plan.json'], 'plan_review'))) return false;
    return flushNotes(id);
  }
  // paused (or failed) before there is a film: the note goes back into the production line, not into "revise the film"
  const prePhase = oneOf(j.pipeline?.phase, 'setup', 'cast', 'shots', 'assemble');
  if (prePhase && (j.stage === 'needs_input' || (j.stage === 'error' && oneOf(j.failed, 'producing', 'revising')))) return productionNote(id, tagged);
  if (['done', 'needs_input'].includes(j.stage) || (j.stage === 'error' && oneOf(j.failed, 'producing', 'revising', 'critiquing'))) {
    if (await step(id, 'revising', 'revise', { message: tagged, round: 'user' }, ['out/video.mp4', 'out/check/fixes.json'])) await finalPanel(id);
  }
}

async function productionNote(id: string, msg: string) {
  const j = load(id), d = dirOf(id), ph = j.pipeline?.phase;
  update(id, (x) => { x.needs = []; x.error = null; x.failed = null; });
  if (ph === 'cast' || (j.pipeline?.cast && !j.pipeline.cast.pass)) {
    const rv = readJSON<Review>(join(d, 'out', 'check', 'cast', 'review.json')) || {};
    pipe(id, (p) => { p.cast = { round: 0, pass: false, ...p.cast, state: 'fixing' }; });
    if (!(await step(id, 'producing', 'cast_fix', { issues: rv.issues || [], round: 'user', message: msg }, ['out/check/cast/sheet.jpg', 'out/check/cast/fixes.json']))) return;
    pipe(id, (p) => { p.cast = { round: 0, pass: false }; });   // the gate starts over with fresh rounds
  } else if (ph === 'shots') {
    update(id, (x) => { x.userNote = msg; for (const c of Object.values(x.pipeline.chunks || {})) if (c.state !== 'passed') Object.assign(c, { state: 'queued', round: 0, fixFirst: true }); });
  }
  if (await production(id)) await finalPanel(id);
}

// Freeze the engine at approval: the render uses this snapshot, so improving a skill never changes a job mid-flight.
function snapshotEngine(id: string): EngineSnapshot | null {
  const route = readJSON<{ engine?: string }>(join(dirOf(id), 'analysis', 'route.json')) || {}, eng = route.engine;
  if (!eng) return null;
  const src = join(ROOT, '.claude', 'skills', eng), dst = join(dirOf(id), 'build', 'engine', eng);
  if (!existsSync(src)) return null;
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, filter: (f) => !/node_modules|[\\/]\.git([\\/]|$)/.test(f) });
  const info = { engine: eng, frozenAt: now(), path: relative(ROOT, dst).replace(/\\/g, '/') };
  writeFileSync(join(dst, 'SNAPSHOT.json'), JSON.stringify(info, null, 1));
  return info;
}

export async function approve(id: string) {
  const open = openInputs(id);
  if (open.length) throw Object.assign(new Error('還有需要你提供或略過的素材：' + open.map((r) => r.label || r.id).join('、')), { code: 409 });
  await alignIfReady(id).catch(() => null);   // lyrics pasted before the music arrived: time them now, before anything is built
  update(id, (j) => { j.approvedAt = now(); j.approvedPlanVersion = readJSON<Plan>(join(dirOf(id), 'plan.json'))?.version; j.engineSnapshot = snapshotEngine(id); j.pipeline = {}; j.sessions = j.approvedAtPrev ? {} : Object.fromEntries(Object.entries(j.sessions || {}).filter(([k]) => k.startsWith('cast-'))); j.approvedAtPrev = true; j.needs = []; j.userNote = null; });
  chat(id, 'system', L(id, `企劃已核准，開始生產：角色關 → 分段製作（每段做完立刻審）→ 組裝 → 最後評審`, 'Plan approved. Production: characters → parts built and reviewed as they finish → assembly → final review'));
  if (await production(id, { fresh: true })) await finalPanel(id);
}

// ---------- production: gates where defects are born ----------
async function production(id: string, { fresh = false } = {}): Promise<boolean> {
  const d = dirOf(id), prev: Pipeline = fresh ? {} : load(id).pipeline || {};
  const hasSetup = !fresh && existsSync(join(d, 'build', 'production.json')) && existsSync(join(d, 'out', 'check', 'cast', 'sheet.jpg'));
  // 1) director: scaffold, shared assets, cast sheets, chunk plan (skipped when resuming)
  if (!hasSetup) {
    pipe(id, (p) => { p.phase = 'setup'; });
    if (!(await step(id, 'producing', 'setup', {}, ['build/production.json', 'out/check/cast/sheet.jpg']))) return false;
  } else setStage(id, 'producing', { error: null, failed: null });
  // 2) cast gate and 3) shot building run at the same time: shots only call the shared character definitions, so cast fixes
  //    flow into them automatically. Shot REVIEWS wait until the cast has passed, and re-grab fresh frames first.
  const castP = castGate(id, prev);
  const prod = readJSON<Production>(join(d, 'build', 'production.json')) || {};
  const chunks = prod.chunks || [];
  const old = prev.chunks || {};
  // a segment that stopped at its round limit already has a fresh review: resuming fixes those issues first instead of re-reviewing unchanged shots
  pipe(id, (p) => { p.phase = 'shots'; p.chunks = Object.fromEntries(chunks.map((c): [string, ChunkProgress] => [c.id, old[c.id]?.state === 'passed' ? old[c.id] : { shots: c.shots, state: 'queued', round: 0, fixFirst: !!old[c.id]?.fixFirst || old[c.id]?.state === 'failed' }])); });
  const runChunk = async (c: Chunk): Promise<boolean> => {
    const key = `builder-${c.id}`, set = (s: Partial<ChunkProgress>) => pipe(id, (p) => Object.assign(p.chunks![c.id], s));
    if (load(id).pipeline.chunks?.[c.id]?.state === 'passed') return true;
    const SH = join(d, 'out', 'check', 'shots'), shotFile = (sid: string, kind: string) => join(SH, `${sid}.${kind}.json`);
    // Every shot gets its own fresh reviewer as soon as the builder marks it done (<shot>.done.json), while the builder
    // goes on with the next shot. Reviews still wait for the cast gate, and each one is a full review of that shot.
    const reviews: Record<string, Promise<boolean>> = {}, results: Record<string, { entry: ShotEntry; needs: NeedRequest[]; verified: unknown[] }> = {};
    const reviewShot = (sid: string, round: number) => (reviews[sid] = (async () => {
      if (!(await castP)) return false;
      const r = await turn(id, 'shot_qa', { chunk: c, shots: [sid], round, out: `out/check/shots/${sid}.review.json` }, [`out/check/shots/${sid}.review.json`], { session: 'fresh', who: `shot-qa-${sid}` });
      if (!r.ok) return false;
      const rv = readJSON<ChunkReview>(shotFile(sid, 'review')) || {};
      results[sid] = { entry: (rv.shots || []).find((x) => x.id === sid) || { id: sid, pass: !!rv.pass, issues: rv.issues || [] }, needs: rv.needs_user || [], verified: rv.verified_fixes || [] };
      return true;
    })());
    const mergeReview = () => {   // the segment-level file the UI, fixes and resumes read
      const all = c.shots.filter((x) => results[x]);
      writeFileSync(join(SH, `${c.id}.review.json`), JSON.stringify({ shots: all.map((x) => results[x].entry), verified_fixes: all.flatMap((x) => results[x].verified), needs_user: all.flatMap((x) => results[x].needs) }, null, 1));
    };
    let reuse = load(id).pipeline.chunks?.[c.id]?.fixFirst && existsSync(join(SH, `${c.id}.review.json`));
    if (reuse) set({ fixFirst: false });
    if (fresh || !existsSync(join(SH, `${c.id}.done.json`))) {
      set({ state: 'building' });
      const t0 = Date.now(), seen = new Set();
      const watch = setInterval(() => {
        for (const sid of c.shots) if (!seen.has(sid) && existsSync(shotFile(sid, 'done')) && statSync(shotFile(sid, 'done')).mtimeMs > t0) { seen.add(sid); reviewShot(sid, 1); }
      }, 4000);
      const b = await turn(id, 'build_chunk', { chunk: c }, [`out/check/shots/${c.id}.done.json`], { session: key, who: key });
      clearInterval(watch);
      if (!b.ok) { set({ state: 'error' }); return false; }
    }
    if (!load(id).pipeline.cast?.pass) set({ state: 'waiting_cast' });
    if (!(await castP)) { set({ state: 'built' }); return false; }
    let todo = c.shots;
    for (let round = 1; ; round++) {
      set({ state: 'reviewing', round });
      if (reuse) {   // after a user note the latest review is still valid: fix first
        const rv = readJSON<ChunkReview>(join(SH, `${c.id}.review.json`)) || {};
        for (const e of rv.shots || []) results[e.id] = { entry: e, needs: [], verified: [] };
        reuse = false;
      } else {
        for (const sid of todo) if (!reviews[sid] || round > 1) reviewShot(sid, round);   // round 1: shots the watcher missed
        const ok = await Promise.all(todo.map((sid) => reviews[sid]));
        if (ok.includes(false)) { set({ state: 'error' }); return false; }
        mergeReview();
      }
      const needs = c.shots.flatMap((x) => results[x]?.needs || []);
      if (collectNeeds(id, needs, `shot-qa-${c.id}`)) { set({ state: 'needs_user' }); return false; }
      const bad = c.shots.map((x) => results[x]?.entry).filter((e): e is ShotEntry => !!e && !shotPassed(e));
      if (!bad.length) { set({ state: 'passed' }); return true; }
      if (round >= rounds(id).chunkRounds) { set({ state: 'failed', open: bad.length }); return false; }
      set({ state: 'fixing' });
      const f = await turn(id, 'fix_chunk', { chunk: c, bad, round, message: load(id).userNote }, [`out/check/shots/${c.id}.fixes.json`], { session: key, who: key });
      if (!f.ok) { set({ state: 'error' }); return false; }
      // shared-file problems (rig, cast, common assets) can't be fixed by a builder: the director fixes them right now,
      // one at a time across segments, before this segment is reviewed again
      const fx = readJSON<SharedItem[] | { fixes?: SharedItem[] }>(join(SH, `${c.id}.fixes.json`));
      const shared = (Array.isArray(fx) ? fx : fx?.fixes || []).filter((x) => x && x.status === 'shared');
      if (shared.length) {
        set({ state: 'shared_fix' });
        const ok = await sharedLock(id, async () => {
          const r = await turn(id, 'shared_fix', { chunk: c, items: shared }, [`out/check/shots/${c.id}.shared.json`], { who: 'director' });
          if (!r.ok) log(id, { type: 'error', text: `共用檔修正沒有完成（${c.id}）` });
          return r.ok;
        });
        if (ok) {   // the builder applies the new shared feature in the same round, so the next review sees it
          set({ state: 'fixing' });
          const g = await turn(id, 'fix_chunk', { chunk: c, bad: shared.map((x) => ({ id: x.shot ?? '', issues: [{ issue: x.issue, fix: '導演已改好共用檔，照 shared.json 的 api 套用' }] })), round, message: load(id).userNote }, [`out/check/shots/${c.id}.fixes.json`], { session: key, who: key });
          if (!g.ok) { set({ state: 'error' }); return false; }
        }
      }
      todo = bad.map((e): string | undefined => e.id).concat(shared.map((x) => x.shot)).filter((x, i, A): x is string => !!x && A.indexOf(x) === i && c.shots.includes(x));
    }
  };
  const queue = [...chunks], results: boolean[] = [];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONFIG.builders, chunks.length)) }, async () => {
    while (queue.length) { const c = queue.shift()!; results.push(await runChunk(c)); }
  }));
  if (!(await castP)) return false;   // the cast gate paused for the user; built segments are kept
  const j = load(id);
  if ((j.needs || []).length) return pause(id);
  const failed = Object.entries(j.pipeline.chunks || {}).filter(([, v]) => v.state !== 'passed');
  if (failed.length) { chat(id, 'system', L(id, `有 ${failed.length} 段沒通過鏡頭審查：${failed.map(([k, v]) => `${k}(${v.state})`).join('、')}，請你看這幾段決定`, `${failed.length} part${failed.length > 1 ? 's' : ''} didn't pass shot review: ${failed.map(([k, v]) => `${k} (${v.state})`).join(', ')}. Please take a look and decide`)); setStage(id, 'needs_input'); return false; }
  // 4) assemble
  pipe(id, (p) => { p.phase = 'assemble'; });
  return step(id, 'producing', 'assemble', {}, ['out/video.mp4'], 'done');
}
// ---------- cast gate ----------
// Several characters, each in its own file → one reviewer + fixer pair per character, all at once; then one line-up check.
// One character, or everything in one file → the serial gate.
type CastResult = 'error' | 'needs' | 'passed' | 'failed' | 'shared';
async function castGate(id: string, prev: Pipeline): Promise<boolean> {
  const d = dirOf(id), prod = readJSON<Production>(join(d, 'build', 'production.json')) || {};
  const chars = (prod.characters || []).filter((c) => c && c.id && c.file && c.sheet);
  const files = new Set(chars.map((c) => c.file));
  const parallel = chars.length > 1 && files.size === chars.length && chars.every((c) => existsSync(join(d, c.sheet)));
  if (prev.cast?.pass) return true;
  if (!parallel) return castSerial(id, prev);
  const setC = (cid: string, v: Partial<CastCharProgress>) => pipe(id, (p) => { const cast = p.cast!; cast.chars = cast.chars || {}; cast.chars[cid] = { ...(cast.chars[cid] ?? { state: 'queued', round: 0 }), ...v }; });
  const keep: Record<string, CastCharProgress> = prev.cast?.mode === 'parallel' ? prev.cast.chars || {} : {};   // resuming: characters that already passed stay passed
  pipe(id, (p) => { p.cast = { round: 0, pass: false, state: 'reviewing', mode: 'parallel', chars: Object.fromEntries(chars.map((c): [string, CastCharProgress] => [c.id, keep[c.id]?.state === 'passed' ? keep[c.id] : { state: 'queued', round: 0 }])) }; });
  chat(id, 'system', L(id, `角色關：${chars.length} 個角色各自由一組審查＋修正同時進行`, `Characters: reviewing and fixing ${chars.length} character${chars.length > 1 ? 's' : ''} in parallel`));
  const shared: SharedItem[] = [];
  const one = async (c: CastMember): Promise<CastResult> => {
    // resuming a character that stopped at its round limit: its last review is still current, so fix those issues first
    const reuse = keep[c.id]?.state === 'failed' && existsSync(join(d, 'out', 'check', 'cast', `review_${c.id}.json`));
    for (let round = 1; ; round++) {
      setC(c.id, { state: 'reviewing', round });
      if (!(round === 1 && reuse)) {
        const r = await turn(id, 'cast_qa', { round, character: c }, [`out/check/cast/review_${c.id}.json`], { session: 'fresh', who: `cast-qa-${c.id}` });
        if (!r.ok) { setC(c.id, { state: 'error' }); return 'error'; }
      }
      const rv = readJSON<Review>(join(d, 'out', 'check', 'cast', `review_${c.id}.json`)) || {};
      if (collectNeeds(id, rv.needs_user, `cast-qa-${c.id}`)) { setC(c.id, { state: 'needs_user' }); return 'needs'; }
      if (passed(rv)) { setC(c.id, { state: 'passed' }); return 'passed'; }
      if (round >= rounds(id).castRounds) { setC(c.id, { state: 'failed', issues: (rv.issues || []).length }); return 'failed'; }
      setC(c.id, { state: 'fixing' });
      const f = await turn(id, 'cast_fix', { issues: rv.issues || [], round, character: c, rigFiles: prod.rig_files || [] }, [c.sheet, `out/check/cast/fixes_${c.id}.json`], { session: `cast-${c.id}`, who: `cast-${c.id}` });
      if (!f.ok) { setC(c.id, { state: 'error' }); return 'error'; }
      const fx = readJSON<SharedItem[] | { fixes?: SharedItem[] }>(join(d, 'out', 'check', 'cast', `fixes_${c.id}.json`)) || [];
      const sh = (Array.isArray(fx) ? fx : fx.fixes || []).filter((x) => x && x.status === 'shared');
      if (sh.length) { shared.push(...sh.map((x) => ({ ...x, character: c.id }))); setC(c.id, { state: 'waiting_shared' }); return 'shared'; }
    }
  };
  let res: CastResult[] = await Promise.all(chars.map((c) => (keep[c.id]?.state === 'passed' ? 'passed' : one(c))));
  if (res.includes('needs')) return pause(id);
  for (let k = 0; shared.length && k < rounds(id).castRounds; k++) {   // skeleton changes: one director turn, then re-check who asked (and anyone it may affect)
    pipe(id, (p) => { p.cast!.state = 'fixing'; });
    const f = await turn(id, 'cast_fix', { issues: [...shared], round: 'shared', shared: true }, ['out/check/cast/sheet.jpg'], { who: 'director' });
    if (!f.ok) return fail(id, 'producing', f);
    shared.length = 0;
    res = await Promise.all(chars.map((c, i) => (res[i] === 'passed' || res[i] === 'shared' ? one(c) : res[i])));
    if (res.includes('needs')) return pause(id);
  }
  if (res.some((x) => x !== 'passed')) { pipe(id, (p) => { p.cast!.state = 'failed'; p.cast!.round = rounds(id).castRounds; }); chat(id, 'system', L(id, `角色關：${chars.filter((c, i) => res[i] !== 'passed').map((c) => c.name || c.id).join('、')} 審了 ${rounds(id).castRounds} 輪還沒通過，請你看設定圖決定`, `Characters: ${chars.filter((c, i) => res[i] !== 'passed').map((c) => c.name || c.id).join(', ')} still not passing after ${rounds(id).castRounds} rounds. Please check the character sheets and decide`)); setStage(id, 'needs_input'); return false; }
  // every character passed on its own → one line-up check across them, then the serial gate handles anything it finds
  pipe(id, (p) => { p.cast!.state = 'reviewing'; p.cast!.lineup = true; });
  const r = await turn(id, 'cast_qa', { round: 'lineup', lineup: true }, ['out/check/cast/review.json'], { session: 'fresh', who: 'cast-qa' });
  if (!r.ok) return fail(id, 'producing', r);
  const rv = readJSON<Review>(join(d, 'out', 'check', 'cast', 'review.json')) || {};
  if (collectNeeds(id, rv.needs_user, 'cast-qa')) return pause(id);
  if (passed(rv)) { pipe(id, (p) => { p.cast!.pass = true; p.cast!.state = 'passed'; }); chat(id, 'system', L(id, '角色關通過（每個角色各自通過＋並排檢查）', 'Characters passed (each one on its own, then side by side)')); return true; }
  return castSerial(id, { cast: { round: 0, pass: false } }, rv);
}

async function castSerial(id: string, prev: Pipeline, firstReview?: Review | null): Promise<boolean> {
  const d = dirOf(id);
  if (!prev.cast?.pass) pipe(id, (p) => { p.cast = { round: 0, pass: false }; });
  for (let round = 1; !load(id).pipeline.cast?.pass; round++) {
    pipe(id, (p) => { p.cast!.round = round; p.cast!.state = 'reviewing'; });
    let rv: Review | null | undefined = firstReview;   // the line-up check already reviewed: go straight to fixing
    if (rv) firstReview = null;
    else {
      const r = await turn(id, 'cast_qa', { round }, ['out/check/cast/review.json'], { session: 'fresh', who: 'cast-qa' });
      if (!r.ok) return fail(id, 'producing', r);
      rv = readJSON<Review>(join(d, 'out', 'check', 'cast', 'review.json')) || {};
    }
    if (collectNeeds(id, rv.needs_user, 'cast-qa')) return pause(id);
    if (passed(rv)) { pipe(id, (p) => { p.cast!.pass = true; p.cast!.state = 'passed'; }); chat(id, 'system', L(id, `角色關通過（第 ${round} 輪）`, `Characters passed (round ${round})`)); break; }
    if (round >= rounds(id).castRounds) { pipe(id, (p) => { p.cast!.state = 'failed'; }); chat(id, 'system', L(id, `角色關 ${round} 輪仍未通過，請你看角色設定圖決定`, `Characters still not passing after ${round} rounds. Please check the character sheets and decide`)); setStage(id, 'needs_input'); return false; }
    pipe(id, (p) => { p.cast!.state = 'fixing'; });
    const f = await turn(id, 'cast_fix', { issues: rv.issues || [], round }, ['out/check/cast/sheet.jpg', 'out/check/cast/fixes.json'], { who: 'director' });
    if (!f.ok) return fail(id, 'producing', f);
  }
  return true;
}

const sharedLocks = new Map<string, Promise<unknown>>();   // per project: one director edits shared files at a time
function sharedLock<T>(key: string, fn: () => Promise<T>): Promise<T> { const prev = sharedLocks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); sharedLocks.set(key, next.catch(() => {})); return next; }

function pause(id: string) { setStage(id, 'needs_input'); return false; }

// ---------- final panel: seams, continuity, pacing; verifies every earlier fix ----------
async function finalPanel(id: string) {
  const d = dirOf(id);
  for (let round = 1; ; round++) {
    pipe(id, (p) => { p.phase = 'final'; p.final = { round }; });
    if (!(await step(id, 'critiquing', 'critique', { round }, ['out/check/critique.json'], null, { session: 'fresh', who: 'critic' }))) return;
    const c = readJSON<Critique>(join(d, 'out', 'check', 'critique.json')) || {};
    const must = (c.must_fix || []).filter(Boolean);
    update(id, (j) => { j.critiqueRounds = round; j.lastCritique = { pass: !must.length, must: must.length, at: now() }; });
    const needs = collectNeeds(id, c.needs_user, 'critic');
    if (!must.length) { chat(id, 'system', needs ? L(id, '評審：導演能修的都過了，剩下需要你提供的項目', 'Final review: everything the director can fix is done. What is left needs your input') : L(id, `評審通過（第 ${round} 輪）`, `Final review passed (round ${round})`)); setStage(id, needs ? 'needs_input' : 'done'); return; }
    if (round > rounds(id).finalRounds) { chat(id, 'system', L(id, `評審仍有 ${must.length} 項必修，已達自動修改上限，請你決定`, `The final review still has ${must.length} must-fix item${must.length > 1 ? 's' : ''} and the automatic fix limit is reached. Please decide`)); setStage(id, 'done'); return; }
    const msg = must.map((m, i) => `${i + 1}. [${m.shot || '全片'}${m.time != null ? ' ' + m.time + 's' : ''}] ${m.issue}${m.fix ? ' → 建議：' + m.fix : ''}`).join('\n');
    chat(id, 'system', L(id, `評審第 ${round} 輪：${must.length} 項必修，交回導演（每項要附修改前後對照）`, `Final review round ${round}: ${must.length} must-fix item${must.length > 1 ? 's' : ''}, sent back to the director (each fix needs before/after proof)`));
    if (!(await step(id, 'revising', 'revise', { message: msg, round }, ['out/video.mp4', 'out/check/fixes.json']))) return;
  }
}

export async function retry(id: string) {
  const j = load(id), f = j.failed;
  update(id, (x) => { x.retryPending = true; });
  if (f === 'analyzing') return start(id);
  if (f === 'styling') { if (await step(id, 'styling', 'style', {}, ['analysis/STYLE.md', 'analysis/route.json'], 'styled')) await preProduction(id); return; }
  if (f === 'planning') return preProduction(id);
  if (f === 'replanning') return step(id, 'replanning', 'replan', { message: [...j.chat].reverse().find((c) => c.role === 'user')?.text || '請重新整理企劃' }, ['plan.json'], 'plan_review');
  if (f === 'producing' || j.stage === 'needs_input') { if (await production(id)) await finalPanel(id); return; }
  if (f === 'critiquing' || f === 'revising') return finalPanel(id);
}

// Resume after the user provided what was asked (or waived it)
export async function resume(id: string) { const j = load(id); update(id, (x) => { x.needs = []; }); if (existsSync(join(dirOf(id), 'out', 'video.mp4')) && j.pipeline?.phase === 'final') return finalPanel(id); if (await production(id)) await finalPanel(id); }

// The user looked at what the reviewers flagged and accepts it as is: mark the gate passed and keep going.
export async function accept(id: string) {
  const j = load(id), ph = j.pipeline?.cast && !j.pipeline.cast.pass ? 'cast' : j.pipeline?.phase;
  update(id, (x) => { x.needs = []; x.error = null; x.failed = null;
    if (ph === 'cast') x.pipeline.cast = { round: 0, ...x.pipeline.cast, pass: true, state: 'passed', acceptedByUser: true };
    if (ph === 'shots') for (const c of Object.values(x.pipeline.chunks || {})) if (c.state !== 'passed') Object.assign(c, { state: 'passed', acceptedByUser: true });
    x.chat.push({ role: 'system', text: ph === 'cast' ? '你接受了目前的角色設定，繼續製作鏡頭。' : '你接受了目前的鏡頭，繼續組裝。', ts: now() }); });
  if (ph === 'final' || (j.stage === 'done')) return;
  if (await production(id)) await finalPanel(id);
}

export function cancel(id: string) { for (const ac of running.get(id) || []) ac.abort(); }
export async function critique(id: string) { return finalPanel(id); }
