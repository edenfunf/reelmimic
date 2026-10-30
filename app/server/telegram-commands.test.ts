// Telegram commands: a local HTTP server stands in for the Bot API. getUpdates serves every queued update from `offset` on,
// like Telegram does, so a poller that forgot to advance it would answer the same message twice.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Job } from '../shared/types.ts';

const updates: { update_id: number; message: { chat: { id: number }; text: string } }[] = [];
let nextId = 1, conflict = false;
let sent: string[] = [], polls: number[] = [], menus = 0;
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d)).on('end', () => {
    const m = req.url?.split('/').pop(), b = JSON.parse(body || '{}');
    const answer = (result: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(code === 200 ? { ok: true, result } : { ok: false, error_code: code, description: 'Conflict' })); };
    if (m === 'sendMessage') { sent.push(b.text); return answer({}); }
    if (m === 'setMyCommands') { menus++; return answer(true); }
    if (m !== 'getUpdates') return answer(null, 404);
    polls.push(b.offset);
    if (conflict) return answer(null, 409);
    const due = updates.filter((u) => u.update_id >= b.offset);
    setTimeout(() => answer(due), due.length ? 0 : 20);   // a short "long poll" so tests don't spin
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-tgcmd-'));
Object.assign(process.env, { REELMIMIC_PROJECTS: TMP, TELEGRAM_BOT_TOKEN: '123:SECRET', TELEGRAM_CHAT_ID: '4242', TELEGRAM_COMMANDS: '1', TELEGRAM_API: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, REELMIMIC_URL: 'https://studio.example' });
const J = await import('./jobs.ts');
const C = await import('./telegram-commands.ts');

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();
function project(id: string, title: string, minutes: number, extra: Partial<Job>) {
  J.createJob({ id, title: 'brief line', agent: 'claude', brief: '', reference: { type: 'url', src: 'x' }, lang: 'en' });
  writeFileSync(join(J.dirOf(id), 'plan.json'), JSON.stringify({ title }));
  writeFileSync(join(J.dirOf(id), 'job.json'), JSON.stringify({ ...J.load(id), updatedAt: minsAgo(minutes), ...extra }));
}
project('p1', 'Lantern Walk', 5, { stage: 'needs_input', needs: [{ issue: 'Confirm the lyric at 53.8 s', from: 'critic', at: '' }] });
project('p2', 'Night Market', 180, { stage: 'done' });
project('p3', 'Rainy Tram', 2 * 1440, { stage: 'error', error: 'ffmpeg exited with code 1' });

let stop = C.startCommands();
after(async () => { await stop?.(); srv.close(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(() => { sent = []; });

const wait = async (ok: () => boolean) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
const push = (text: string, chat = 4242) => updates.push({ update_id: nextId++, message: { chat: { id: chat }, text } });
async function ask(text: string) { push(text); await wait(() => sent.length > 0); assert.equal(sent.length, 1, `one reply to ${text}`); return sent[0]; }

test('starts polling and sets the command menu', async () => {
  assert.ok(stop);
  await wait(() => menus >= 2);
  assert.equal(menus, 2);   // the default menu and the Chinese one
});

test('/list: numbered, newest first, with stage and age', async () => {
  assert.equal(await ask('/list'), '1. Lantern Walk · Needs you · 5 min ago\n2. Night Market · Done · 3 h ago\n3. Rainy Tram · Stopped · 2 d ago\n\n/status 1 for details.');
});

test('/status without an argument: the latest project, what it needs, and the link', async () => {
  assert.equal(await ask('/status'), 'Lantern Walk\n\nNeeds you · 5 min ago\n\nNeeds from you:\n- Confirm the lyric at 53.8 s\n\nhttps://studio.example/#/p/p1');
});

test('/status by number, by part of a title, and with the @bot suffix groups add', async () => {
  assert.match(await ask('/status 3'), /^Rainy Tram\n\nStopped · 2 d ago\n\nError: ffmpeg exited with code 1\n\nhttps:\/\/studio\.example\/#\/p\/p3$/);
  sent = [];
  assert.match(await ask('/STATUS market'), /^Night Market\n\nDone · 3 h ago\n\nhttps:\/\/studio\.example\/#\/p\/p2$/);
  sent = [];
  assert.match(await ask('/status@MyBot 1'), /^Lantern Walk\n/);
  sent = [];
  assert.match(await ask('/status nothing-like-this'), /No project matches "nothing-like-this"/);
});

test('/help, /start and an unknown command', async () => {
  assert.match(await ask('/help'), /^Ask how your videos are doing:\n\/list/);
  sent = [];
  assert.match(await ask('/start'), /^Ask how your videos are doing/);
  sent = [];
  assert.equal(await ask('/approve 1'), 'Unknown command. /help lists what I can do.');
});

test('another chat and plain text get no answer', async () => {
  push('/list', 999); push('hello');
  await wait(() => polls.at(-1) === nextId);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(sent, []);
});

test('the offset advances, so an update is handled once', async () => {
  await ask('/list');
  const before = polls.length;
  await wait(() => polls.length > before + 3);
  assert.equal(sent.length, 1);
  assert.equal(polls.at(-1), nextId);
});

test('409 (a webhook is set): one clear log line, then polling stops', async () => {
  await stop?.();
  conflict = true; polls = [];
  const logged: string[] = [], orig = console.error;
  console.error = (...a: unknown[]) => { logged.push(a.join(' ')); };
  try {
    stop = C.startCommands();
    await wait(() => logged.length > 0);
    await new Promise((r) => setTimeout(r, 100));
  } finally { console.error = orig; }
  assert.equal(polls.length, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /webhook/);
  assert.doesNotMatch(logged[0], /SECRET/);
});
