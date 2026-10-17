// Notifications: when a video needs you or is done, post to Discord, Telegram and/or any webhook, so you don't have to keep the page open.
//   DISCORD_WEBHOOK_URL  a Discord channel webhook; the finished video is attached when it fits Discord's upload limit
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  a bot from @BotFather messages that chat; the finished video is sent when it fits
//                        (npm run doctor finds the chat id once you've sent the bot a message)
//   WEBHOOK_URL          any URL; gets a JSON POST { event, id, title, stage, message, url } (Slack, n8n, Zapier, your own bot…)
//   REELMIMIC_URL        base of the links in messages (default http://localhost:<PORT>)
// Only stage changes notify, once each; stages already reached before the server started are never re-sent.
// Optional, for when and what:
//   NOTIFY_EVENTS        only these events, comma-separated: plan_ready, needs_input, done, error (default: all)
//   NOTIFY_QUIET_HOURS   e.g. 23-8 or 22:30-7:00 (the server's clock): hold messages then, send them when it ends; errors still go out
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, Plan, Stage } from '../shared/types.ts';
import * as J from './jobs.ts';

export type NotifyEvent = 'plan_ready' | 'needs_input' | 'done' | 'error';
const EVENT: Partial<Record<Stage, NotifyEvent>> = { plan_review: 'plan_ready', needs_input: 'needs_input', done: 'done', error: 'error' };
const DISCORD_FILE_LIMIT = 10 * 1024 ** 2;   // webhook uploads on a server without boosts
const TELEGRAM_FILE_LIMIT = 50 * 1024 ** 2;  // Bot API uploads
const telegramOn = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
// TELEGRAM_API: only for tests. The token is part of the URL, so post() never logs URLs.
const telegram = (method: string) => `${(process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '')}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

const titleOf = (job: Job) => { try { return (JSON.parse(readFileSync(join(J.dirOf(job.id), 'plan.json'), 'utf8')) as Plan).title || job.title; } catch { return job.title; } };
export const linkOf = (id: string) => `${(process.env.REELMIMIC_URL || `http://localhost:${process.env.PORT || 4318}`).replace(/\/$/, '')}/#/p/${id}`;

// The message in the project's language (Simplified Chinese projects get the Traditional text, as elsewhere on the server).
export function messageOf(job: Job, event: NotifyEvent, title = titleOf(job)): string {
  const en = job.lang === 'en';
  const needs = (job.needs || []).slice(0, 3).map((n) => `- ${n.issue}`).join('\n') || [...job.chat].reverse().find((c) => c.role === 'system')?.text || '';
  switch (event) {
    case 'plan_ready': return en ? `The plan for "${title}" is ready. Take a look and approve it to start production.` : `「${title}」的企劃好了，看過沒問題就按核准開始製作。`;
    case 'needs_input': return (en ? `"${title}" needs you:` : `「${title}」需要你處理：`) + (needs ? `\n${needs}` : '');
    case 'done': return en ? `"${title}" is done.` : `「${title}」完成了。`;
    case 'error': return (en ? `"${title}" stopped with an error:` : `「${title}」出錯停下來了：`) + `\n${(job.error || '').slice(0, 500)}`;
  }
}

async function post(url: string, init: RequestInit, what: string) {
  try {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60000), ...init });
    if (!r.ok) console.error(`notify: ${what} answered ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.error(`notify: ${what} failed: ${(e as Error).message}`); return false; }
}

export async function send(job: Job, event: NotifyEvent) {
  const title = titleOf(job), text = messageOf(job, event, title), url = linkOf(job.id), work = [];
  const video = join(J.dirOf(job.id), 'out', 'video.mp4');
  const size = event === 'done' ? await stat(video).then((s) => s.size, () => Infinity) : Infinity;
  let bytes: Promise<Buffer> | undefined;
  const videoBlob = async () => new Blob([await (bytes ??= readFile(video))], { type: 'video/mp4' });   // read once for every channel
  if (process.env.DISCORD_WEBHOOK_URL) {
    const content = `${text}\n${url}`.slice(0, 2000);
    if (size <= DISCORD_FILE_LIMIT) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content }));
      form.append('files[0]', await videoBlob(), 'video.mp4');
      work.push(post(process.env.DISCORD_WEBHOOK_URL, { body: form }, 'Discord'));
    } else work.push(post(process.env.DISCORD_WEBHOOK_URL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }, 'Discord'));
  }
  if (telegramOn()) {   // plain text (no parse_mode), so titles and errors need no escaping
    const chat = process.env.TELEGRAM_CHAT_ID!, msg = `${text}\n${url}`;
    const sendText = () => post(telegram('sendMessage'), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: msg.slice(0, 4096), link_preview_options: { is_disabled: true } }) }, 'Telegram');
    if (size <= TELEGRAM_FILE_LIMIT) {
      const form = new FormData();
      form.append('chat_id', chat); form.append('caption', msg.slice(0, 1024)); form.append('supports_streaming', 'true');
      form.append('video', await videoBlob(), 'video.mp4');
      // a failed upload (timeout, file rejected) still tells you it's done
      work.push(post(telegram('sendVideo'), { body: form }, 'Telegram video').then((ok) => ok || sendText()));
    } else work.push(sendText());
  }
  if (process.env.WEBHOOK_URL) work.push(post(process.env.WEBHOOK_URL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, id: job.id, title, stage: job.stage, message: text, url }) }, 'webhook'));
  await Promise.all(work);
}

// Watches every job's stage from now on. Returns a stop function (tests), or null when nothing is configured.
const EVENTS: NotifyEvent[] = ['plan_ready', 'needs_input', 'done', 'error'];
// NOTIFY_EVENTS → the events to send. Unknown names are reported and skipped; nothing usable means all of them.
export function eventFilter(raw = ''): Set<NotifyEvent> {
  const names = raw.split(/[\s,]+/).filter(Boolean), bad = names.filter((n) => !EVENTS.includes(n as NotifyEvent));
  if (bad.length) console.error(`notify: NOTIFY_EVENTS has unknown event(s) ${bad.join(', ')} (known: ${EVENTS.join(', ')})`);
  const good = names.filter((n): n is NotifyEvent => EVENTS.includes(n as NotifyEvent));
  return new Set(good.length ? good : EVENTS);
}

// NOTIFY_QUIET_HOURS → [start, end) in minutes after midnight, or null (unset, unreadable, or an empty range)
export function quietHours(raw = ''): [number, number] | null {
  if (!raw.trim()) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/.exec(raw.trim());
  const at = (h?: string, min?: string) => (+(h || 0) > 23 || +(min || 0) > 59 ? NaN : +(h || 0) * 60 + +(min || 0));
  const range = m ? [at(m[1], m[2]), at(m[3], m[4])] as [number, number] : null;
  if (!range || range.some(Number.isNaN)) { console.error(`notify: NOTIFY_QUIET_HOURS "${raw}" isn't a range like 23-8 or 22:30-7:00, so there are no quiet hours`); return null; }
  return range[0] === range[1] ? null : range;
}
export function isQuiet(range: [number, number] | null, at: Date) {
  if (!range) return false;
  const [from, to] = range, m = at.getHours() * 60 + at.getMinutes();
  return from < to ? m >= from && m < to : m >= from || m < to;   // 23-8 wraps past midnight
}

// clock / tickMs: only for tests.
export function startNotifier({ clock = () => new Date(), tickMs = 60000 } = {}) {
  if (!process.env.DISCORD_WEBHOOK_URL && !process.env.WEBHOOK_URL && !telegramOn()) return null;
  const wanted = eventFilter(process.env.NOTIFY_EVENTS), quiet = quietHours(process.env.NOTIFY_QUIET_HOURS);
  const last = new Map(J.listJobs().map((j) => [j.id, j.stage]));
  const held = new Map<string, NotifyEvent>();   // project → what to tell when the quiet hours end (only the latest counts)
  const deliver = (job: Job, event: NotifyEvent) => { send(job, event).catch((e) => console.error('notify:', e)); };
  const onJob = (id: string, ev: J.BusEvent) => {
    if (ev.type !== 'job') return;
    const { stage } = ev.job, prev = last.get(id), event = EVENT[stage];
    last.set(id, stage);
    // a cancel is the user's own doing: no message for it
    if (prev === stage || !event || (stage === 'error' && Object.values(J.CANCELLED).includes(ev.job.error || ''))) return;
    if (!wanted.has(event)) return;
    if (event !== 'error' && isQuiet(quiet, clock())) { held.set(id, event); return; }
    held.delete(id);
    deliver(ev.job, event);
  };
  // After the quiet hours: what's still true gets sent (a plan you already approved from the web page doesn't)
  const flush = () => {
    if (!held.size || isQuiet(quiet, clock())) return;
    for (const [id, event] of held) {
      held.delete(id);
      try { const job = J.load(id); if (EVENT[job.stage] === event) deliver(job, event); } catch (e) { console.error('notify:', e); }
    }
  };
  const timer = quiet ? setInterval(flush, tickMs) : null;
  timer?.unref();
  J.bus.on('job', onJob);
  return () => { J.bus.off('job', onJob); if (timer) clearInterval(timer); };
}
