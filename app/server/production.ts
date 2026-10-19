// Production after approval: setup (director) → cast gate → shot line (N builders in parallel; every shot is reviewed by
// a fresh shot_qa as soon as it is built ⇄ fix_chunk; passed segments render in the background) → assemble (director).
// With OVERLAP_CAST=1 the shot line starts while the cast gate is still running.
// Quality is checked where defects are born (each character, each segment), not only at the end.
import { existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { castGate } from './cast.ts';
import { checkProduction } from './contract.ts';
import { prerender, resetPrerenders, waitPrerenders } from './prerender.ts';
import { blockerFree, reviewFix, sharedItems } from './review.ts';
import { aborted } from './runner.ts';
import { CONFIG, L, chat, collectNeeds, dirOf, load, log, pause, pipe, readJSON, rounds, setStage } from './store.ts';
import { fail, step, turn, type TurnResult } from './turn.ts';
import type { ChunkProgress, NeedRequest, Pipeline } from '../shared/types.ts';
import type { Chunk, ChunkReview, Production, ShotEntry } from './types.ts';

const sharedLocks = new Map<string, Promise<unknown>>();   // per project: one director edits shared files at a time
function sharedLock<T>(key: string, fn: () => Promise<T>): Promise<T> { const prev = sharedLocks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); sharedLocks.set(key, next.catch(() => {})); return next; }

const STATE = { error: 'error', needs: 'needs_user', passed: 'passed', limit: 'failed', handoff: 'error' } as const;

// at most CONFIG.maxReviews shot reviews of one project at a time (each grabs frames in Chrome)
const reviewQ = new Map<string, { n: number; wait: (() => void)[] }>();
async function reviewSlot<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const q = reviewQ.get(id) || { n: 0, wait: [] }; reviewQ.set(id, q);
  if (q.n >= CONFIG.maxReviews) await new Promise<void>((r) => q.wait.push(r));   // woken with the slot already counted
  else q.n++;
  try { return await fn(); } finally { const next = q.wait.shift(); if (next) next(); else q.n--; }
}

export async function production(id: string, { fresh = false } = {}): Promise<boolean> {
  const d = dirOf(id), prev: Pipeline = fresh ? {} : load(id).pipeline || {};
  const hasSetup = !fresh && existsSync(join(d, 'build', 'production.json'));
  // 1) director: scaffold, shared assets, cast sheets, chunk plan (skipped when resuming)
  if (!hasSetup) {
    pipe(id, (p) => { p.phase = 'setup'; });
    if (!(await step(id, 'producing', 'setup', {}, ['build/production.json']))) return false;
  } else {
    setStage(id, 'producing', { error: null, failed: null });
    const issues = checkProduction(d);
    if (issues.length) {
      // Keep setup, shot files, animation and passed chunks. Repair only inconsistent metadata or missing cast artifacts.
      const r = await turn(id, 'setup', { reconcile: issues }, ['build/production.json']);
      if (!r.ok) return fail(id, 'producing', r);
      delete prev.cast;
      pipe(id, (p) => { delete p.cast; });   // a stale no-cast pass cannot exempt a recovered character from review
    }
  }
  // 2) cast gate, then 3) shot building. With overlapCast they run at the same time: shots only call the shared character
  //    definitions, so cast fixes flow into them; shot REVIEWS still wait until the cast has passed.
  resetPrerenders(id);   // a fresh or resumed production may render in the background again
  const castP = castGate(id, prev);
  if (!CONFIG.overlapCast && !(await castP)) return false;   // characters are final before any shot is built
  const prod = readJSON<Production>(join(d, 'build', 'production.json')) || {};
  const chunks = prod.chunks || [];
  const old = prev.chunks || {};
  let broken = null as TurnResult | null;   // the first agent turn that failed: reported as itself, not as "didn't pass review"
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
      const r = await reviewSlot(id, () => turn(id, 'shot_qa', { chunk: c, shots: [sid], round, out: `out/check/shots/${sid}.review.json` }, [`out/check/shots/${sid}.review.json`], { session: 'fresh', who: `shot-qa-${sid}` }));
      if (!r.ok) { broken ??= r; return false; }
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
      if (!b.ok) { broken ??= b; set({ state: 'error' }); return false; }
    }
    if (!load(id).pipeline.cast?.pass) set({ state: 'waiting_cast' });
    if (!(await castP)) { set({ state: 'built' }); return false; }
    let todo = c.shots, reused = false;
    const { end, last } = await reviewFix<{ bad: ShotEntry[]; needs: NeedRequest[] }>({
      review: async (round) => {
        set({ state: 'reviewing', round });
        if (reuse) {   // after a user note the latest review is still valid: fix first
          const rv = readJSON<ChunkReview>(join(SH, `${c.id}.review.json`)) || {};
          for (const e of rv.shots || []) results[e.id] = { entry: e, needs: [], verified: [] };
          reuse = false; reused = true;
        } else {
          for (const sid of todo) if (!reviews[sid] || round > 1) reviewShot(sid, round);   // round 1: shots the watcher missed
          const ok = await Promise.all(todo.map((sid) => reviews[sid]));
          if (ok.includes(false)) return null;
          mergeReview();
        }
        return { needs: c.shots.flatMap((x) => results[x]?.needs || []), bad: c.shots.map((x) => results[x]?.entry).filter((e): e is ShotEntry => !!e && !blockerFree(e)) };
      },
      verdict: (r) => (collectNeeds(id, r.needs, `shot-qa-${c.id}`) ? 'needs' : r.bad.length ? 'fix' : 'passed'),
      // a reused review isn't a round: the user's note still gets its fixes. One blocker left at the limit: one more round
      // instead of pausing (a real run sat 23 minutes waiting to say "fix it")
      limit: ({ bad }) => rounds(id).chunkRounds + (reused ? 1 : 0) + (bad.flatMap((e) => e.issues || []).filter((x) => x.severity !== 'polish').length <= 1 ? 1 : 0),
      fix: async ({ bad }, round) => {
        set({ state: 'fixing' });
        const f = await turn(id, 'fix_chunk', { chunk: c, bad, round, message: load(id).userNote }, [`out/check/shots/${c.id}.fixes.json`], { session: key, who: key });
        if (!f.ok) { broken ??= f; return 'error'; }
        // shared-file problems (rig, cast, common assets) can't be fixed by a builder: the director fixes them right now,
        // one at a time across segments, before this segment is reviewed again
        const shared = sharedItems(readJSON(join(SH, `${c.id}.fixes.json`)));
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
            if (!g.ok) { broken ??= g; return 'error'; }
          }
        }
        todo = bad.map((e): string | undefined => e.id).concat(shared.map((x) => x.shot)).filter((x, i, A): x is string => !!x && A.indexOf(x) === i && c.shots.includes(x));
        return 'ok';
      },
    });
    set(end === 'limit' ? { state: 'failed', open: last!.bad.length } : { state: STATE[end] });
    if (end === 'passed') prerender(id, c);
    return end === 'passed';
  };
  const queue = [...chunks];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONFIG.builders, chunks.length)) }, async () => {
    while (queue.length && !aborted(id)) await runChunk(queue.shift()!);
  }));
  if (!(await castP)) return false;   // the cast gate paused for the user; built segments are kept
  if (broken) return fail(id, 'producing', broken);
  const j = load(id);
  if ((j.needs || []).length) return pause(id);
  const failed = Object.entries(j.pipeline.chunks || {}).filter(([, v]) => v.state !== 'passed');
  if (failed.length) {
    chat(id, 'system', L(id, `有 ${failed.length} 段沒通過鏡頭審查：${failed.map(([k, v]) => `${k}(${v.state})`).join('、')}，請你看這幾段決定`, `${failed.length} part${failed.length > 1 ? 's' : ''} didn't pass shot review: ${failed.map(([k, v]) => `${k} (${v.state})`).join(', ')}. Please take a look and decide`));
    return pause(id);
  }
  // 4) assemble (after the background renders of passed segments, so their frames are reused, not redrawn)
  pipe(id, (p) => { p.phase = 'assemble'; });
  await waitPrerenders(id);
  return step(id, 'producing', 'assemble', {}, ['out/video.mp4'], 'done');
}
