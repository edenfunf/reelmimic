// Ask the notification bot how your videos are doing: /list, /status [n | id | part of a title], /help.
//   TELEGRAM_COMMANDS=1  turns it on (with TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
// Long polling (getUpdates), so no public port or webhook is needed. Only TELEGRAM_CHAT_ID gets answers, and nothing here
// changes a project: the server stays localhost-only, the bot only reads.
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job, Lang, ProjectSummary, Stage } from '../shared/types.ts';
import * as J from './jobs.ts';
import { linkOf, telegram, telegramOn } from './notify.ts';

const LIST = 8, POLL_S = 25;
const STAGES: Record<Stage, [en: string, zh: string]> = {   // zh as on the project page
  new: ['Queued', '排隊中'], analyzing: ['Breaking down the reference', '拆解中'], styling: ['Working out the style', '判斷風格'], styled: ['Style ready', '風格完成'],
  planning: ['Planning', '企劃中'], plan_review: ['Plan waiting for you', '等你確認企劃'], replanning: ['Revising the plan', '修改企劃'], producing: ['Producing', '生產中'],
  needs_input: ['Needs you', '等你提供'], critiquing: ['Reviewing', '評審中'], revising: ['Revising', '修改中'], done: ['Done', '完成'], error: ['Stopped', '需要處理'],
};
const T = {
  en: { none: 'No projects yet.', more: '/status 1 for details.', miss: (q: string) => `No project matches "${q}". /list shows the latest ones.`, needs: 'Needs from you:', error: 'Error:', unknown: 'Unknown command. /help lists what I can do.',
    help: 'Ask how your videos are doing:\n/list – the latest 8 projects\n/status [number | title] – one project (default: the latest)\nThis bot only reads; open the page to make changes.' },
  zh: { none: '還沒有專案。', more: '/status 1 看詳情。', miss: (q: string) => `找不到「${q}」，/list 看最近的專案。`, needs: '需要你處理：', error: '錯誤：', unknown: '看不懂這個指令，/help 看看能做什麼。',
    help: '問問影片做得怎麼樣：\n/list – 最近 8 個專案\n/status [編號 | 標題] – 某個專案（不填就是最新的）\n機器人只會回報，要改東西請開網頁。' },
};

const stageOf = (s: Stage, en: boolean) => STAGES[s]?.[en ? 0 : 1] || s;
function ago(iso: string | undefined, en: boolean) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)), [n, u] = m < 60 ? [m, 0] : m < 1440 ? [Math.floor(m / 60), 1] : [Math.floor(m / 1440), 2];
  if (!n) return en ? 'just now' : '剛剛';
  return en ? `${n} ${['min', 'h', 'd'][u]} ago` : `${n} ${['分鐘', '小時', '天'][u]}前`;
}

function list(jobs: ProjectSummary[], en: boolean) {
  const t = T[en ? 'en' : 'zh'];
  if (!jobs.length) return t.none;
  return jobs.slice(0, LIST).map((j, i) => `${i + 1}. ${j.title} · ${[stageOf(j.stage, en), ago(j.updatedAt, en)].filter(Boolean).join(' · ')}`).join('\n') + `\n\n${t.more}`;
}

// n from /list, an exact id, or part of a title (the most recent match); no argument = the latest project.
function status(jobs: ProjectSummary[], q: string, en: boolean) {
  const t = T[en ? 'en' : 'zh'], n = /^\d+$/.test(q) ? +q : 0;
  const hit = !q ? jobs[0] : jobs.find((j) => j.id === q) || (n >= 1 && n <= jobs.length ? jobs[n - 1] : undefined) || jobs.find((j) => j.title.toLowerCase().includes(q.toLowerCase()));
  if (!hit) return jobs.length ? t.miss(q) : t.none;
  const job: Job = J.load(hit.id), needs = (job.needs || []).map((x) => `- ${x.issue}`).join('\n');
  return [hit.title, [stageOf(job.stage, en), ago(job.updatedAt, en)].filter(Boolean).join(' · '),
    needs && `${t.needs}\n${needs}`, job.stage === 'error' && job.error && `${t.error} ${job.error.slice(0, 1000)}`, linkOf(job.id)].filter(Boolean).join('\n\n');
}

// One language for every reply: the most recent project's (a bot has no page language to follow).
export function reply(text: string): string | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;   // not a command: stay quiet, as bots do in groups
  const jobs = J.listJobs(), lang: Lang = jobs[0] ? J.load(jobs[0].id).lang : 'zh-TW', en = lang === 'en', arg = (m[2] || '').trim();
  switch (m[1].toLowerCase()) {
    case 'list': return list(jobs, en);
    case 'status': return status(jobs, arg, en);
    case 'help': case 'start': return T[en ? 'en' : 'zh'].help;
    default: return T[en ? 'en' : 'zh'].unknown;
  }
}

type Update = { update_id: number; message?: { chat: { id: number | string }; text?: string } };
async function call<R>(method: string, body: object, signal: AbortSignal, timeoutMs = 30000) {
  const r = await fetch(telegram(method), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { ok?: boolean; result?: R; description?: string } };
}

async function poll(signal: AbortSignal) {
  const chat = process.env.TELEGRAM_CHAT_ID!;
  const commands = (zh: boolean) => [['list', zh ? '最近的專案' : 'Latest projects'], ['status', zh ? '某個專案的狀態：編號或標題' : 'One project: number or title'], ['help', zh ? '說明' : 'What I can do']].map(([command, description]) => ({ command, description }));
  // the menu next to the text box; cosmetic, so a failure is ignored
  await Promise.all([call('setMyCommands', { commands: commands(false) }, signal), call('setMyCommands', { commands: commands(true), language_code: 'zh' }, signal)]).catch(() => {});
  let offset = 0, wait = 5000;
  while (!signal.aborted) {
    try {
      const r = await call<Update[]>('getUpdates', { offset, timeout: POLL_S, allowed_updates: ['message'] }, signal, (POLL_S + 10) * 1000);
      if (r.status === 409) return console.error('Telegram commands off: the bot has a webhook set (or another copy is polling). Remove it with deleteWebhook, then restart.');
      if (!r.body.ok) throw new Error(`answered ${r.status} ${(r.body.description || '').slice(0, 200)}`);   // never the URL: it holds the token
      for (const u of r.body.result || []) {
        offset = u.update_id + 1;   // acknowledged on the next poll, so each update is handled once
        if (String(u.message?.chat.id) !== chat || !u.message?.text) continue;   // anyone else who finds the bot gets nothing
        let text: string | null;
        try { text = reply(u.message.text); } catch (e) { console.error('Telegram commands:', e); continue; }
        if (text) await call('sendMessage', { chat_id: chat, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } }, signal).catch((e) => console.error(`Telegram commands: reply failed: ${(e as Error).message}`));
      }
      wait = 5000;
    } catch (e) {
      if (signal.aborted) return;
      console.error(`Telegram commands: getUpdates ${(e as Error).message}; retrying in ${wait / 1000} s`);
      await sleep(wait, undefined, { signal }).catch(() => {});
      wait = Math.min(wait * 2, 60000);
    }
  }
}

// Returns a stop function (tests: aborts the poll in flight, resolves once the loop has ended), or null when off.
export function startCommands() {
  if (process.env.TELEGRAM_COMMANDS !== '1' || !telegramOn()) return null;
  const ac = new AbortController(), done = poll(ac.signal);
  return () => { ac.abort(); return done; };
}
