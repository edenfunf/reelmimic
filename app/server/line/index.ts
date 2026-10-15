// LINE bot: check on your videos from your phone, and get a message when one needs you or is done. Setup: docs/LINE.md
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN   from a Messaging API channel in the LINE Developers console; both turn it on
//   LINE_PORT            the webhook's own port (default 4319). Only this port goes behind your HTTPS tunnel: it serves
//                        nothing but POST /line/webhook, while the main server (which can start agents) stays on localhost
//   LINE_ALLOWED_USERS   LINE user IDs that may use the bot without linking (comma-separated)
//   LINE_STATE           where linked accounts are saved (default ~/.reelmimic/line.json)
//   REELMIMIC_URL        optional: where your phone can open the web app, for links in messages
// Nobody can use the bot until they link their LINE account with the code printed in the server terminal (store.ts).
import express from 'express';
import { join } from 'node:path';
import type { Stage } from '../../shared/types.ts';
import * as J from '../jobs.ts';
import { push, reply, text, quick, verifySignature, type LineMessage } from './client.ts';
import { CJK, parse, type Ctx } from './commands.ts';
import { report } from './progress.ts';
import { Store, type BotLang } from './store.ts';

export interface LineConfig { secret: string; token: string; port: number }
export function lineConfig(env: NodeJS.ProcessEnv = process.env): LineConfig | null {
  const secret = env.LINE_CHANNEL_SECRET?.trim(), token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  if (!secret || !token) { if (secret || token) console.error('LINE bot off: it needs both LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN'); return null; }
  const port = Number(env.LINE_PORT || 4319);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`LINE bot off: LINE_PORT must be a port number (1–65535), not "${env.LINE_PORT}"`); return null; }
  return { secret, token, port };
}

// The parts of a webhook event the bot reads (https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects)
export interface LineEvent {
  type: string;
  mode?: 'active' | 'standby';
  webhookEventId?: string;
  replyToken?: string;
  source?: { type: 'user' | 'group' | 'room'; userId?: string };
  message?: { type: string; text?: string };
  postback?: { data: string };
}

const t = (lang: BotLang, zh: string, en: string) => (lang === 'en' ? en : zh);
const notLinked = (lang: BotLang) => [text(t(lang,
  '這個 LINE 帳號還沒綁定 ReelMimic。在執行 ReelMimic 的電腦上，到 app 資料夾執行 npm run line-code 拿配對碼（第一次啟動時終端機也會印一組），然後傳：\n綁定 123456（換成你的配對碼）',
  'This LINE account isn\'t linked to ReelMimic yet. On the computer running ReelMimic, run npm run line-code in the app folder for a link code (the first start prints one too), then send:\npair 123456 (with your code)'))];
const clip = (s: string, n: number) => { const c = [...s]; return c.length > n ? c.slice(0, n).join('') + '…' : s; };   // by character, never half an emoji
// A guess for people the bot doesn't know yet: Latin letters and no CJK → English
const guessLang = (s: string): BotLang => /[a-z]/i.test(s) && !CJK.test(s) ? 'en' : 'zh';

export function createBot(cfg: LineConfig, store: Store) {
  const seen = new Set<string>();   // LINE redelivers events it isn't sure arrived: answer each one once

  // What to say back to one event, or null to stay quiet.
  async function answer(ev: LineEvent): Promise<LineMessage[] | null> {
    // Only one-to-one chats: in a group, project details would reach everyone in it
    const userId = ev.source?.type === 'user' ? ev.source.userId : undefined;
    if (!userId) return null;
    const user = store.get(userId);
    if (ev.type === 'follow') return user ? [text(t(user.lang, '歡迎回來！傳「說明」看可以做什麼。', 'Welcome back! Send "help" to see what I can do.'))] : notLinked('zh');
    const said = ev.type === 'message' && ev.message?.type === 'text' ? ev.message.text || '' : ev.type === 'postback' ? ev.postback?.data || '' : null;
    if (said === null) return ev.type === 'message' ? (user ? [text(t(user.lang, '目前只看得懂文字指令，傳「說明」看有哪些。', 'I only understand text commands for now. Send "help" to see them.'))] : notLinked('zh')) : null;
    const p = parse(said), lang = p?.lang || user?.lang || guessLang(said);
    if (!user && !p?.cmd.open) return notLinked(lang);
    if (!p) return [text(t(lang, `看不懂「${clip(said, 40)}」。傳「說明」看可以用的指令。`, `I don't know "${clip(said, 40)}". Send "help" for the commands.`), quick([{ label: t(lang, '說明', 'help'), text: t(lang, '說明', 'help') }]))];
    if (user && p.lang && p.lang !== user.lang) store.set(userId, { lang: p.lang });   // notifications follow the language you use
    const ctx: Ctx = { userId, user, lang, args: p.args, store };
    return p.cmd.run(ctx);
  }

  async function handle(ev: LineEvent) {
    if (ev.webhookEventId) {
      if (seen.has(ev.webhookEventId)) return;
      seen.add(ev.webhookEventId);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
    }
    if (ev.mode === 'standby' || !ev.replyToken) return;   // standby: another module owns this chat
    const msgs = await answer(ev);
    if (msgs?.length) await reply(cfg.token, ev.replyToken, msgs);
  }
  const handleEvents = (events: LineEvent[]) => Promise.all(events.map((ev) => handle(ev).catch((e) => console.error('LINE:', e))));

  const app = express();
  app.disable('x-powered-by');
  // The raw body is what LINE signed, so it is checked before anything is parsed.
  app.post('/line/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(cfg.secret, body, req.get('x-line-signature'))) return res.status(401).end();
    let events: LineEvent[];
    try { events = JSON.parse(body.toString('utf8')).events || []; } catch { return res.status(400).end(); }
    res.status(200).end();   // answer LINE at once (the console's "Verify" sends no events); replies go out through the API
    void handleEvents(events);
  });
  app.use((req, res) => res.status(404).end());
  // A body too large or in an unknown encoding: a bare status, never Express's page with a stack trace and local paths
  app.use((err: Error & { status?: number }, req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status && err.status < 500 ? err.status : 400).end(); });
  return { app, store, handleEvents };
}

// Push a message to every linked account that wants notifications when a video reaches one of these stages.
// Only changes from now on: stages reached before the server started are never re-sent.
export const NOTIFY_STAGES: Stage[] = ['plan_review', 'needs_input', 'done', 'error'];
// a turn the user cancelled is their own doing: no message for that
const CANCELLED: string[] = Object.values(J.CANCELLED);
export function startNotifier(cfg: LineConfig, store: Store) {
  const last = new Map(J.listJobs().map((p) => [p.id, p.stage]));
  // Runs inside the job machine's save(): it must never throw there, or a notification could break a running job.
  const onJob = (id: string, ev: J.BusEvent) => {
    if (ev.type !== 'job') return;
    const { stage } = ev.job, prev = last.get(id);
    last.set(id, stage);
    if (prev === stage || !NOTIFY_STAGES.includes(stage) || (stage === 'error' && CANCELLED.includes(ev.job.error || ''))) return;
    try {
      const to = store.users().filter((u) => u.notify);
      if (!to.length) return;
      const snap = J.snapshot(id);
      for (const u of to) void push(cfg.token, u.id, [text(report(snap, u.lang), quick([{ label: t(u.lang, '看進度', 'Status'), text: `${t(u.lang, '進度', 'status')} ${id}` }]))]);
    } catch (e) { console.error('LINE notification:', e); }
  };
  J.bus.on('job', onJob);
  return () => { J.bus.off('job', onJob); };
}

// Called by the server once it owns its port (after interrupted jobs are marked, so those aren't announced as errors).
// stateDir: the folder of secrets.json (env.ts), where line.json goes unless LINE_STATE says otherwise.
export function startLine(stateDir: string) {
  const cfg = lineConfig();
  if (!cfg) return null;
  const bot = createBot(cfg, new Store(process.env.LINE_STATE || join(stateDir, 'line.json'), process.env.LINE_ALLOWED_USERS)), stopNotify = startNotifier(cfg, bot.store);
  // A link code, shown in the terminal (and returned to `npm run line-code` through the localhost API)
  const newCode = () => { const c = bot.store.newCode(); console.log(`LINE bot: to link a LINE account, send the bot within 10 minutes: 綁定 ${c.code}  (or: pair ${c.code})`); return c; };
  let up = true;
  const off = (why: string) => { up = false; stopNotify(); console.error(`LINE bot off: ${why}. The rest of ReelMimic keeps running.`); };
  try {
    const server = bot.app.listen(cfg.port, '127.0.0.1', () => {
      const n = bot.store.users().length;
      console.log(`LINE bot → webhook on http://127.0.0.1:${cfg.port}/line/webhook (put only this port behind your HTTPS tunnel) · ${n} linked account${n === 1 ? '' : 's'}${n ? ' (npm run line-code to link another)' : ''}`);
      if (!n) newCode();   // first run: ready to link right away; later, `npm run line-code` when you want to add an account
    });
    server.on('error', (err: NodeJS.ErrnoException) => off(err.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use (set LINE_PORT to another one)` : err.message));
    return { newCode, running: () => up, close: () => { stopNotify(); server.close(); } };
  } catch (e) { off((e as Error).message); return null; }
}
