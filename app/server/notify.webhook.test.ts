// WEBHOOK_URL: a body a Slack incoming webhook accepts (it needs `text`), the details a bot needs, and the optional
// WEBHOOK_SECRET signature. A local HTTP server is the receiver; only the webhook is configured.
import { after, afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job, Stage } from '../shared/types.ts';

let hits: { headers: IncomingHttpHeaders; raw: string }[] = [];
const srv = createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (d) => (raw += d)).on('end', () => { hits.push({ headers: req.headers, raw }); res.end('ok'); });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-webhook-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, WEBHOOK_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, REELMIMIC_URL: 'https://studio.example' });
for (const k of ['DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_SECRET']) delete process.env[k];
const J = await import('./jobs.ts');
const N = await import('./notify.ts');

const stop = N.startNotifier()!;
after(() => { stop(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { hits = []; });
afterEach(() => { delete process.env.WEBHOOK_SECRET; });

J.createJob({ id: 'w1', title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
writeFileSync(join(J.dirOf('w1'), 'plan.json'), JSON.stringify({ title: 'Lantern Walk' }));
const moveTo = (stage: Stage, extra: Partial<Job> = {}) => J.bus.emit('job', 'w1', { type: 'job', job: { ...J.load('w1'), stage, ...extra } });
const next = async () => { for (let i = 0; i < 50 && !hits.length; i++) await new Promise((r) => setTimeout(r, 20)); const h = hits.shift()!; return { ...h, body: JSON.parse(h.raw) }; };

// what a receiver would do with WEBHOOK_SECRET
const verify = (secret: string, h: IncomingHttpHeaders, raw: string) => {
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${h['x-reelmimic-timestamp']}.${raw}`).digest('hex')}`);
  const got = Buffer.from(String(h['x-reelmimic-signature'] || ''));
  return got.length === want.length && timingSafeEqual(got, want);
};

test('the body has the `text` a Slack incoming webhook needs: the message and the link', async () => {
  moveTo('plan_review');
  const { body } = await next();
  assert.equal(body.text, 'The plan for "Lantern Walk" is ready. Take a look and approve it to start production.\nhttps://studio.example/#/p/w1');
  assert.equal(body.message, 'The plan for "Lantern Walk" is ready. Take a look and approve it to start production.');
  assert.equal(body.url, 'https://studio.example/#/p/w1');
});

test('needs come as a list, with the project language', async () => {
  moveTo('needs_input', { needs: [{ issue: 'Confirm the lyric at 53.8 s', from: 'critic', at: '' }, { issue: 'Pick a voice', from: 'critic', at: '' }] });
  const { body } = await next();
  assert.deepEqual(body.needs, ['Confirm the lyric at 53.8 s', 'Pick a voice']);
  assert.equal(body.lang, 'en');
  assert.equal(body.error, null);
});

test('an error carries the error text on its own', async () => {
  moveTo('error', { error: 'Missing output: out/video.mp4' });
  const { body } = await next();
  assert.equal(body.event, 'error');
  assert.equal(body.error, 'Missing output: out/video.mp4');
});

test('without WEBHOOK_SECRET nothing is signed', async () => {
  moveTo('producing'); moveTo('done');
  const { headers } = await next();
  assert.equal(headers['x-reelmimic-signature'], undefined);
  assert.equal(headers['x-reelmimic-timestamp'], undefined);
});

test('with WEBHOOK_SECRET the receiver can check the signature over the raw body', async () => {
  process.env.WEBHOOK_SECRET = 's3cret';
  moveTo('producing'); moveTo('plan_review');
  const { headers, raw } = await next();
  assert.match(String(headers['x-reelmimic-signature']), /^sha256=[0-9a-f]{64}$/);
  assert.ok(Math.abs(Date.now() / 1000 - Number(headers['x-reelmimic-timestamp'])) < 30);
  assert.ok(verify('s3cret', headers, raw));
  assert.ok(!verify('wrong', headers, raw));
  assert.ok(!verify('s3cret', headers, raw.replace('Lantern', 'Lanterns')));   // a changed body no longer matches
});

test('webhookSignature is the documented HMAC', () => {
  assert.equal(N.webhookSignature('k', 1700000000, '{}'), `sha256=${createHmac('sha256', 'k').update('1700000000.{}').digest('hex')}`);
});
