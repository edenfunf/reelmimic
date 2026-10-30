// ntfy (ntfy.sh or your own server): phone push notifications without making a bot.
//   NTFY_URL        the full topic URL, e.g. https://ntfy.sh/my-reelmimic-topic
//   NTFY_TOKEN      access token for a protected topic (sent as a Bearer header, never logged)
//   NTFY_ATTACH_MB  attach the finished video when it's at most this big (default 15, ntfy.sh's free limit; 0 = never)
import type { NotifyEvent } from './notify.ts';

const TAGS: Record<NotifyEvent, string> = { plan_ready: 'memo', needs_input: 'pause_button', done: 'white_check_mark', error: 'warning' };
const URGENT: NotifyEvent[] = ['needs_input', 'error'];   // these wait on you, so they may buzz through quiet settings
// Header values must be plain ASCII; ntfy decodes RFC 2047 encoded words, so Chinese titles and multi-line messages go base64.
export const header = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;

async function request(init: RequestInit, timeout: number, what: string) {
  try {   // only `what` is ever logged: the token is in the headers and a private topic name is as good as a password
    const r = await fetch(process.env.NTFY_URL!, { method: 'POST', signal: AbortSignal.timeout(timeout), ...init });
    if (!r.ok) console.error(`notify: ${what} answered ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.error(`notify: ${what} failed: ${(e as Error).message}`); return false; }
}

type Ntfy = { event: NotifyEvent; title: string; text: string; url: string; size?: number; video?: () => Promise<Blob> };
export async function sendNtfy({ event, title, text, url, size = Infinity, video }: Ntfy) {
  const headers: Record<string, string> = { Title: header(title), Tags: TAGS[event], Click: header(url) };
  if (URGENT.includes(event)) headers.Priority = 'high';
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
  const sendText = () => request({ headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: text }, 60000, 'ntfy');
  const mb = Number(process.env.NTFY_ATTACH_MB || 15);
  if (!video || event !== 'done' || !(size <= mb * 1024 ** 2)) return sendText();
  // with a file as the body the text rides in the Message header, kept short so proxies don't reject the request
  const ok = await request({ method: 'PUT', headers: { ...headers, Filename: 'video.mp4', Message: header(text.slice(0, 1000)) }, body: await video() }, 60000 + Math.ceil(size / 1024 ** 2) * 10000, 'ntfy video');
  return ok || sendText();   // a failed upload (too big for the server, timeout) still tells you it's done
}
