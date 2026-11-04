// The fast path may only skip what the handlers would ignore anyway. Checked as a property over a corpus:
// for every command, "a policy speaks or classify() finds a render" ⇒ needsHandler() is true.
// The corpus is the tricky cases below, plus — when this checkout has production logs — every shell command real agents
// ran (projects/*/logs/events.jsonl), which also measures how often the fast path is taken.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { needsHandler } from '../hooks/fast.mjs';
import { ROOT } from '../lib/hook.mts';
import { evaluate } from '../policy.mts';
import { classify } from '../render.mts';
import { parse } from '../lib/shell.mts';

const up = async (_port: number) => true;   // assume a server is up: the widest set of commands a policy acts on
const ev = (command: string, cwd = ROOT) => ({ session_id: 'fast', cwd, tool_name: 'Bash', tool_input: { command } });

async function check(command: string, cwd = ROOT) {
  const acts = !!(await evaluate('Bash', { command }, cwd, {}, up));
  const renders = parse(command, cwd).some((c) => classify(c));
  if (acts) assert.ok(needsHandler('pre', ev(command, cwd)), `pre fast path would skip: ${command}`);
  if (renders) assert.ok(needsHandler('post', ev(command, cwd)), `post fast path would skip: ${command}`);
  return { pre: needsHandler('pre', ev(command, cwd)), post: needsHandler('post', ev(command, cwd)) };
}

const TRICKY = [
  `g''it add -f projects`, `"git" add -f projects/x`, `\\git add -f projects`, 'cd projects && git add -f .',
  'echo x > ~/.reelmimic/se""crets.json', `cat ~/.reelmimic/'secrets'.json`, 'cp a ~/.reelmimic/secrets\\.json',
  'bash -c "cd app && npm start"', 'nohup node app/server/index.ts &', 'npm --prefix app run server', 'cmd /c start.bat',
  'node render.mjs --encode --out=out/video.mp4', `node "render.mjs" --sheet=1 --out=out/check/a.jpg`,
  'npx hyperframes render --output out.mp4', 'ffmpeg -i v.mp4 -i a.wav out/video.mp4', 'python hf_frames.py build --at 1 --out o',
];

test('tricky spellings never slip past the fast path', async () => {
  for (const c of TRICKY) await check(c);
});

test('Read / Write: only a secrets.json path leaves the fast path; Stop and Read-after-render only with pending state', () => {
  assert.equal(needsHandler('pre', { tool_name: 'Read', tool_input: { file_path: `${ROOT}/README.md` } }), false);
  assert.equal(needsHandler('pre', { tool_name: 'Write', tool_input: { file_path: 'C:\\Users\\u\\.reelmimic\\secrets.json' } }), true);
  assert.equal(needsHandler('post', { session_id: 'never-rendered', tool_name: 'Read', tool_input: { file_path: 'a.png' } }), false);
  assert.equal(needsHandler('stop', { session_id: 'never-rendered' }), false);
  assert.equal(needsHandler('pre', null), true, 'malformed stdin goes to the handler, which logs it');
});

const logs = existsSync(join(ROOT, 'projects')) ? readdirSync(join(ROOT, 'projects')).map((p) => join(ROOT, 'projects', p, 'logs', 'events.jsonl')).filter(existsSync) : [];

test('every shell command real agents ran: no skip the handlers would have acted on; fast-path rate', { skip: !logs.length && 'no production logs in this checkout' }, async () => {
  let n = 0, pre = 0, post = 0;
  for (const f of logs) for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"type":"tool"') || !line.includes('"name":"Bash"')) continue;
    let e: { detail?: string }; try { e = JSON.parse(line); } catch { continue; }
    const cmd = String(e.detail ?? '').replace(/…$/, '');   // logged commands are cut at 400 chars
    const r = await check(cmd, join(ROOT, 'projects'));
    n++; if (!r.pre) pre++; if (!r.post) post++;
  }
  console.log(`  ${n} commands from ${logs.length} jobs — fast path: PreToolUse ${(100 * pre / n).toFixed(1)} %, PostToolUse ${(100 * post / n).toFixed(1)} %`);
});
