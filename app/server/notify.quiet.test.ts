// NOTIFY_EVENTS and NOTIFY_QUIET_HOURS. Only the plain webhook is configured; the clock is set by each test.
import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

let hits: { event: string; id: string }[] = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => { hits.push(JSON.parse(body)); res.end('ok'); });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-quiet-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, WEBHOOK_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook` });
for (const k of ['DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NOTIFY_EVENTS', 'NOTIFY_QUIET_HOURS']) delete process.env[k];
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

for (const id of ['q1', 'q2']) J.createJob({ id, title: id, agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
// the stage is saved to job.json too, since the end of the quiet hours re-reads it
const moveTo = (stage: Stage, id = 'q1', extra: Partial<Job> = {}) => { const job = { ...J.load(id), stage, ...extra }; writeFileSync(join(J.dirOf(id), 'job.json'), JSON.stringify(job)); J.bus.emit('job', id, { type: 'job', job }); };
const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m);

let now = at(12), stop: (() => void) | null = null;
const start = (env: Record<string, string>) => { Object.assign(process.env, env); stop = N.startNotifier({ clock: () => now, tickMs: 20 }); };
const quiet = console.error;
beforeEach(() => { hits = []; now = at(12); for (const id of ['q1', 'q2']) moveTo('producing', id); });
afterEach(() => { stop?.(); stop = null; console.error = quiet; delete process.env.NOTIFY_EVENTS; delete process.env.NOTIFY_QUIET_HOURS; });
after(() => { srv.close(); rmSync(TMP, { recursive: true, force: true }); });

test('quiet hours: plain ranges, ranges past midnight, minutes', () => {
  assert.deepEqual(N.quietHours('23-8'), [23 * 60, 8 * 60]);
  assert.deepEqual(N.quietHours('22:30 - 7:15'), [22 * 60 + 30, 7 * 60 + 15]);
  assert.equal(N.quietHours(''), null);
  assert.equal(N.quietHours('8-8'), null);
  const night = N.quietHours('23-8'), lunch = N.quietHours('12-13:30');
  assert.ok(N.isQuiet(night, at(23)) && N.isQuiet(night, at(2)) && N.isQuiet(night, at(7, 59)));
  assert.ok(!N.isQuiet(night, at(8)) && !N.isQuiet(night, at(22, 59)));
  assert.ok(N.isQuiet(lunch, at(13, 29)) && !N.isQuiet(lunch, at(13, 30)) && !N.isQuiet(lunch, at(11)));
});

test('unreadable settings are reported and fall back to the defaults', () => {
  const logged: string[] = []; console.error = (m: string) => { logged.push(m); };
  assert.equal(N.quietHours('night'), null);
  assert.equal(N.quietHours('25-8'), null);
  assert.deepEqual([...N.eventFilter('done, bogus')], ['done']);
  assert.equal(N.eventFilter('bogus').size, 4);
  assert.equal(logged.length, 4);
});

test('NOTIFY_EVENTS: only the listed events are sent', async () => {
  start({ NOTIFY_EVENTS: 'done,error' });
  moveTo('plan_review'); moveTo('needs_input', 'q2');
  await settle();
  assert.equal(hits.length, 0);
  moveTo('done');
  await settle();
  assert.deepEqual(hits.map((h) => h.event), ['done']);
});

test('during quiet hours messages wait, errors do not', async () => {
  now = at(2);
  start({ NOTIFY_QUIET_HOURS: '23-8' });
  moveTo('plan_review');
  moveTo('error', 'q2', { error: 'Missing output: out/video.mp4' });
  await settle();
  assert.deepEqual(hits.map((h) => [h.event, h.id]), [['error', 'q2']]);
});

test('when the quiet hours end, the latest message of each project goes out once', async () => {
  now = at(2);
  start({ NOTIFY_QUIET_HOURS: '23-8' });
  moveTo('needs_input'); moveTo('producing'); moveTo('done');   // q1: only "done" is still worth telling
  moveTo('plan_review', 'q2');
  await settle();
  assert.equal(hits.length, 0);
  now = at(8);
  await settle();
  assert.deepEqual(hits.map((h) => [h.event, h.id]).sort(), [['done', 'q1'], ['plan_ready', 'q2']]);
  hits = [];
  await settle();
  assert.equal(hits.length, 0);
});

test('a held message that no longer applies is dropped', async () => {
  now = at(2);
  start({ NOTIFY_QUIET_HOURS: '23-8' });
  moveTo('plan_review');
  await settle();
  writeFileSync(join(J.dirOf('q1'), 'job.json'), JSON.stringify({ ...J.load('q1'), stage: 'producing' }));   // approved on the web page meanwhile
  now = at(9);
  await settle();
  assert.equal(hits.length, 0);
});

test('outside the quiet hours everything goes straight out', async () => {
  start({ NOTIFY_QUIET_HOURS: '23-8' });
  moveTo('plan_review');
  await settle();
  assert.deepEqual(hits.map((h) => h.event), ['plan_ready']);
});
