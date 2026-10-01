// Notifications: when a video needs you or is done, post to Discord and/or any webhook, so you don't have to keep the page open.
//   DISCORD_WEBHOOK_URL  a Discord channel webhook; the finished video is attached when it fits Discord's upload limit
//   WEBHOOK_URL          any URL; gets a JSON POST { event, id, title, stage, message, url } (Slack, n8n, Zapier, your own bot…)
//   REELMIMIC_URL        base of the links in messages (default http://localhost:<PORT>)
// Only stage changes notify, once each; stages already reached before the server started are never re-sent.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Job, Plan, Stage } from '../shared/types.ts';
import * as J from './jobs.ts';

export type NotifyEvent = 'plan_ready' | 'needs_input' | 'done' | 'error';
const EVENT: Partial<Record<Stage, NotifyEvent>> = { plan_review: 'plan_ready', needs_input: 'needs_input', done: 'done', error: 'error' };
const DISCORD_FILE_LIMIT = 10 * 1024 ** 2;   // webhook uploads on a server without boosts

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
  } catch (e) { console.error(`notify: ${what} failed: ${(e as Error).message}`); }
}

export async function send(job: Job, event: NotifyEvent) {
  const title = titleOf(job), text = messageOf(job, event, title), url = linkOf(job.id), work = [];
  if (process.env.DISCORD_WEBHOOK_URL) {
    const content = `${text}\n${url}`.slice(0, 2000), video = join(J.dirOf(job.id), 'out', 'video.mp4');
    const size = event === 'done' ? await stat(video).then((s) => s.size, () => Infinity) : Infinity;
    if (size <= DISCORD_FILE_LIMIT) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content }));
      form.append('files[0]', new Blob([await readFile(video)], { type: 'video/mp4' }), 'video.mp4');
      work.push(post(process.env.DISCORD_WEBHOOK_URL, { body: form }, 'Discord'));
    } else work.push(post(process.env.DISCORD_WEBHOOK_URL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }, 'Discord'));
  }
  if (process.env.WEBHOOK_URL) work.push(post(process.env.WEBHOOK_URL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, id: job.id, title, stage: job.stage, message: text, url }) }, 'webhook'));
  await Promise.all(work);
}

// Watches every job's stage from now on. Returns a stop function (tests), or null when nothing is configured.
export function startNotifier() {
  if (!process.env.DISCORD_WEBHOOK_URL && !process.env.WEBHOOK_URL) return null;
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
