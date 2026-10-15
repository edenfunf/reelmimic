// What the bot says about a project: one line per project for the list, a short report for one project. Read straight
// from job.json and the contract files (the same snapshot the web app shows), in the user's language.
import type { Job, ProjectSummary, Snapshot, Stage } from '../../shared/types.ts';
import type { BotLang } from './store.ts';

type Words = Record<BotLang, string>;
// Same words as the web app's status badges (web/src/Project.tsx STATUS, English from web/src/i18n.ts)
export const STAGE: Record<Stage, Words> = {
  new: { zh: '排隊中', en: 'Queued' }, analyzing: { zh: '拆解中', en: 'Analyzing' }, styling: { zh: '判斷風格', en: 'Styling' },
  styled: { zh: '風格完成', en: 'Styled' }, planning: { zh: '企劃中', en: 'Planning' }, plan_review: { zh: '等你確認企劃', en: 'Awaiting your approval' },
  replanning: { zh: '修改企劃', en: 'Revising plan' }, producing: { zh: '生產中', en: 'Producing' }, needs_input: { zh: '等你提供', en: 'Needs your input' },
  critiquing: { zh: '評審中', en: 'Reviewing' }, revising: { zh: '修改中', en: 'Revising' }, done: { zh: '完成', en: 'Done' }, error: { zh: '需要處理', en: 'Needs attention' },
};
const ICON: Partial<Record<Stage, string>> = { plan_review: '📝', needs_input: '⏸️', done: '✅', error: '⚠️' };
const PHASE: Record<string, Words> = {
  setup: { zh: '導演建置角色與共用素材', en: 'Setting up characters and shared assets' }, cast: { zh: '角色關', en: 'Cast gate' },
  shots: { zh: '分段製作', en: 'Building segments' }, assemble: { zh: '組裝成片', en: 'Assembling the film' }, final: { zh: '最後評審', en: 'Final review' },
};
const WORKING: Stage[] = ['analyzing', 'styling', 'planning', 'replanning', 'producing', 'critiquing', 'revising'];

export const stageText = (stage: Stage, lang: BotLang) => `${ICON[stage] || (WORKING.includes(stage) ? '⏳' : '•')} ${STAGE[stage]?.[lang] || stage}`;

export function ago(iso: string | undefined, lang: BotLang, now = Date.now()) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000)), en = lang === 'en';
  if (m < 1) return en ? 'just now' : '剛剛';
  if (m < 60) return en ? `${m} min ago` : `${m} 分鐘前`;
  const h = Math.round(m / 60);
  if (h < 24) return en ? `${h} h ago` : `${h} 小時前`;
  const d = Math.round(h / 24);
  return en ? `${d} day${d > 1 ? 's' : ''} ago` : `${d} 天前`;
}

// Base of the links in messages, only when the web app is reachable from the phone (REELMIMIC_URL); the default
// localhost address would be a dead link there.
export const linkOf = (id: string) => process.env.REELMIMIC_URL ? `${process.env.REELMIMIC_URL.replace(/\/$/, '')}/#/p/${id}` : null;

export function listLine(p: ProjectSummary, n: number, lang: BotLang, now?: number) {
  const needs = p.needs ? (lang === 'en' ? ` · ${p.needs} for you` : ` · ${p.needs} 項待你處理`) : '';
  return `${n}. ${p.title}\n   ${stageText(p.stage, lang)} · ${ago(p.updatedAt, lang, now)}${needs}`;
}

// Where production is: phase, segments passed, cast gate, final review round.
const colon = (lang: BotLang) => (lang === 'en' ? ': ' : '：');
function pipelineLines(job: Job, lang: BotLang): string[] {
  const p = job.pipeline || {}, en = lang === 'en', c = colon(lang), out: string[] = [];
  if (!p.phase || !['producing', 'needs_input', 'critiquing', 'revising', 'error', 'done'].includes(job.stage)) return out;
  if (job.stage !== 'done') out.push(`${en ? 'Step' : '階段'}${c}${PHASE[p.phase]?.[lang] || p.phase}${p.phase === 'final' && p.final?.round ? (en ? ` (round ${p.final.round})` : `（第 ${p.final.round} 輪）`) : ''}`);
  if (p.cast?.chars && Object.keys(p.cast.chars).length) {
    const all = Object.values(p.cast.chars), ok = all.filter((x) => x.state === 'passed').length;
    out.push(`${en ? 'Characters' : '角色'}${c}${p.cast.pass ? (en ? 'passed' : '通過') : `${ok}/${all.length} ${en ? 'passed' : '通過'}`}`);
  }
  const chunks = Object.values(p.chunks || {});
  if (chunks.length) {
    const n = (states: string[]) => chunks.filter((x) => states.includes(x.state)).length;
    const busy = n(['building', 'reviewing', 'fixing', 'shared_fix']), bad = n(['failed', 'error', 'needs_user']);
    out.push(`${en ? 'Segments' : '分段'}${c}${n(['passed'])}/${chunks.length} ${en ? 'passed' : '通過'}${busy ? (en ? ` · ${busy} in progress` : ` · ${busy} 段進行中`) : ''}${bad ? (en ? ` · ${bad} stuck` : ` · ${bad} 段卡住`) : ''}`);
  }
  return out;
}

export function report(s: Snapshot, lang: BotLang, now?: number) {
  const { job } = s, en = lang === 'en', lines = [`🎬 ${s.plan?.title || job.title}`, `${stageText(job.stage, lang)} · ${ago(job.updatedAt, lang, now)}`];
  lines.push(...pipelineLines(job, lang));
  const open = s.requiredInputs.filter((r) => r.status === 'missing');
  if (job.stage === 'plan_review') lines.push(en ? 'The plan is ready: approve it on the web page to start production.' : '企劃好了，到網頁上看過、核准後就開始製作。');
  if (open.length && ['plan_review', 'needs_input', 'planning', 'replanning'].includes(job.stage)) lines.push(`${en ? 'Still needed from you' : '還需要你提供'}${colon(lang)}${open.map((r) => r.label || r.id).join(en ? ', ' : '、')}`);
  const needs = (job.needs || []).slice(0, 5);
  if (needs.length) lines.push(en ? 'Needs you:' : '需要你處理：', ...needs.map((n) => `- ${n.issue}`));
  // what the server last said: why production paused, or how the final review ended ("passed", "N must-fix items left")
  else if (job.stage === 'needs_input' || job.stage === 'done') { const sys = [...(job.chat || [])].reverse().find((c) => c.role === 'system'); if (sys) lines.push(sys.text); }
  if (job.stage === 'error') lines.push((job.error || '').slice(0, 400), en ? 'Open the project and click “Retry this step” to continue.' : '到網頁上按「重試這一步」就能從目前的檔案繼續。');
  if (job.stage === 'done') lines.push(s.video ? (en ? 'The film is ready (out/video.mp4).' : '成片好了（out/video.mp4）。') : '');
  const link = linkOf(job.id);
  if (link) lines.push(link);
  return lines.filter(Boolean).join('\n');
}
