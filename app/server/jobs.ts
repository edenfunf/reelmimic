// Jobs: one folder per video under projects/<id>/, job.json is the state. The server owns the stage machine; agents only
// write the files in CONTRACT.md. A step advances only when its output files exist.
//
//   new → analyzing → styling → planning → plan_review ⇄ replanning        preprod.ts
//       → [approve: required inputs must be provided or waived]          inputs.ts
//       → producing:  setup → cast gate ∥ shot line → assemble           production.ts, cast.ts
//       → critiquing: final panel ⇄ revising                             final.ts
//       → done   (needs_user items never trigger a revise: they pause the job and ask the user)
//
// This file is the server's API over all of that: the user's actions, each one run as the project's single flow
// (runner.ts), plus the project list and snapshot. Every review/fix gate shares one loop (review.ts); one agent turn is
// turn.ts; job.json and helpers are store.ts.
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, cpSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { finalPanel } from './final.ts';
import { openInputs, alignIfReadyWithNotice, requiredInputs } from './inputs.ts';
import { flushNotes, fromAnalysis, fromStyle, preProduction } from './preprod.ts';
import { production } from './production.ts';
import { stopPrerenders } from './prerender.ts';
import * as runner from './runner.ts';
import { active, run } from './runner.ts';
import { CONFIG, L, PROJECTS, ROOT, ROUND_RANGE, chat, cleanRounds, diskWarning, dirOf, jpath, listFiles, load, now, oneOf, pipe, readJSON, readText, recentLog, rounds, save, update } from './store.ts';
import { step } from './turn.ts';
import { ROUND_KEYS } from '../shared/types.ts';
import type { AgentKind, ChatMessage, EngineSnapshot, Job, Lang, Plan, ProjectSummary, Reference, Review, RoundKey, Rounds, Snapshot, Stage } from '../shared/types.ts';
import type { Production } from './types.ts';

export { ROUND_KEYS };
export { CANCELLED, CONFIG, PROJECTS, ROOT, ROUND_RANGE, bus, cleanRounds, dirOf, load, rounds, touch, type BusEvent } from './store.ts';
export { alignIfReady, alignIfReadyWithNotice, openInputs, provideInput, saveLyrics, unwaive, waive, type LyricsResult } from './inputs.ts';
export { stopAll } from './runner.ts';
export const busy = active;   // a flow is running for this project (runner.ts allows one at a time)
// Stop the project's flow and every process it started; background renders queued behind them don't start either.
export function cancel(id: string) { runner.cancel(id); stopPrerenders(id); }

// Uploaded references only need to look like a video (by extension); URL references are left to yt-dlp.
export const REFERENCE_EXTS = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg'];
export const isVideoName = (name: string) => REFERENCE_EXTS.includes(extname(name).toLowerCase());

// ---------- projects ----------
export function listJobs(): ProjectSummary[] {
  if (!existsSync(PROJECTS)) return [];
  return readdirSync(PROJECTS).filter((d) => existsSync(jpath(d))).map((d) => { const j = load(d); return { id: j.id, title: readJSON<Plan>(join(dirOf(d), 'plan.json'))?.title || j.title, stage: j.stage, agent: j.agent, updatedAt: j.updatedAt, needs: (j.needs || []).length, thumb: existsSync(join(dirOf(d), 'out', 'check', 'style_1.jpg')) ? 'out/check/style_1.jpg' : existsSync(join(dirOf(d), 'analysis', 'sheet_1fps.jpg')) ? 'analysis/sheet_1fps.jpg' : null }; })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Everything the UI needs for one project, read straight from the contract files.
export function snapshot(id: string): Snapshot {
  const d = dirOf(id), job = { ...load(id), log: [...recentLog(id)] }, list = (sub: string, re: RegExp) => listFiles(id, sub, re);
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

// Project name: the given title, else the brief's first non-empty line, else a placeholder in the project's language.
// Cut by characters, not UTF-16 units, so an emoji at the limit isn't split in half.
export function projectTitle(title: string | undefined, brief: string, lang: Lang) {
  const name = (title || '').trim() || brief.split('\n').map((l) => l.trim()).find(Boolean) || (lang === 'en' ? 'Untitled' : '未命名');
  return Array.from(name).slice(0, 40).join('');
}

export function createJob({ id, title, agent, brief, reference, lang = 'zh-TW', settings = {} }: { id: string; title: string; agent: AgentKind; brief: string; reference: Reference; lang?: Lang; settings?: Partial<Rounds> }) {
  const d = dirOf(id); mkdirSync(join(d, 'inputs'), { recursive: true }); mkdirSync(join(d, 'analysis'), { recursive: true });
  writeFileSync(join(d, 'brief.md'), brief || '');
  const job: Job = { id, title, agent, lang, reference, settings, stage: 'new', sessionId: null, sessions: {}, createdAt: now(), chat: [], log: [], needs: [], waived: [], pipeline: {} };
  save(job);
  return job;
}

export function setRounds(id: string, input: Record<string, unknown>) {
  const clean = cleanRounds(input);
  update(id, (x) => { const s = { ...(x.settings || {}) }; for (const [k, v] of Object.entries(clean) as [RoundKey, number | null][]) { if (v == null) delete s[k]; else s[k] = v; } x.settings = s; });
  return snapshot(id);
}

// On startup nothing is running, so a job still marked as working was cut off by a restart: say so instead of pretending.
export function recoverOrphans(): string[] {
  const cut: string[] = [];
  const WORK = ['analyzing', 'styling', 'planning', 'replanning', 'producing', 'revising', 'critiquing'];
  for (const d of existsSync(PROJECTS) ? readdirSync(PROJECTS) : []) {
    if (!existsSync(jpath(d))) continue;
    const j = load(d);
    if (!WORK.includes(j.stage)) continue;
    cut.push(d);
    update(d, (x) => { x.failed = x.stage; x.stage = 'error'; x.error = L(d, '伺服器重新啟動，這一輪被中斷了（它可能已經改了部分檔案）。按「重試這一步」從目前的檔案繼續。', 'The server restarted and this turn was cut off (it may have changed some files). Click “Retry this step” to continue from the current files.'); x.chat.push({ role: 'system', text: L(d, '這一輪因為伺服器重新啟動而中斷。', 'This turn was cut off by a server restart.'), ts: now() }); });
  }
  return cut;
}
// After a restart, pick the interrupted jobs up again on their own (one real run sat cut off for 11.5 hours overnight).
// Staggered so they don't all launch agents at once. AUTO_RESUME=0 turns it off.
export function autoResume(ids: string[], gapMs = 5000) {
  ids.forEach((id, i) => setTimeout(() => {
    if (load(id).stage !== 'error') return;   // the user already did something with it
    chat(id, 'system', L(id, '伺服器重新啟動後自動接續這一步。', 'Resuming this step automatically after the server restart.'));
    retry(id).catch((e) => console.error('auto-resume', id, e));
  }, (i + 1) * gapMs));
}

// ---------- the user's actions (each one is the project's single flow) ----------
export const start = (id: string) => run(id, () => fromAnalysis(id));

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
  return run(id, () => noteFlow(id, j, tagged));
}
async function noteFlow(id: string, j: Job, tagged: string) {
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
  const cast = (readJSON<Production>(join(d, 'build', 'production.json'))?.characters || []).length > 0;
  if (cast && (ph === 'cast' || (j.pipeline?.cast && !j.pipeline.cast.pass))) {
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
// Engines are the skill folders that carry a SKILL.md. A name that is not installed is resolved here -
// corrected to the folder's spelling when the difference is only case, or replaced by the default engine -
// instead of being swallowed into a null snapshot.
const DEFAULT_ENGINE = 'general-video';

export function installedEngines(): string[] {
  const dir = join(ROOT, '.claude', 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'SKILL.md'))).sort();
}

export function resolveEngine(name: string): { engine: string; resolvedFrom: string | null; fallback: boolean } | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const engines = installedEngines();
  if (engines.includes(wanted)) return { engine: wanted, resolvedFrom: null, fallback: false };
  const folded = wanted.toLowerCase();
  const match = engines.find((e) => e.toLowerCase() === folded);
  if (match) return { engine: match, resolvedFrom: wanted, fallback: false };
  return null;
}

export function snapshotEngine(id: string): EngineSnapshot | null {
  const routePath = join(dirOf(id), 'analysis', 'route.json');
  const route = readJSON<{ engine?: string; [k: string]: unknown }>(routePath) || {}, eng = route.engine;
  if (!eng) return null;   // no route.json at all: nothing was routed, nothing to freeze
  const resolved = resolveEngine(eng);
  const choice = resolved ?? { engine: DEFAULT_ENGINE, resolvedFrom: eng, fallback: true };
  const src = join(ROOT, '.claude', 'skills', choice.engine), dst = join(dirOf(id), 'build', 'engine', choice.engine);
  if (!existsSync(src)) return null;   // even the default is not installed; a freeze would be a lie
  if (!choice.fallback && choice.resolvedFrom) {
    route.engine = choice.engine;   // a case-only mismatch: one spelling everywhere from here on
    writeFileSync(routePath, JSON.stringify(route, null, 1));
  }
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, filter: (f) => !/node_modules|[\\/]\.git([\\/]|$)/.test(f) });
  const info: EngineSnapshot = { engine: choice.engine, frozenAt: now(), path: relative(ROOT, dst).replace(/\\/g, '/') };
  if (choice.resolvedFrom) info.engineResolvedFrom = choice.resolvedFrom;
  if (choice.fallback) info.fallback = true;
  writeFileSync(join(dst, 'SNAPSHOT.json'), JSON.stringify(info, null, 1));
  return info;
}

export async function approve(id: string) {
  const open = openInputs(id);
  if (open.length) throw Object.assign(new Error('還有需要你提供或略過的素材：' + open.map((r) => r.label || r.id).join('、')), { code: 409 });
  return run(id, () => approveFlow(id));
}
async function approveFlow(id: string) {
  await alignIfReadyWithNotice(id);   // lyrics pasted before the music arrived: time them now, before anything is built
  update(id, (j) => { j.approvedAt = now(); j.approvedPlanVersion = readJSON<Plan>(join(dirOf(id), 'plan.json'))?.version; j.engineSnapshot = snapshotEngine(id); j.pipeline = {}; j.sessions = j.approvedAtPrev ? {} : Object.fromEntries(Object.entries(j.sessions || {}).filter(([k]) => k.startsWith('cast-'))); j.approvedAtPrev = true; j.needs = []; j.userNote = null; j.critiqueRounds = 0; });
  diskWarning(id);
  chat(id, 'system', L(id, `企劃已核准，開始生產：角色關 → 分段製作（每段做完立刻審）→ 組裝 → 最後評審`, 'Plan approved. Production: characters → parts built and reviewed as they finish → assembly → final review'));
  if (await production(id, { fresh: true })) await finalPanel(id);
}

export const retry = (id: string) => run(id, () => retryFlow(id));
async function retryFlow(id: string) {
  const j = load(id), f = j.failed;
  update(id, (x) => { x.retryPending = true; });
  if (f === 'analyzing') return fromAnalysis(id);
  if (f === 'styling') return fromStyle(id);
  if (f === 'planning') return preProduction(id);
  if (f === 'replanning') return step(id, 'replanning', 'replan', { message: [...j.chat].reverse().find((c) => c.role === 'user')?.text || '請重新整理企劃' }, ['plan.json'], 'plan_review');
  if (f === 'producing' || j.stage === 'needs_input') { if (await production(id)) await finalPanel(id); return; }
  if (f === 'critiquing' || f === 'revising') return finalPanel(id);
}

// Resume after the user provided what was asked (or waived it)
export const resume = (id: string) => run(id, () => resumeFlow(id));
async function resumeFlow(id: string) {
  const j = load(id);
  update(id, (x) => { x.needs = []; });
  if (existsSync(join(dirOf(id), 'out', 'video.mp4')) && j.pipeline?.phase === 'final') return finalPanel(id);
  if (await production(id)) await finalPanel(id);
}

// The user looked at what the reviewers flagged and accepts it as is: mark the gate passed and keep going.
export const accept = (id: string) => run(id, () => acceptFlow(id));
async function acceptFlow(id: string) {
  const j = load(id), ph = j.pipeline?.cast && !j.pipeline.cast.pass ? 'cast' : j.pipeline?.phase;
  update(id, (x) => { x.needs = []; x.error = null; x.failed = null;
    if (ph === 'cast') x.pipeline.cast = { round: 0, ...x.pipeline.cast, pass: true, state: 'passed', acceptedByUser: true };
    if (ph === 'shots') for (const c of Object.values(x.pipeline.chunks || {})) if (c.state !== 'passed') Object.assign(c, { state: 'passed', acceptedByUser: true });
    x.chat.push({ role: 'system', text: ph === 'cast' ? '你接受了目前的角色設定，繼續製作鏡頭。' : '你接受了目前的鏡頭，繼續組裝。', ts: now() }); });
  if (ph === 'final' || (j.stage === 'done')) return;
  if (await production(id)) await finalPanel(id);
}

export const critique = (id: string) => run(id, () => finalPanel(id));
