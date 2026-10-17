// A finished video that can't be uploaded (rejected, server error, too slow) must still send the "done" message as text,
// on Discord and Telegram alike. A local HTTP server stands in for both; timeouts are shortened with NOTIFY_TIMEOUT_MS.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

type Hit = { path: string; multipart: boolean; body: string };
let hits: Hit[] = [];
let upload: number | 'slow' = 200;   // how the server answers a multipart (video) request
const srv = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (d) => (body += d)).on('end', () => {
    const multipart = /^multipart\/form-data/.test(req.headers['content-type'] || '');
    hits.push({ path: req.url || '', multipart, body });
    const answer = (code: number) => { if (!res.writableEnded) { res.statusCode = code; res.end(code === 200 ? '{"ok":true}' : '{"ok":false}'); } };
    if (!multipart) return answer(200);
    if (upload === 'slow') setTimeout(() => answer(200), 1500); else answer(upload);
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-upload-'));
Object.assign(process.env, {
  REELMIMIC_PROJECTS: TMP, REELMIMIC_URL: 'https://studio.example', NOTIFY_TIMEOUT_MS: '150',
  DISCORD_WEBHOOK_URL: `${base}/discord`, TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '7', TELEGRAM_API: base,
});
delete process.env.WEBHOOK_URL;
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

const stop = N.startNotifier()!;
const quiet = console.error;
after(() => { stop(); console.error = quiet; srv.closeAllConnections(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { hits = []; upload = 200; console.error = () => {}; });   // the failures below are logged on purpose

J.createJob({ id: 'u1', title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
writeFileSync(join(J.dirOf('u1'), 'plan.json'), JSON.stringify({ title: 'Lantern Walk' }));
mkdirSync(join(J.dirOf('u1'), 'out'), { recursive: true });
writeFileSync(join(J.dirOf('u1'), 'out', 'video.mp4'), 'fake mp4 bytes');
const moveTo = (stage: Stage, extra: Partial<Job> = {}) => J.bus.emit('job', 'u1', { type: 'job', job: { ...J.load('u1'), stage, ...extra } });
const settle = async (n: number) => { for (let i = 0; i < 150 && hits.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 80)); };
const finish = async (n: number) => { moveTo('producing'); moveTo('done'); await settle(n); };
const text = (path: string) => hits.filter((h) => h.path === path && !h.multipart);

test('the upload timeout grows with the file', () => {
  assert.equal(N.uploadTimeout(0), 150);
  assert.ok(N.uploadTimeout(10 * 1024 ** 2) > N.uploadTimeout(1024 ** 2));
  assert.equal(N.uploadTimeout(6 * 1024 ** 2), 300);   // with the real 60 s base: 60 s + 10 s per MB
});

test('uploads that go through send no extra text message', async () => {
  await finish(2);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.multipart));
});

test('Discord rejects the video (413): the message still goes out as text', async () => {
  upload = 413;
  await finish(4);
  const d = text('/discord');
  assert.equal(d.length, 1);
  assert.match(JSON.parse(d[0].body).content, /"Lantern Walk" is done\.\nhttps:\/\/studio\.example\/#\/p\/u1/);
});

test('a server error on the upload falls back to text on both channels', async () => {
  upload = 500;
  await finish(4);
  assert.equal(text('/discord').length, 1);
  assert.equal(text('/bot1:T/sendMessage').length, 1);
});

test('an upload that is too slow times out and falls back to text, once per channel', async () => {
  upload = 'slow';
  await finish(4);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(hits.filter((h) => !h.multipart).map((h) => h.path).sort(), ['/bot1:T/sendMessage', '/discord']);
});

test('a message without a video never uploads, whatever the upload setting', async () => {
  upload = 413;
  moveTo('plan_review');
  await settle(2);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => !h.multipart));
});
