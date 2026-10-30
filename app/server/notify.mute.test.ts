// A muted project sends nothing; other projects still do, and unmuting doesn't replay what happened while muted.
// Same setup as notify.test.ts: a local HTTP server stands in for the webhook, projects live in a throwaway folder.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

let hits: { path: string; body: string }[] = [];
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => { hits.push({ path: req.url || '', body }); res.end('ok'); });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-mute-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, WEBHOOK_URL: `${base}/hook` });
for (const k of ['DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_API']) delete process.env[k];
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

const stop = N.startNotifier()!;
after(() => { stop(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { hits = []; });

const make = (id: string) => J.createJob({ id, title: id, agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
make('quiet'); make('loud');
J.setMuted('quiet', true);
// what the job machine does: change the stage on disk, which emits the job on the bus
const moveTo = (id: string, stage: Stage, extra: Partial<Job> = {}) => J.bus.emit('job', id, { type: 'job', job: { ...J.load(id), stage, ...extra } });
const settle = async (n: number) => { for (let i = 0; i < 25 && hits.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 50)); };
const ids = () => hits.map((h) => JSON.parse(h.body).id as string);

test('setMuted saves to job.json, and false removes the field', () => {
  assert.equal(JSON.parse(readFileSync(join(J.dirOf('quiet'), 'job.json'), 'utf8')).muted, true);
  make('tmp');
  assert.equal(J.setMuted('tmp', true).job.muted, true);
  J.setMuted('tmp', false);
  assert.equal('muted' in JSON.parse(readFileSync(join(J.dirOf('tmp'), 'job.json'), 'utf8')), false);
});

test('setMuted only takes a boolean', () => {
  for (const bad of [undefined, null, 'true', 1, {}]) assert.throws(() => J.setMuted('loud', bad), /true or false/);
  assert.equal(J.load('loud').muted, undefined);
});

test('a muted project sends nothing on plan ready, done or error; another project still does', async () => {
  for (const stage of ['plan_review', 'done'] as Stage[]) { moveTo('quiet', stage); moveTo('loud', stage); }
  moveTo('quiet', 'error', { error: 'boom' });
  await settle(2);
  assert.deepEqual(ids(), ['loud', 'loud']);
});

test('unmuting does not replay a stage reached while muted; the next change notifies', async () => {
  moveTo('quiet', 'needs_input');
  await settle(1);
  J.setMuted('quiet', false);   // saves the job (same stage) through the bus
  await settle(1);
  assert.equal(hits.length, 0);
  moveTo('quiet', 'done');
  await settle(1);
  assert.deepEqual(ids(), ['quiet']);
});
