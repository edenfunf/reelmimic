// Notifications: when a video needs you or is done, post to Discord, Telegram and/or any webhook, so you don't have to keep the page open.
//   DISCORD_WEBHOOK_URL  a Discord channel webhook; the finished video is attached when it fits Discord's upload limit
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  a bot from @BotFather messages that chat; the finished video is sent when it fits
//                        (npm run doctor finds the chat id once you've sent the bot a message)
//   WEBHOOK_URL          any URL; gets a JSON POST { event, id, title, stage, message, text, url, lang, needs, error }
//                        (`text` is what a Slack incoming webhook shows; n8n, Zapier or your own bot can use the rest)
//   WEBHOOK_SECRET       optional: sign each webhook request so the receiver can check it came from here (see webhookSignature)
//   REELMIMIC_URL        base of the links in messages (default http://localhost:<PORT>)
// Only stage changes notify, once each; stages already reached before the server started are never re-sent.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
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

// What WEBHOOK_URL receives. `message` is the plain text without the link; `text` adds it (Slack needs a `text` field).
export function webhookBody(job: Job, event: NotifyEvent, title: string, message: string, url: string) {
  return {
    event, id: job.id, title, stage: job.stage, message, text: `${message}\n${url}`, url, lang: job.lang,
    needs: (job.needs || []).map((n) => n.issue), error: event === 'error' ? job.error || '' : null,
  };
}

// With WEBHOOK_SECRET: X-ReelMimic-Timestamp (unix seconds) and X-ReelMimic-Signature: sha256=hex(HMAC-SHA256(secret, `${timestamp}.${body}`)).
// The receiver recomputes it over the raw body, compares in constant time, and can refuse old timestamps (replays).
export const webhookSignature = (secret: string, timestamp: number, body: string) => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
function webhookHeaders(body: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }, secret = process.env.WEBHOOK_SECRET;
  if (!secret) return headers;
  const ts = Math.floor(Date.now() / 1000);
  return { ...headers, 'X-ReelMimic-Timestamp': String(ts), 'X-ReelMimic-Signature': webhookSignature(secret, ts, body) };
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
  if (process.env.WEBHOOK_URL) {
    const body = JSON.stringify(webhookBody(job, event, title, text, url));
    work.push(post(process.env.WEBHOOK_URL, { headers: webhookHeaders(body), body }, 'webhook'));
  }
  await Promise.all(work);
}

// Watches every job's stage from now on. Returns a stop function (tests), or null when nothing is configured.
export function startNotifier() {
  if (!process.env.DISCORD_WEBHOOK_URL && !process.env.WEBHOOK_URL && !telegramOn()) return null;
  const last = new Map(J.listJobs().map((j) => [j.id, j.stage]));
  const onJob = (id: string, ev: J.BusEvent) => {
    if (ev.type !== 'job') return;
    const { stage } = ev.job, prev = last.get(id), event = EVENT[stage];
    last.set(id, stage);
    // a cancel is the user's own doing: no message for it
    if (prev === stage || !event || (stage === 'error' && Object.values(J.CANCELLED).includes(ev.job.error || ''))) return;
    send(ev.job, event).catch((e) => console.error('notify:', e));
  };
  J.bus.on('job', onJob);
  return () => { J.bus.off('job', onJob); };
}
