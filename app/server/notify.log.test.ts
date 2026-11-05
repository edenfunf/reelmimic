// Every notification leaves one entry per channel in the project's log, so a broken channel shows up in the app
// instead of only in the server terminal. A local HTTP server stands in for Discord, the Bot API and the webhook.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { NotifyMarker } from '../shared/types.ts';

const status: Record<string, number> = {};   // path suffix → status code; anything else answers 200
const srv = createServer((req, res) => {
  req.resume().on('end', () => {
    const k = Object.keys(status).find((s) => req.url?.endsWith(s));
    res.statusCode = k ? status[k] : 200; res.end(res.statusCode === 200 ? '{"ok":true}' : '{"ok":false,"description":"Unauthorized"}');
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-notify-log-'));
const CHANNELS = { DISCORD_WEBHOOK_URL: `${base}/discord/SECRET-HOOK`, WEBHOOK_URL: `${base}/hook`, TELEGRAM_BOT_TOKEN: '123:SECRET', TELEGRAM_CHAT_ID: '4242', TELEGRAM_API: base };
process.env.REELMIMIC_PROJECTS = TMP;
for (const k of Object.keys(CHANNELS)) delete process.env[k];
const J = await import('./jobs.ts');
const N = await import('./notify.ts');
after(() => { srv.close(); rmSync(TMP, { recursive: true, force: true }); });

J.createJob({ id: 'p1', title: 'Lantern Walk', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
const entries = () => (J.load('p1').log || []).filter((e) => e.type === 'notify') as (NotifyMarker & { ts: string })[];
const pick = ({ channel, event, ok, detail }: NotifyMarker) => ({ channel, event, ok, detail });
let seen = 0;
const fresh = () => { const all = entries(), out = all.slice(seen); seen = all.length; return out.map(pick).sort((a, b) => a.channel.localeCompare(b.channel)); };
beforeEach(() => { for (const k of Object.keys(status)) delete status[k]; });

test('no channel configured: the notifier is off and nothing is logged', async () => {
  assert.equal(N.startNotifier(), null);
  await N.sendLogged(J.load('p1'), 'plan_ready');
  assert.deepEqual(fresh(), []);
});

test('every channel that worked gets an ok entry', async () => {
  Object.assign(process.env, CHANNELS);
  await N.sendLogged(J.load('p1'), 'plan_ready');
  assert.deepEqual(fresh(), [
    { channel: 'Discord', event: 'plan_ready', ok: true, detail: undefined },
    { channel: 'Telegram', event: 'plan_ready', ok: true, detail: undefined },
    { channel: 'webhook', event: 'plan_ready', ok: true, detail: undefined },
  ]);
});

test('a 401 from Telegram is logged with its status, the others still ok', async () => {
  status['/sendMessage'] = 401;
  await N.sendLogged(J.load('p1'), 'needs_input');
  assert.deepEqual(fresh().find((e) => e.channel === 'Telegram'), { channel: 'Telegram', event: 'needs_input', ok: false, detail: '401 Unauthorized' });
  assert.equal(entries().filter((e) => e.event === 'needs_input' && e.ok).length, 2);
});

test('a failed video upload and the text that replaced it are both logged', async () => {
  mkdirSync(join(J.dirOf('p1'), 'out'), { recursive: true });
  writeFileSync(join(J.dirOf('p1'), 'out', 'video.mp4'), 'fake mp4 bytes');
  status['/sendVideo'] = 413;
  await N.sendLogged(J.load('p1'), 'done');
  const tg = fresh().filter((e) => e.channel.startsWith('Telegram'));
  assert.deepEqual(tg, [
    { channel: 'Telegram', event: 'done', ok: true, detail: undefined },
    { channel: 'Telegram video', event: 'done', ok: false, detail: '413 Payload Too Large' },
  ]);
});

test('an unreachable or malformed URL is logged without the URL or the token', async () => {
  const gone = createServer();   // a port nothing listens on any more
  await new Promise<void>((r) => gone.listen(0, '127.0.0.1', r));
  const port = (gone.address() as AddressInfo).port;
  await new Promise((r) => gone.close(r));
  process.env.WEBHOOK_URL = `http://127.0.0.1:${port}/hook`;
  process.env.TELEGRAM_API = 'not a url';   // "Failed to parse URL from not a url/bot123:SECRET/sendMessage"
  await N.sendLogged(J.load('p1'), 'error');
  const got = fresh();
  assert.match(got.find((e) => e.channel === 'webhook')!.detail!, /^fetch failed: connect ECONNREFUSED/);
  assert.match(got.find((e) => e.channel === 'Telegram')!.detail!, /^Failed to parse URL from …: Invalid URL$/);
  const all = JSON.stringify(entries());
  for (const secret of ['SECRET', 'http', '/hook', '/bot']) assert.ok(!all.includes(secret), secret);
});

test('the notifier writes them on a stage change', async () => {
  Object.assign(process.env, CHANNELS);
  const stop = N.startNotifier()!;
  try {
    const job = { ...J.load('p1'), stage: 'plan_review' as const };
    writeFileSync(join(J.dirOf('p1'), 'job.json'), JSON.stringify(job));
    J.bus.emit('job', 'p1', { type: 'job', job });
    for (let i = 0; i < 50 && entries().length < seen + 3; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(fresh().map((e) => `${e.channel} ${e.ok}`), ['Discord true', 'Telegram true', 'webhook true']);
  } finally { stop(); }
});
