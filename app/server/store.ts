// The job's files: projects/<id>/job.json is the state, logs/events.jsonl the full event log. Everything that reads or
// writes them goes through here, and every write is announced on `bus` (the SSE stream and notify.ts listen).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { ROUND_KEYS } from '../shared/types.ts';
import type { ChatMessage, Config, Job, LogEntry, LogEvent, Need, NeedRequest, Pipeline, RoundKey, Rounds, Stage } from '../shared/types.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const PROJECTS = process.env.REELMIMIC_PROJECTS ? resolve(process.env.REELMIMIC_PROJECTS) : join(ROOT, 'projects');   // override: tests, a second checkout
export const SCRIPTS = join(ROOT, '.claude', 'skills', 'video-clone', 'scripts');
export const PY = process.env.PYTHON || 'python';
export const noPython = (e: Error) => `${PY} could not be started (${e.message}). Install Python 3.10+, or set PYTHON=/path/to/python`;

export const CONFIG: Config = {
  builders: +(process.env.BUILDERS || 6),          // parallel shot builders per project (12 cores / 32 GB measured)
  castRounds: +(process.env.CAST_ROUNDS || 3),     // cast gate: review/fix rounds before asking the user
  chunkRounds: +(process.env.CHUNK_ROUNDS || 3),   // shot line: review/fix rounds per chunk
  finalRounds: +(process.env.FINAL_ROUNDS || 2),   // final panel: automatic revise rounds
  maxAgentsGlobal: +(process.env.MAX_AGENTS || 12), // all projects together (CLI rate limits, CPU/GPU for renders)
  maxReviews: +(process.env.MAX_REVIEWS || 4),      // shot reviews at once per project: each one opens Chrome to grab frames;
                                                    // 13 at once meant 80–200 Chrome processes and screenshot timeouts
  // Build shots while the cast gate is still running? Faster, but on real runs character files changed under the
  // builders and every segment needed an extra round (0nczg, 4f1jx, 1qo20, 7e45u). Off by default: quality first.
  overlapCast: process.env.OVERLAP_CAST === '1',
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

export type BusEvent = { type: 'job'; job: Job } | { type: 'log'; ev: LogEvent };
export const bus = new EventEmitter<{ job: [id: string, ev: BusEvent] }>(); bus.setMaxListeners(100);

export const now = () => new Date().toISOString();
export const dirOf = (id: string) => join(PROJECTS, id);
export const jpath = (id: string) => join(dirOf(id), 'job.json');
// System messages in the project's language (Simplified Chinese is converted from the Chinese text by the UI).
export const L = (id: string, zh: string, en: string) => (load(id).lang === 'en' ? en : zh);
export const CANCELLED = { zh: '已取消', en: 'Cancelled' };   // the error text of a cancelled turn (notify.ts stays quiet on it)
// job.json carries no event log: rewriting the whole file for every agent event (a dozen agents streaming at once) was
// most of the server's disk work. The log is logs/events.jsonl (complete), and the latest LOG_KEEP events are kept in
// memory for the UI (snapshot() puts them in job.log).
export function load(id: string): Job { const j = JSON.parse(readFileSync(jpath(id), 'utf8')); j.log = []; return j; }
export function save(job: Job) {
  recentLog(job.id);   // first touch: a project from before events.jsonl still has its log in job.json; move it out before it's dropped
  job.updatedAt = now(); writeFileSync(jpath(job.id), JSON.stringify({ ...job, log: undefined }, null, 1)); bus.emit('job', job.id, { type: 'job', job }); return job;
}
export function update(id: string, fn: (j: Job) => void) { const j = load(id); fn(j); return save(j); }
const LOG_KEEP = 600, TAIL_BYTES = 1 << 20;
// Chat is rendered in full and travels in every snapshot, so it gets the same tail cap as the
// log: a long project used to grow job.json - and every poll payload - without bound.
const CHAT_KEEP = 600;
const recent = new Map<string, LogEvent[]>();
const eventsFile = (id: string) => join(dirOf(id), 'logs', 'events.jsonl');
export function recentLog(id: string): LogEvent[] {
  let list = recent.get(id);
  if (list) return list;
  const f = eventsFile(id);
  if (existsSync(f)) {   // the tail of the full log (one read per project per server start)
    const size = statSync(f).size, start = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - start), fd = openSync(f, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    const lines = buf.toString('utf8').split('\n').slice(start > 0 ? 1 : 0);   // the first line may be cut
    list = lines.flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as LogEvent] : []; } catch { return []; } }).slice(-LOG_KEEP);
  } else {
    list = (readJSON<Job>(jpath(id))?.log || []).slice(-LOG_KEEP);
    if (list.length) try { mkdirSync(dirname(f), { recursive: true }); appendFileSync(f, list.map((e) => JSON.stringify(e) + '\n').join('')); } catch {}
  }
  recent.set(id, list);
  return list;
}
export function log(id: string, ev: LogEntry) {
  const e = { ts: now(), ...ev }, list = recentLog(id);
  list.push(e); if (list.length > LOG_KEEP) list.splice(0, list.length - LOG_KEEP);
  try { mkdirSync(dirname(eventsFile(id)), { recursive: true }); appendFileSync(eventsFile(id), JSON.stringify(e) + '\n'); } catch {}
  bus.emit('job', id, { type: 'log', ev: e });
}
export function touch(id: string) { update(id, () => {}); }   // tell open pages to reload (e.g. after files were added)

export const setStage = (id: string, stage: Stage, extra: Partial<Job> = {}) => update(id, (j) => Object.assign(j, { stage, ...extra }));
export const chat = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}) => update(id, (j) => { j.chat.push({ role, text, ts: now(), ...extra }); if (j.chat.length > CHAT_KEEP) j.chat.splice(0, j.chat.length - CHAT_KEEP); });
export const pipe = (id: string, fn: (p: Pipeline) => void) => update(id, (j) => { j.pipeline = j.pipeline || {}; fn(j.pipeline); });
export function pause(id: string) { setStage(id, 'needs_input'); return false; }

// Renders need room (frames, previews, the encode): warn early instead of failing mid-render. A real run had 66 MB left.
const MIN_FREE_GB = 5;
export function diskWarning(id: string) {
  try {
    const f = statfsSync(PROJECTS), gb = (f.bavail * f.bsize) / 2 ** 30;
    if (gb < MIN_FREE_GB) chat(id, 'system', L(id, `⚠️ 磁碟只剩 ${gb.toFixed(1)} GB，渲染可能中途失敗；建議先清出 ${MIN_FREE_GB} GB 以上。`, `⚠️ Only ${gb.toFixed(1)} GB of disk left; rendering may fail midway. Free at least ${MIN_FREE_GB} GB first.`));
  } catch { /* statfs unsupported: skip */ }
}

// needs_user items (from any reviewer) pause instead of looping
export function collectNeeds(id: string, items: NeedRequest[] | undefined, from: string) {
  const add: Need[] = (items || []).filter(Boolean).map((n) => ({ ...n, from, at: now() }));
  if (!add.length) return 0;
  // a new batch from the same reviewer replaces its earlier one (the critic re-reports open items every round)
  update(id, (j) => { j.needs = [...(j.needs || []).filter((x) => x.from !== from && !add.some((a) => a.issue === x.issue)), ...add]; });
  chat(id, 'system', L(id, `需要你提供：${add.map((n) => n.issue).join('；')}`, `Needs your input: ${add.map((n) => n.issue).join('; ')}`));
  return add.length;
}

export const readJSON = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export const readText = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
export const oneOf = (v: string | null | undefined, ...L: string[]) => !!v && L.includes(v);
export const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
// Files in one folder of the project matching re, newest first, as project-relative paths.
export function listFiles(id: string, sub: string, re: RegExp) {
  const p = join(dirOf(id), sub);
  return existsSync(p) ? readdirSync(p).filter((f) => re.test(f)).map((f) => ({ f: `${sub}/${f}`, t: statSync(join(p, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f) : [];
}
