// ntfy notifications: a local HTTP server stands in for the topic URL (NTFY_URL); only ntfy is configured here.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

type Hit = { method: string; path: string; h: IncomingHttpHeaders; body: string };
let hits: Hit[] = [], status = 200, putStatus = 200;
const srv = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (d) => (body += d)).on('end', () => {
    hits.push({ method: req.method || '', path: req.url || '', h: req.headers, body });
    const code = req.method === 'PUT' && putStatus !== 200 ? putStatus : status;
    res.statusCode = code; res.end(code === 200 ? '{"id":"x"}' : `{"code":${code}01,"http":${code},"error":"nope"}`);
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-ntfy-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, NTFY_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/reel-topic`, NTFY_TOKEN: 'tk_SECRET', REELMIMIC_URL: 'https://studio.example' });
delete process.env.DISCORD_WEBHOOK_URL; delete process.env.WEBHOOK_URL; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.NTFY_ATTACH_MB;
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

const stop = N.startNotifier();
after(() => { stop?.(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { hits = []; status = 200; putStatus = 200; });

J.createJob({ id: 'n1', title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
writeFileSync(join(J.dirOf('n1'), 'plan.json'), JSON.stringify({ title: 'Lantern Walk' }));
J.createJob({ id: 'n2', title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'zh-TW' });
writeFileSync(join(J.dirOf('n2'), 'plan.json'), JSON.stringify({ title: '夜市燈籠' }));
const moveTo = (id: string, stage: Stage, extra: Partial<Job> = {}) => J.bus.emit('job', id, { type: 'job', job: { ...J.load(id), stage, ...extra } });
const settle = async (n: number) => { for (let i = 0; i < 25 && hits.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 50)); };
const quiet = async <T>(fn: () => Promise<T>) => { const orig = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };
// what ntfy does with an RFC 2047 header: one encoded word back to UTF-8
const decode = (v = '') => v.replace(/^=\?UTF-8\?B\?(.*)\?=$/, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
const video = join(J.dirOf('n1'), 'out', 'video.mp4');

test('ntfy alone turns the notifier on', () => assert.ok(stop));

test('plan ready: the text is POSTed to the topic with title, tags, link and the token', async () => {
  moveTo('n1', 'plan_review');
  await settle(1);
  assert.equal(hits.length, 1);
  const { method, path, h, body } = hits[0];
  assert.equal(method, 'POST'); assert.equal(path, '/reel-topic');
  assert.equal(body, 'The plan for "Lantern Walk" is ready. Take a look and approve it to start production.');
  assert.equal(h.title, 'Lantern Walk'); assert.equal(h.tags, 'memo'); assert.equal(h.priority, undefined);
  assert.equal(h.click, 'https://studio.example/#/p/n1');
  assert.equal(h.authorization, 'Bearer tk_SECRET');
});

test('needs input and error are high priority, each with its own tag', async () => {
  moveTo('n1', 'needs_input', { needs: [{ issue: 'Confirm the lyric at 53.8 s', from: 'critic', at: '' }] });
  await settle(1);
  moveTo('n1', 'error', { error: 'Missing output: out/video.mp4' });
  await settle(2);
  assert.deepEqual(hits.map((x) => [x.h.tags, x.h.priority]), [['pause_button', 'high'], ['warning', 'high']]);
  assert.match(hits[0].body, /needs you:\n- Confirm the lyric at 53\.8 s/);
});

test('a Chinese title is RFC 2047 encoded and decodes back', async () => {
  moveTo('n2', 'plan_review');
  await settle(1);
  assert.match(hits[0].h.title as string, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(decode(hits[0].h.title as string), '夜市燈籠');
  assert.match(hits[0].body, /「夜市燈籠」的企劃好了/);
});

test('done: a small video is PUT as an attachment, the text in the Message header', async () => {
  mkdirSync(join(J.dirOf('n1'), 'out'), { recursive: true });
  writeFileSync(video, 'fake mp4 bytes');
  moveTo('n1', 'done');
  await settle(1);
  assert.equal(hits.length, 1);
  const { method, h, body } = hits[0];
  assert.equal(method, 'PUT'); assert.equal(body, 'fake mp4 bytes');
  assert.equal(h.filename, 'video.mp4'); assert.equal(decode(h.message as string), '"Lantern Walk" is done.');
  assert.equal(h.tags, 'white_check_mark'); assert.equal(h.authorization, 'Bearer tk_SECRET');
});

test('done: if the server refuses the file, the message still goes out as text', async () => {
  putStatus = 413;
  await quiet(async () => { moveTo('n1', 'producing'); moveTo('n1', 'done'); await settle(2); });
  assert.deepEqual(hits.map((x) => x.method), ['PUT', 'POST']);
  assert.equal(hits[1].body, '"Lantern Walk" is done.');
  assert.equal(hits[1].h.filename, undefined);
});

test('done: a video over NTFY_ATTACH_MB (default 15) sends just the text', async () => {
  truncateSync(video, 16 * 1024 ** 2);   // sparse file, nothing is read
  moveTo('n1', 'producing'); moveTo('n1', 'done');
  await settle(1);
  assert.deepEqual(hits.map((x) => x.method), ['POST']);
  assert.equal(hits[0].body, '"Lantern Walk" is done.');
});

test('an error answer is logged without the token or the topic', async () => {
  status = 403;
  const logged: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try { moveTo('n1', 'plan_review'); await settle(1); await new Promise((r) => setTimeout(r, 50)); }
  finally { console.error = orig; }
  assert.equal(hits.length, 1);
  assert.match(logged.join('\n'), /ntfy answered 403/);
  assert.doesNotMatch(logged.join('\n'), /SECRET|reel-topic/);
});
