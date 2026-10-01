// Notifications go out on stage changes only, once each, to Discord (video attached when done) and a plain webhook.
// A local HTTP server stands in for both; projects live in a throwaway folder.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

type Hit = { path: string; type: string; body: string };
let hits: Hit[] = [];
const srv = createServer((req, res) => {
  let body = '';
  req.setEncoding('latin1');
  req.on('data', (d) => (body += d)).on('end', () => { hits.push({ path: req.url || '', type: req.headers['content-type'] || '', body }); res.end('ok'); });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-notify-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, DISCORD_WEBHOOK_URL: `${base}/discord`, WEBHOOK_URL: `${base}/hook`, REELMIMIC_URL: 'https://studio.example/' });
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

// a project that was already finished before the notifier started: must not be re-announced
J.createJob({ id: 'old', title: 'old one', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' } });
writeFileSync(join(J.dirOf('old'), 'job.json'), JSON.stringify({ ...J.load('old'), stage: 'done' }));

const stop = N.startNotifier()!;
after(() => { stop(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { hits = []; });

J.createJob({ id: 'p1', title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
writeFileSync(join(J.dirOf('p1'), 'plan.json'), JSON.stringify({ title: 'Lantern Walk' }));
const moveTo = (stage: Stage, extra: Partial<Job> = {}, id = 'p1') => J.bus.emit('job', id, { type: 'job', job: { ...J.load(id), stage, ...extra } });
const settle = async (n: number) => { for (let i = 0; i < 25 && hits.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 50)); };

test('plan ready: one Discord message and one webhook call, with the plan title and a link', async () => {
  moveTo('plan_review');
  await settle(2);
  assert.equal(hits.length, 2);
  const discord = JSON.parse(hits.find((h) => h.path === '/discord')!.body), hook = JSON.parse(hits.find((h) => h.path === '/hook')!.body);
  assert.match(discord.content, /The plan for "Lantern Walk" is ready/);
  assert.match(discord.content, /https:\/\/studio\.example\/#\/p\/p1$/);
  assert.deepEqual({ ...hook, message: undefined }, { event: 'plan_ready', id: 'p1', title: 'Lantern Walk', stage: 'plan_review', message: undefined, url: 'https://studio.example/#/p/p1' });
});

test('the same stage again sends nothing', async () => {
  moveTo('plan_review');
  await settle(1);
  assert.equal(hits.length, 0);
});

test('working stages send nothing', async () => {
  moveTo('producing');
  moveTo('critiquing');
  await settle(1);
  assert.equal(hits.length, 0);
});

test('needs input lists what is needed', async () => {
  moveTo('needs_input', { needs: [{ issue: 'Confirm the lyric at 53.8 s', from: 'critic', at: '' }] });
  await settle(2);
  assert.match(JSON.parse(hits.find((h) => h.path === '/discord')!.body).content, /needs you:\n- Confirm the lyric at 53\.8 s/);
});

test('done: the video is attached to the Discord message when it is small enough', async () => {
  mkdirSync(join(J.dirOf('p1'), 'out'), { recursive: true });
  writeFileSync(join(J.dirOf('p1'), 'out', 'video.mp4'), 'fake mp4 bytes');
  moveTo('done');
  await settle(2);
  const d = hits.find((h) => h.path === '/discord')!;
  assert.match(d.type, /^multipart\/form-data/);
  assert.match(d.body, /filename="video\.mp4"/);
  assert.match(d.body, /fake mp4 bytes/);
  assert.match(d.body, /"content":"\\"Lantern Walk\\" is done\./);
});

test('an error sends its message; a cancel does not', async () => {
  moveTo('error', { error: 'Missing output: out/video.mp4' });
  await settle(2);
  assert.match(JSON.parse(hits[0].body).message ?? JSON.parse(hits[0].body).content, /Missing output: out\/video\.mp4/);
  hits = [];
  moveTo('producing');
  moveTo('error', { error: 'Cancelled' });
  await settle(1);
  assert.equal(hits.length, 0);
});

test('Chinese projects get Chinese messages', () => {
  const job = { ...J.load('old'), lang: 'zh-TW' as const };
  assert.equal(N.messageOf(job, 'done', '燈籠回家路'), '「燈籠回家路」完成了。');
});

test('a project finished before the server started is not re-announced', async () => {
  moveTo('done', {}, 'old');
  await settle(1);
  assert.equal(hits.length, 0);
});
