// One agent turn: a slot from the global budget, the step's prompt, and a check that the files it must write were updated.
// turn() never touches the stage; step() is a turn that does (it moves the job on, or stops it in `error` with the reason).
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runAgent, type AgentResult } from './agents/index.ts';
import { checkFile } from './contract.ts';
import { prompts as bootPrompts } from './prompts.ts';
import { signalOf } from './runner.ts';
import { CANCELLED, CONFIG, L, ROOT, chat, dirOf, listFiles, load, log, mtime, qualityOf, readText, setStage, update } from './store.ts';
import type { Stage } from '../shared/types.ts';
import type { Phase, Prompts, StepVars } from './types.ts';

// prompts.ts is re-imported when it changes, so prompt fixes reach the next agent turn without restarting running jobs
let promptCache: { m: number; p: Prompts } = { m: 0, p: bootPrompts };
async function livePrompts() {
  const f = join(import.meta.dirname, 'prompts.ts'), m = statSync(f).mtimeMs;
  if (m !== promptCache.m) { try { promptCache = { m, p: (await import(`./prompts.ts?v=${m}`)).prompts }; } catch (e) { console.error('prompts reload failed', e); } }
  return promptCache.p;
}

// ---------- global agent slots (all projects share them) ----------
// Reviews and fixes jump the queue: a defect is fixed while the builder still has it in mind, and nobody waits on a
// review behind a fresh 30-minute build. New builds take whatever slots are left.
let used = 0; const waiters: { r: (ok: boolean) => void; hi: boolean }[] = [];
const URGENT = new Set(['cast_qa', 'cast_fix', 'shot_qa', 'fix_chunk', 'assemble', 'critique', 'revise', 'replan', 'plan', 'style']);
// false: the run was cancelled while waiting (no slot taken)
async function slot(phase: Phase, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (used < CONFIG.maxAgentsGlobal) { used++; return true; }
  const ok = await new Promise<boolean>((r) => {
    const w = { r, hi: URGENT.has(phase) };
    if (w.hi) { const i = waiters.findIndex((x) => !x.hi); i < 0 ? waiters.push(w) : waiters.splice(i, 0, w); } else waiters.push(w);
    signal.addEventListener('abort', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); r(false); } }, { once: true });
  });
  if (ok) used++;
  return ok;
}
function release() { used--; const w = waiters.shift(); if (w) w.r(true); }

// session: 'director' (the project's main conversation), 'fresh' (a reviewer with no stake), or any key (a builder that keeps
// its own conversation across its fix rounds).
// A failed turn says why: cancelled, the AI account's usage limit, outputs not written, outputs that break CONTRACT.md
// (after one chance to fix them), or the agent itself failed.
export interface TurnOpts { session?: string; who?: string }
type Why = 'aborted' | 'limit' | 'missing' | 'invalid' | 'crashed';
export interface TurnResult { ok: boolean; why?: Why; text?: string; missing?: string[]; detail?: string }
const LIMIT = /usage limit|rate limit|hit your limit|limit reached|quota|credit balance|insufficient credits|available credits|payment required|\b(?:402|429)\b|too many requests/i;
export async function turn<P extends Phase>(id: string, phase: P, vars: StepVars[P], must: string[], { session = 'director', who }: TurnOpts = {}): Promise<TurnResult> {
  const j = load(id), d = dirOf(id), signal = signalOf(id);
  const p = { dir: relative(ROOT, d).replace(/\\/g, '/'), brief: readText(join(d, 'brief.md')) || '', inputs: listFiles(id, 'inputs', /./), config: CONFIG, lang: j.lang || 'zh-TW', quality: qualityOf(j), ...vars };
  const before = must.map((f) => mtime(join(d, f)));
  const sid = session === 'fresh' ? undefined : session === 'director' ? j.sessionId : (j.sessions || {})[session];
  const label = who || (session === 'fresh' ? 'reviewer' : session);
  // one agent run in a slot; the session id is kept for the director and builders (a reviewer's only lives in this turn)
  const once = async (prompt: string, resume: string | null | undefined): Promise<AgentResult | null> => {
    if (!(await slot(phase, signal))) return null;
    log(id, { type: 'turn', state: 'start', phase, who: label });
    let res: AgentResult;
    try {
      res = await runAgent({ kind: j.agent, cwd: ROOT, prompt, sessionId: resume, signal,
        onEvent: (e) => {
          if (e.type === 'session' && session !== 'fresh') update(id, (jj) => { if (session === 'director') jj.sessionId = e.id; else { jj.sessions = jj.sessions || {}; jj.sessions[session] = e.id; } });
          if (e.type !== 'done') log(id, { ...e, who: label });
        } });
    } finally { release(); }
    log(id, { type: 'turn', state: 'end', phase, who: label, ok: !!res?.ok && !signal.aborted });
    return signal.aborted ? null : res;
  };
  let r = await once((await livePrompts())[phase](p), sid);
  if (!r) return { ok: false, why: 'aborted' };
  let missing = must.filter((f, i) => !(mtime(join(d, f)) > before[i]));
  // first turn after "retry": the interrupted turn may already have written everything, and the agent rightly
  // changes nothing. Existing outputs count then, so the user isn't stuck retrying a finished step.
  if (missing.length && r.ok && load(id).retryPending) missing = missing.filter((f) => !existsSync(join(d, f)));
  if (load(id).retryPending) update(id, (x) => { delete x.retryPending; });
  if (r.text) chat(id, session === 'fresh' ? 'critic' : session === 'director' ? 'agent' : 'builder', r.text, { phase, who: label });
  // an account limit is the real cause, even when it also left outputs missing: say so plainly. Only for a turn that
  // failed: a finished one may mention "rate limit" or "quota" (yt-dlp output, a reviewer's notes) without being stopped by one
  const limit = (!r.ok || missing.length) && [r.lastError, r.text, r.stderr].find((t) => t && LIMIT.test(t));
  if (limit) return { ok: false, why: 'limit', text: r.text, missing, detail: limit.slice(-300) };
  if (!r.ok && !missing.length) return { ok: false, why: 'crashed', text: r.text, detail: r.stderr.slice(-300) };
  if (missing.length) return { ok: false, why: 'missing', text: r.text, missing };
  // the files are there; do they follow CONTRACT.md? One chance to fix them, in the same conversation
  const check = () => must.filter((f) => f.endsWith('.json')).flatMap((f) => checkFile(f, readText(join(d, f)) ?? ''));
  let bad = check();
  if (bad.length && r.sessionId) {
    log(id, { type: 'error', text: `${label}: ${bad.join('; ')}`.slice(0, 400), who: label });
    r = await once(fixFormat(p.dir, bad), r.sessionId);
    if (!r) return { ok: false, why: 'aborted' };
    bad = check();
  }
  if (bad.length) return { ok: false, why: 'invalid', text: r.text, detail: bad.slice(0, 6).join('; ') };
  return { ok: true, text: r.text };
}
const fixFormat = (dir: string, bad: string[]) => `## 修正檔案格式
專案資料夾：${dir}。你剛寫的檔案不符合 .claude/skills/video-clone/CONTRACT.md，伺服器讀不懂：
${bad.map((b) => `- ${b}`).join('\n')}
只要把這些檔案照 CONTRACT.md 的格式重寫（內容保持你剛剛的判斷，只修格式），不要做別的事。`;

export function fail(id: string, stageName: Stage, res: TurnResult) {
  const d = res.detail || '';
  const error = {
    aborted: () => L(id, CANCELLED.zh, CANCELLED.en),
    limit: () => L(id, `AI 服務商回報用量、額度或速率限制。等在途請求完成、補充額度，或換另一個 AI 導演，再從這裡繼續；已完成的檔案會保留。原始訊息：${d}`, `The AI provider reported a usage, credit, or rate limit. Wait for in-flight requests to settle, add credits if needed, or switch provider/model, then retry from here. Existing files are kept. Message: ${d}`),
    missing: () => L(id, `缺少輸出：${(res.missing || []).join(', ')}`, `Missing output: ${(res.missing || []).join(', ')}`),
    invalid: () => L(id, `agent 寫的檔案格式不對（已請它重寫一次）：${d}`, `The agent's files don't follow the contract (it was asked to rewrite them once): ${d}`),
    crashed: () => L(id, `agent 回合失敗${d ? '：' + d : ''}`, `The agent turn failed${d ? ': ' + d : ''}`),
  }[res.why || 'crashed']();
  setStage(id, 'error', { failed: stageName, error });
  return false;
}
export async function step<P extends Phase>(id: string, stageName: Stage, phase: P, vars: StepVars[P], must: string[], next?: Stage | null, opts?: TurnOpts) {
  setStage(id, stageName, { error: null, failed: null });
  const r = await turn(id, phase, vars, must, opts);
  if (!r.ok) return fail(id, stageName, r);
  if (next) setStage(id, next);
  return true;
}
