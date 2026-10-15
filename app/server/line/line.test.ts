// The LINE bot without LINE: fetch is mocked, so every reply and push the bot would send is captured here instead.
// Runs against a throwaway projects folder and state file, never the real ones. No agent is started.
import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../../shared/types.ts';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-line-'));
process.env.REELMIMIC_PROJECTS = join(TMP, 'projects');
process.env.LINE_RETRY_MS = '1';
delete process.env.REELMIMIC_URL;
const J = await import('../jobs.ts');
const { createBot, lineConfig, startNotifier } = await import('./index.ts');
const { Store, CODE_TRIES, CODE_TTL_MS } = await import('./store.ts');
const { parse } = await import('./commands.ts');
const { push, quick, verifySignature, text } = await import('./client.ts');
const { ago } = await import('./progress.ts');
type LineEvent = import('./index.ts').LineEvent;
after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------- fake LINE API ----------
interface Sent { path: string; body: { replyToken?: string; to?: string; messages: { text: string; quickReply?: { items: { action: { label: string; text: string } }[] } }[] }; headers: Record<string, string> }
let sent: Sent[] = [];
let answer = (): Response => new Response('{}', { status: 200 });
mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
  sent.push({ path: new URL(url).pathname.replace('/v2/bot', ''), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
  return answer();
});
beforeEach(() => { sent = []; answer = () => new Response('{}', { status: 200 }); });
const replies = () => sent.filter((s) => s.path === '/message/reply').map((s) => s.body.messages.map((m) => m.text).join('\n---\n'));
const pushes = () => sent.filter((s) => s.path === '/message/push');

// ---------- helpers ----------
const CFG = { secret: 'test-secret', token: 'test-token', port: 0 };
let n = 0;
const newStore = (allowed = '') => new Store(join(TMP, `line-${++n}.json`), allowed);
const say = (userId: string, said: string, extra: Partial<LineEvent> = {}): LineEvent =>
  ({ type: 'message', mode: 'active', webhookEventId: `ev-${++n}`, replyToken: `rt-${n}`, source: { type: 'user', userId }, message: { type: 'text', text: said }, ...extra });
const link = (store: InstanceType<typeof Store>, id: string, lang: 'zh' | 'en' = 'zh') => assert.equal(store.pair(id, store.newCode().code, lang), 'ok');
const linked = (lang: 'zh' | 'en' = 'zh') => { const store = newStore(), bot = createBot(CFG, store), id = `U${++n}`; link(store, id, lang); return { bot, store, id }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newJob = (title: string, patch: Partial<Job> = {}) => {
  const { id } = J.createJob({ id: `line-${++n}`, title, agent: 'claude', brief: title, reference: { type: 'url', src: 'https://example.com/v' } });
  if (Object.keys(patch).length) setJob(id, patch);
  return id;
};
const setJob = (id: string, patch: Partial<Job>) => { writeFileSync(join(J.dirOf(id), 'job.json'), JSON.stringify({ ...J.load(id), ...patch })); J.touch(id); };   // touch = save + bus event, as a real stage change
const sign = (body: string, secret = CFG.secret) => createHmac('sha256', secret).update(body).digest('base64');

describe('webhook signature', () => {
  const body = Buffer.from('{"events":[]}');
  test('accepts LINE\'s signature and nothing else', () => {
    assert.equal(verifySignature(CFG.secret, body, sign(body.toString())), true);
    assert.equal(verifySignature(CFG.secret, Buffer.from('{"events":[1]}'), sign(body.toString())), false);
    assert.equal(verifySignature(CFG.secret, body, sign(body.toString(), 'other-secret')), false);
    assert.equal(verifySignature(CFG.secret, body, undefined), false);
    assert.equal(verifySignature(CFG.secret, body, 'not base64 at all'), false);
  });
});

describe('config', () => {
  test('needs both the secret and the token', () => {
    const err = mock.method(console, 'error', () => {});
    assert.equal(lineConfig({}), null);
    assert.equal(lineConfig({ LINE_CHANNEL_SECRET: 's' }), null);
    assert.equal(err.mock.callCount(), 1);   // half-configured: says what's missing
    err.mock.restore();
    assert.deepEqual(lineConfig({ LINE_CHANNEL_SECRET: ' s ', LINE_CHANNEL_ACCESS_TOKEN: 't' }), { secret: 's', token: 't', port: 4319 });
    assert.equal(lineConfig({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_PORT: '5000' })?.port, 5000);
    const bad = mock.method(console, 'error', () => {});
    for (const LINE_PORT of ['43l9', '99999', '0']) assert.equal(lineConfig({ LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', LINE_PORT }), null);   // off, never a crash
    bad.mock.restore();
  });
});

describe('command parsing', () => {
  const p = (s: string) => { const r = parse(s); return r && { cmd: r.cmd.names[0], args: r.args, lang: r.lang }; };
  test('Chinese commands can run into their argument; English ones need a space', () => {
    assert.deepEqual(p('進度2'), { cmd: '進度', args: '2', lang: 'zh' });
    assert.deepEqual(p('status 2'), { cmd: '進度', args: '2', lang: 'en' });
    assert.deepEqual(p('进度 2'), { cmd: '進度', args: '2', lang: 'zh' });   // Simplified works too
    assert.equal(p('listen'), null);
    assert.equal(p('hello'), null);
  });
  test('the longest alias wins, a leading slash and full-width input are fine', () => {
    assert.equal(p('解除綁定')?.cmd, '解除綁定');
    assert.deepEqual(p('綁定 123456'), { cmd: '綁定', args: '123456', lang: 'zh' });
    assert.equal(p('/list')?.cmd, '列表');
    assert.deepEqual(p('ＳＴＡＴＵＳ　２'), { cmd: '進度', args: '2', lang: 'en' });
    assert.deepEqual(p('？'), { cmd: '說明', args: '', lang: null });   // no language of its own: keep the user's
  });
});

describe('linking accounts', () => {
  test('no code until the owner asks for one; it links once and is used up; the account is saved', () => {
    const store = newStore();
    assert.equal(store.pair('Ua', '000000', 'en'), 'expired');   // a stranger can't guess while no code exists
    const { code, expiresAt } = store.newCode();
    assert.match(code, /^\d{6}$/);
    assert.ok(Date.parse(expiresAt) > Date.now());
    assert.equal(store.pair('Ua', code, 'en'), 'ok');
    assert.equal(store.pair('Ub', code, 'zh'), 'expired');
    assert.equal(store.pair('Ua', 'whatever', 'zh'), 'already');
    const again = new Store(store.path);
    assert.deepEqual({ notify: again.get('Ua')?.notify, lang: again.get('Ua')?.lang }, { notify: true, lang: 'en' });
  });
  test(`a code lasts ${CODE_TTL_MS / 60e3} minutes, ${CODE_TRIES} wrong tries burn it, and a new one replaces the old`, () => {
    const store = newStore(), t0 = Date.parse('2026-10-15T12:00:00Z');
    const first = store.newCode(t0).code;
    assert.equal(store.pair('Ux', first, 'zh', t0 + CODE_TTL_MS + 1), 'expired');
    const second = store.newCode(t0).code;
    for (let i = 1; i < CODE_TRIES; i++) assert.equal(store.pair(`Ux${i}`, 'nope', 'zh', t0), 'wrong');
    assert.equal(store.pair('Ux', 'nope', 'zh', t0), 'burned');
    assert.equal(store.pair('Ux', second, 'zh', t0), 'expired');   // even the right code is too late now
    const old = store.newCode(t0).code, latest = store.newCode(t0).code;
    if (old !== latest) assert.equal(store.pair('Uy', old, 'zh', t0), 'wrong');
    assert.equal(store.pair('Uy', latest, 'zh', t0), 'ok');
  });
  test('a failed save links nobody and still uses the code up', () => {
    const store = newStore();
    mkdirSync(`${store.path}.tmp`);   // writing the temp file fails (EISDIR)
    const err = mock.method(console, 'error', () => {});
    const { code } = store.newCode();
    assert.equal(store.pair('Uf', code, 'zh'), 'error');
    assert.equal(store.get('Uf'), null);
    assert.equal(store.pair('Ug', code, 'zh'), 'expired');
    assert.equal(err.mock.callCount(), 1);
    err.mock.restore();
  });
  test('LINE_ALLOWED_USERS need no code, and taking an ID off the list removes it even after it saved preferences', () => {
    const store = newStore('Upre1, Upre2');
    assert.ok(store.get('Upre2'));
    assert.deepEqual(store.users().map((u) => u.id), ['Upre1', 'Upre2']);
    store.set('Upre2', { lang: 'en' });   // saved to the file now
    assert.equal(new Store(store.path, 'Upre2').get('Upre2')?.lang, 'en');
    assert.equal(new Store(store.path, 'Upre1').get('Upre2'), null);
    assert.deepEqual(new Store(store.path, '').users(), []);
  });
  test('unlinking removes the account', () => {
    const store = newStore('Upre1');
    link(store, 'Uc');
    store.unpair('Uc'); store.unpair('Upre1');
    assert.equal(store.get('Uc'), null);
    assert.deepEqual(store.users(), []);
    assert.equal(new Store(store.path).get('Uc'), null);
  });
  test('a broken state file starts with no accounts instead of crashing', () => {
    const f = join(TMP, 'broken.json'); writeFileSync(f, '{ not json');
    const err = mock.method(console, 'error', () => {});
    assert.deepEqual(new Store(f).users(), []);
    err.mock.restore();
  });
});

describe('who the bot answers', () => {
  test('a stranger only learns how to link, nothing about the projects', async () => {
    newJob('Secret project');
    const store = newStore(), bot = createBot(CFG, store), { code } = store.newCode();
    await bot.handleEvents([say('Ustranger', '列表'), say('Ustranger2', 'status')]);
    const [zh, en] = replies();
    assert.match(zh, /還沒綁定/);
    assert.match(en, /isn't linked/);
    assert.doesNotMatch(zh + en, /Secret project/);
    assert.ok(!zh.includes(code) && !en.includes(code));   // the code is only on the computer
  });
  test('linking from the chat works, then commands answer', async () => {
    const store = newStore(), bot = createBot(CFG, store);
    await bot.handleEvents([say('Unew', '綁定 123456')]);
    assert.match(replies()[0], /沒有有效的配對碼[\s\S]*npm run line-code/);
    await bot.handleEvents([say('Unew', `綁定 ${store.newCode().code}`)]);
    assert.match(replies()[1], /綁定好了/);
    assert.ok(store.get('Unew'));
  });
  test('group chats, standby mode and events without a reply token are ignored', async () => {
    const { bot, id } = linked();
    await bot.handleEvents([
      say(id, '列表', { source: { type: 'group', userId: id } }),
      say(id, '列表', { mode: 'standby' }),
      say(id, '列表', { replyToken: undefined }),
    ]);
    assert.deepEqual(sent, []);
  });
  test('a redelivered event is answered once', async () => {
    const { bot, id } = linked(), ev = say(id, '說明');
    await bot.handleEvents([ev]); await bot.handleEvents([{ ...ev, replyToken: 'rt-again' }]);
    assert.equal(replies().length, 1);
  });
  test('follow, stickers, unknown text and postbacks', async () => {
    const { bot, id } = linked();
    await bot.handleEvents([
      { type: 'follow', replyToken: 'rt-f', source: { type: 'user', userId: id } },
      say(id, '', { message: { type: 'sticker' } }),
      say(id, '早安'),
      { type: 'postback', replyToken: 'rt-p', source: { type: 'user', userId: id }, postback: { data: '說明' } },
    ]);
    const r = replies();
    assert.match(r[0], /歡迎回來/);
    assert.match(r[1], /只看得懂文字/);
    assert.match(r[2], /看不懂「早安」/);
    assert.match(r[3], /可以用的指令/);
  });
  test('an English command switches the replies (and notifications) to English', async () => {
    const { bot, store, id } = linked('zh');
    await bot.handleEvents([say(id, 'help')]);
    assert.match(replies()[0], /What you can ask/);
    assert.equal(store.get(id)?.lang, 'en');
    await bot.handleEvents([say(id, '?')]);   // no language of its own: stays English
    assert.match(replies()[1], /What you can ask/);
  });
});

describe('progress', () => {
  test('list numbers the latest projects, and "進度 N" opens that one even after the order changed', async () => {
    const a = newJob('Cat bath'); await sleep(5);
    const b = newJob('Sugar MV'); await sleep(5);   // listJobs sorts by updatedAt (milliseconds)
    const { bot, id } = linked();
    await bot.handleEvents([say(id, '列表')]);
    const list = replies()[0];
    assert.match(list, /1\. Sugar MV/);
    assert.match(list, /2\. Cat bath/);
    const buttons = sent[0].body.messages[0].quickReply!.items.map((i) => i.action);
    assert.deepEqual(buttons.slice(0, 2), [{ type: 'message', label: '1. Sugar MV', text: '進度 1' }, { type: 'message', label: '2. Cat bath', text: '進度 2' }]);
    J.touch(a);   // Cat bath is now the most recent: #1 in a new list, but still #2 in the one the user saw
    await bot.handleEvents([say(id, '進度 2')]);
    assert.match(replies()[1], /🎬 Cat bath/);
    await bot.handleEvents([say(id, '進度'), say(id, `進度 ${b}`), say(id, '進度 sugar'), say(id, '進度 nothing-like-this')]);
    const [latest, byId, byName, none] = replies().slice(2);
    assert.match(latest, /🎬 Cat bath/);
    assert.match(byId, /🎬 Sugar MV/);
    assert.match(byName, /🎬 Sugar MV/);
    assert.match(none, /找不到「nothing-like-this」/);
  });
  test('production: step, characters and segments', async () => {
    const id = newJob('Line test', { stage: 'producing', pipeline: { phase: 'shots', cast: { round: 1, pass: true, chars: { hina: { state: 'passed', round: 1 } } },
      chunks: { A: { state: 'passed', round: 1 }, B: { state: 'reviewing', round: 1 }, C: { state: 'queued', round: 0 } } } });
    const { bot, id: user } = linked();
    await bot.handleEvents([say(user, `進度 ${id}`), say(user, `status ${id}`)]);
    const [zh, en] = replies();
    assert.match(zh, /⏳ 生產中/);
    assert.match(zh, /階段：分段製作/);
    assert.match(zh, /角色：通過/);
    assert.match(zh, /分段：1\/3 通過 · 1 段進行中/);
    assert.match(en, /Segments: 1\/3 passed · 1 in progress/);
  });
  test('what the user has to do: needs, errors, the plan', async () => {
    const paused = newJob('Paused', { stage: 'needs_input', needs: [{ issue: 'Upload the song', from: 'critic', at: '' }] });
    const failed = newJob('Failed', { stage: 'error', failed: 'producing', error: 'Missing output: out/video.mp4' });
    const plan = newJob('Plan');
    writeFileSync(join(J.dirOf(plan), 'plan.json'), JSON.stringify({ title: 'Plan title', required_inputs: [{ id: 'logo', kind: 'image', label: 'Logo' }] }));
    setJob(plan, { stage: 'plan_review' });
    const { bot, id } = linked();
    await bot.handleEvents([say(id, `進度 ${paused}`), say(id, `進度 ${failed}`), say(id, `進度 ${plan}`)]);
    const [p, f, pl] = replies();
    assert.match(p, /⏸️ 等你提供[\s\S]*- Upload the song/);
    assert.match(f, /⚠️ 需要處理[\s\S]*Missing output: out\/video\.mp4[\s\S]*重試這一步/);
    assert.match(pl, /🎬 Plan title[\s\S]*核准[\s\S]*還需要你提供：Logo/);
  });
  test('a link to the project only when REELMIMIC_URL says where the phone can open it', async () => {
    const pid = newJob('Linked');
    const { bot, id } = linked();
    await bot.handleEvents([say(id, `進度 ${pid}`)]);
    assert.doesNotMatch(replies()[0], /http/);
    process.env.REELMIMIC_URL = 'https://studio.example.com/';
    try { await bot.handleEvents([say(id, `進度 ${pid}`)]); } finally { delete process.env.REELMIMIC_URL; }
    assert.match(replies()[1], new RegExp(`https://studio\\.example\\.com/#/p/${pid}`));
  });
  test('relative times', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    assert.equal(ago('2026-10-15T11:59:40Z', 'zh', now), '剛剛');
    assert.equal(ago('2026-10-15T11:55:00Z', 'en', now), '5 min ago');
    assert.equal(ago('2026-10-15T09:00:00Z', 'zh', now), '3 小時前');
    assert.equal(ago('2026-10-13T12:00:00Z', 'en', now), '2 days ago');
  });
  test('notify on / off', async () => {
    const { bot, store, id } = linked();
    await bot.handleEvents([say(id, '通知 關')]);
    assert.equal(store.get(id)?.notify, false);
    assert.match(replies()[0], /通知：關/);
    await bot.handleEvents([say(id, '通知'), say(id, 'notify on')]);
    assert.match(replies()[1], /通知：關/);
    assert.match(replies()[2], /Notifications: on/);
    assert.equal(store.get(id)?.notify, true);
  });
});

describe('notifications', () => {
  test('a stage that needs the user is pushed once, to accounts that want it', async () => {
    const pid = newJob('Notify me', { stage: 'producing' });
    const store = newStore(); link(store, 'Uon', 'zh'); link(store, 'Uoff', 'en'); link(store, 'Uen', 'en');
    store.set('Uoff', { notify: false });
    const stop = startNotifier(CFG, store);
    try {
      setJob(pid, { stage: 'done' });
      setJob(pid, { stage: 'done' });   // saved again (a log line, a chat message): not a new event
      await new Promise((r) => setImmediate(r));
      const p = pushes();
      assert.deepEqual(p.map((x) => x.body.to).sort(), ['Uen', 'Uon']);
      const zh = p.find((x) => x.body.to === 'Uon')!, en = p.find((x) => x.body.to === 'Uen')!;
      assert.match(zh.body.messages[0].text, /🎬 Notify me\n✅ 完成/);
      assert.match(en.body.messages[0].text, /✅ Done/);
      assert.ok(zh.headers['X-Line-Retry-Key']);
      assert.equal(zh.headers.Authorization, 'Bearer test-token');
    } finally { stop(); }
  });
  test('working stages and a cancel stay quiet; a real error is pushed', async () => {
    const pid = newJob('Quiet', { stage: 'producing' });
    const { store } = linked();
    const stop = startNotifier(CFG, store);
    try {
      setJob(pid, { stage: 'critiquing' });
      setJob(pid, { stage: 'error', error: 'Cancelled' });
      setJob(pid, { stage: 'producing', error: null });
      setJob(pid, { stage: 'error', error: '已取消' });
      await new Promise((r) => setImmediate(r));
      assert.equal(pushes().length, 0);
      setJob(pid, { stage: 'producing', error: null });
      setJob(pid, { stage: 'error', error: 'The agent turn failed' });
      await new Promise((r) => setImmediate(r));
      assert.equal(pushes().length, 1);
      assert.match(pushes()[0].body.messages[0].text, /The agent turn failed/);
    } finally { stop(); }
  });
  test('a finished video says how the final review ended', async () => {
    const pid = newJob('Ended', { stage: 'critiquing' });
    const { store } = linked();
    const stop = startNotifier(CFG, store);
    try {
      setJob(pid, { stage: 'done', chat: [{ role: 'system', text: '評審仍有 2 項必修，已達自動修改上限，請你決定', ts: '' }] });
      await new Promise((r) => setImmediate(r));
      assert.match(pushes()[0].body.messages[0].text, /✅ 完成[\s\S]*評審仍有 2 項必修/);
    } finally { stop(); }
  });
  test('a broken notification never breaks the job that triggered it', () => {
    const pid = newJob('Robust', { stage: 'producing' });
    const { store } = linked();
    store.users = () => { throw new Error('boom'); };
    const err = mock.method(console, 'error', () => {});
    const stop = startNotifier(CFG, store);
    try { assert.doesNotThrow(() => setJob(pid, { stage: 'done' })); assert.equal(J.load(pid).stage, 'done'); assert.equal(err.mock.callCount(), 1); }
    finally { stop(); err.mock.restore(); }
  });
  test('stages reached before the bot started are not re-sent', async () => {
    const pid = newJob('Old news', { stage: 'done' });
    const { store } = linked();
    const stop = startNotifier(CFG, store);
    try { J.touch(pid); await new Promise((r) => setImmediate(r)); assert.equal(pushes().length, 0); } finally { stop(); }
  });
});

describe('LINE API calls', () => {
  test('a push is retried after a server error with the same retry key', async () => {
    const err = mock.method(console, 'error', () => {});
    let calls = 0;
    answer = () => (++calls === 1 ? new Response('busy', { status: 500 }) : new Response('{}', { status: 200 }));
    assert.equal(await push('tok', 'U1', [text('hi')]), true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].headers['X-Line-Retry-Key'], sent[1].headers['X-Line-Retry-Key']);
    sent = []; answer = () => new Response('bad', { status: 400 });
    assert.equal(await push('tok', 'U1', [text('hi')]), false);
    assert.equal(sent.length, 1);   // a client error is not retried
    err.mock.restore();
  });
  test('long text and labels are cut to LINE\'s limits', () => {
    const m = text('字'.repeat(6000), { items: [] });
    assert.equal([...m.text].length, 5000);
    assert.equal(m.quickReply, undefined);   // an empty button row is left out
    const q = quick(Array.from({ length: 20 }, (_, i) => ({ label: `${i}. 一個很長很長很長很長很長很長的專案名稱`, text: `進度 ${i}` })));
    assert.equal(q.items.length, 13);
    assert.equal([...q.items[0].action.label].length, 20);
  });
});

describe('webhook endpoint', () => {
  test('rejects unsigned requests, accepts LINE\'s verify call, answers messages', async () => {
    const store = newStore(), bot = createBot(CFG, store), srv = bot.app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    // a plain HTTP request: the global fetch is the fake LINE API in this file
    const send = (path: string, body: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const r = request(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode || 0); });
      r.on('error', reject); r.end(body);
    });
    try {
      const verify = JSON.stringify({ destination: 'x', events: [] });
      assert.equal(await send('/line/webhook', verify, {}), 401);
      assert.equal(await send('/line/webhook', verify, { 'x-line-signature': sign(verify, 'wrong') }), 401);
      assert.equal(await send('/line/webhook', verify, { 'x-line-signature': sign(verify) }), 200);
      assert.equal(await send('/line/webhook', '{oops', { 'x-line-signature': sign('{oops') }), 400);
      assert.equal(await send('/api/projects', '{}', {}), 404);   // nothing else is served on this port
      const big = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request(`${url}/line/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode || 0, body: b })); });
        r.on('error', reject); r.end('x'.repeat(1024 ** 2 + 10));
      });
      assert.deepEqual(big, { status: 413, body: '' });   // a bare status: no error page with a stack trace and local paths
      const body = JSON.stringify({ events: [say('Uweb', `綁定 ${store.newCode().code}`)] });
      assert.equal(await send('/line/webhook', body, { 'x-line-signature': sign(body) }), 200);
      for (let i = 0; i < 100 && !replies().length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.match(replies()[0], /綁定好了/);
      assert.equal(sent[0].body.replyToken, JSON.parse(body).events[0].replyToken);
      assert.ok(JSON.parse(readFileSync(store.path, 'utf8')).users.Uweb);
    } finally { srv.close(); }
  });
});
