// npm run doctor: do the notification settings actually work? Asks Discord and Telegram without posting anything
// (a GET on the webhook, getMe / getChat on the bot), and catches a WEBHOOK_URL that isn't a URL.
// No imports from the job machine, so the doctor can load it on its own.
export interface ChannelCheck { name: string; ok: boolean; detail: string }

// secrets.example.json holds a sentence for every key; copied over unchanged, it looks set but can't work
const PLACEHOLDER = /\s/;
const TIMEOUT_MS = 10000;
const telegramApi = (env: NodeJS.ProcessEnv) => (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

function asUrl(v: string): URL | null {
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
}
async function getJSON(url: string): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (e) { return { error: (e as Error).message }; }
}
const placeholder = (name: string, key: string): ChannelCheck => ({ name, ok: false, detail: `${key} is still the example text from secrets.example.json` });

export async function checkDiscord(hook: string): Promise<ChannelCheck> {
  const name = 'Discord';
  if (PLACEHOLDER.test(hook.trim())) return placeholder(name, 'DISCORD_WEBHOOK_URL');
  if (!asUrl(hook)) return { name, ok: false, detail: 'DISCORD_WEBHOOK_URL is not a URL' };
  const r = await getJSON(hook);   // a webhook URL answers GET with its own details, and posts nothing
  if ('error' in r) return { name, ok: false, detail: `couldn't reach Discord: ${r.error}` };
  if (r.status === 401 || r.status === 404) return { name, ok: false, detail: 'Discord says this webhook does not exist (deleted, or the URL is mistyped)' };
  if (r.status !== 200) return { name, ok: false, detail: `Discord answered ${r.status}` };
  return { name, ok: true, detail: typeof r.body.name === 'string' ? `posts as "${r.body.name}"` : 'webhook found' };
}

export async function checkTelegram(env: NodeJS.ProcessEnv): Promise<ChannelCheck> {
  const name = 'Telegram', token = env.TELEGRAM_BOT_TOKEN?.trim() || '', chat = env.TELEGRAM_CHAT_ID?.trim() || '';
  if (PLACEHOLDER.test(token)) return placeholder(name, 'TELEGRAM_BOT_TOKEN');
  if (PLACEHOLDER.test(chat)) return placeholder(name, 'TELEGRAM_CHAT_ID');
  const base = `${telegramApi(env)}/bot${token}`;
  const me = await getJSON(`${base}/getMe`);
  if ('error' in me) return { name, ok: false, detail: `couldn't reach Telegram: ${me.error}` };   // never the URL: it holds the token
  if (me.status === 401 || me.status === 404) return { name, ok: false, detail: 'Telegram rejected TELEGRAM_BOT_TOKEN (revoked or mistyped; @BotFather shows the current one)' };
  if (me.body.ok !== true) return { name, ok: false, detail: `Telegram says: ${String(me.body.description || me.status)}` };
  const bot = `@${String((me.body.result as { username?: string } | undefined)?.username || 'bot')}`;
  const c = await getJSON(`${base}/getChat?chat_id=${encodeURIComponent(chat)}`);
  if ('error' in c) return { name, ok: false, detail: `couldn't reach Telegram: ${c.error}` };
  if (c.body.ok !== true) return { name, ok: false, detail: `${bot} can't see chat ${chat}: send the bot a message (or add it to that group/channel) first` };
  const r = (c.body.result || {}) as { title?: string; username?: string; first_name?: string };
  return { name, ok: true, detail: `${bot} → ${r.title || r.username || r.first_name || chat}` };
}

export function checkWebhook(url: string): ChannelCheck {
  const name = 'webhook';   // any endpoint: a test POST could set off whatever it's wired to, so only the URL is checked
  if (PLACEHOLDER.test(url.trim())) return placeholder(name, 'WEBHOOK_URL');
  const u = asUrl(url);
  if (!u) return { name, ok: false, detail: 'WEBHOOK_URL is not an http(s) URL' };
  return { name, ok: true, detail: `${u.host}, not called: only the URL is checked` };
}

// Every configured channel, checked side by side. An empty list: nothing is set up.
export async function checkNotify(env: NodeJS.ProcessEnv = process.env): Promise<ChannelCheck[]> {
  const work: (ChannelCheck | Promise<ChannelCheck>)[] = [];
  if (env.DISCORD_WEBHOOK_URL) work.push(checkDiscord(env.DISCORD_WEBHOOK_URL));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) work.push(checkTelegram(env));
  if (env.WEBHOOK_URL) work.push(checkWebhook(env.WEBHOOK_URL));
  return Promise.all(work);
}
