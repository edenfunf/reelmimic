// The doctor's notification checks. A local HTTP server plays Discord (GET on a webhook) and the Telegram Bot API.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkDiscord, checkNotify, checkTelegram, checkWebhook } from './notify-check.ts';

const posts: string[] = [];
const srv = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const json = (code: number, body: object) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') { posts.push(url.pathname); return json(405, {}); }
  if (url.pathname === '/api/webhooks/1/good') return json(200, { id: '1', name: 'ReelMimic' });
  if (url.pathname.startsWith('/api/webhooks/')) return json(404, { message: 'Unknown Webhook', code: 10015 });
  if (url.pathname === '/bot1:GOOD/getMe') return json(200, { ok: true, result: { username: 'reel_bot' } });
  if (url.pathname.endsWith('/getMe')) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
  if (url.pathname === '/bot1:GOOD/getChat') return url.searchParams.get('chat_id') === '42'
    ? json(200, { ok: true, result: { id: 42, first_name: 'Ada' } }) : json(400, { ok: false, description: 'Bad Request: chat not found' });
  json(404, {});
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
after(() => srv.close());
const tg = (token: string, chat: string) => ({ TELEGRAM_API: base, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat });

test('Discord: a live webhook passes and shows its name, without posting anything', async () => {
  assert.deepEqual(await checkDiscord(`${base}/api/webhooks/1/good`), { name: 'Discord', ok: true, detail: 'posts as "ReelMimic"' });
  assert.deepEqual(posts, []);
});

test('Discord: a deleted or mistyped webhook fails with the reason', async () => {
  const c = await checkDiscord(`${base}/api/webhooks/1/gone`);
  assert.equal(c.ok, false);
  assert.match(c.detail, /does not exist/);
});

test('Discord: not a URL, or unreachable', async () => {
  assert.match((await checkDiscord('discord.com/api/webhooks/1/x')).detail, /not a URL/);
  assert.match((await checkDiscord('http://127.0.0.1:1/api/webhooks/1/x')).detail, /couldn't reach Discord/);
});

test('the example text copied from secrets.example.json is caught for every key', async () => {
  assert.match((await checkDiscord('a Discord channel webhook: get a message when a video needs you')).detail, /example text/);
  assert.match((await checkTelegram(tg('a bot token from @BotFather', '42'))).detail, /TELEGRAM_BOT_TOKEN is still the example text/);
  assert.match((await checkTelegram(tg('1:GOOD', 'who gets them; send your bot a message'))).detail, /TELEGRAM_CHAT_ID is still the example text/);
  assert.match(checkWebhook('any URL that should get a JSON POST').detail, /WEBHOOK_URL is still the example text/);
});

test('Telegram: a good token and a chat the bot knows pass', async () => {
  assert.deepEqual(await checkTelegram(tg('1:GOOD', '42')), { name: 'Telegram', ok: true, detail: '@reel_bot → Ada' });
});

test('Telegram: a bad token says so, and never shows the token', async () => {
  const c = await checkTelegram(tg('1:BAD', '42'));
  assert.equal(c.ok, false);
  assert.match(c.detail, /rejected TELEGRAM_BOT_TOKEN/);
  assert.doesNotMatch(c.detail, /BAD/);
});

test('Telegram: a chat the bot has never seen tells you to message the bot first', async () => {
  const c = await checkTelegram(tg('1:GOOD', '999'));
  assert.equal(c.ok, false);
  assert.match(c.detail, /@reel_bot can't see chat 999: send the bot a message/);
});

test('webhook: only the URL is checked, nothing is sent', () => {
  assert.deepEqual(checkWebhook(`${base}/hook`), { name: 'webhook', ok: true, detail: `127.0.0.1:${new URL(base).port}, not called: only the URL is checked` });
  assert.match(checkWebhook('ftp://example.com/x').detail, /not an http\(s\) URL/);
  assert.deepEqual(posts, []);
});

test('checkNotify: one result per configured channel, none when nothing is set', async () => {
  assert.deepEqual(await checkNotify({}), []);
  assert.deepEqual(await checkNotify({ TELEGRAM_BOT_TOKEN: '1:GOOD' }), []);   // a token without a chat id isn't a channel yet
  const all = await checkNotify({ DISCORD_WEBHOOK_URL: `${base}/api/webhooks/1/good`, WEBHOOK_URL: `${base}/hook`, ...tg('1:GOOD', '42') });
  assert.deepEqual(all.map((c) => [c.name, c.ok]), [['Discord', true], ['Telegram', true], ['webhook', true]]);
});
