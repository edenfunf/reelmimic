// The hooks end to end, run exactly as Claude Code runs them: a fresh `node` process, the event as JSON on stdin,
// the decision as JSON on stdout. State and audit go to a temp dir.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/hook.mts';
import { bin } from '../lib/video.mts';

const TMP = mkdtempSync(join(tmpdir(), 'harness-hooks-'));
const ENV: NodeJS.ProcessEnv = { ...process.env, REELMIMIC_HARNESS_STATE: join(TMP, 'state'), REELMIMIC_HARNESS_AUDIT: join(TMP, 'audit.jsonl') };
delete ENV.REELMIMIC_PROJECTS;

// The exact command line .claude/settings.json gives Claude Code.
const HOOK = (kind: string) => ['--disable-warning=ExperimentalWarning', join(ROOT, '.claude/harness/hooks/dispatch.mjs'), kind];
const KIND: Record<string, string> = { 'pre-tool-use': 'pre', 'post-tool-use': 'post', stop: 'stop' };

function hook(name: string, event: object | string, env: NodeJS.ProcessEnv = ENV) {
  const r = spawnSync(process.execPath, HOOK(KIND[name]),
    { input: typeof event === 'string' ? event : JSON.stringify(event), env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const audit = () => (existsSync(ENV.REELMIMIC_HARNESS_AUDIT!) ? readFileSync(ENV.REELMIMIC_HARNESS_AUDIT!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

test('pre-tool-use: deny carries the policy and the way out; allowed calls print nothing', () => {
  const out = hook('pre-tool-use', { session_id: 's1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'git add -f projects' } });
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^\[harness:git-add-projects\].*projects-private/);
  assert.equal(hook('pre-tool-use', { session_id: 's1', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'git status' } }), null);
  assert.ok(audit().some((a) => a.out?.hookSpecificOutput?.permissionDecision === 'deny'));
});

test('pre-tool-use: fails open on garbage, and says why in the audit log', () => {
  assert.equal(hook('pre-tool-use', '{not json'), null);
  assert.ok(audit().some((a) => a.hook === 'pre-tool-use' && /JSON/.test(a.error)));
});

test('pre-tool-use: second-server sees a real server answering /api/health', async () => {
  const srv = createServer((req, res) => res.end(req.url === '/api/health' ? '{"ok":true}' : '{}'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const ev = (command: string) => ({ session_id: 's1', cwd: ROOT, tool_name: 'Bash', tool_input: { command } });
    // spawnSync would block this process's event loop and the fake server with it: run the hook asynchronously.
    const run = (command: string) => new Promise<string>((done) => {
      const c = spawn(process.execPath, HOOK('pre'), { env: ENV });
      let o = ''; c.stdout.on('data', (d) => (o += d)); c.on('close', () => done(o)); c.stdin.end(JSON.stringify(ev(command)));
    });
    assert.match(await run(`PORT=${port} node app/server/index.ts`), /second-server/);
    assert.equal(await run(`PORT=${port} REELMIMIC_PROJECTS=${TMP}/p node app/server/index.ts`), '');
  } finally { srv.close(); }
});

const ffmpeg = spawnSync(bin('ffmpeg'), ['-version']).status === 0;

test('post-tool-use + stop: a film render is sheeted, scanned, and gated until looked at', { skip: !ffmpeg && 'ffmpeg not found' }, () => {
  const proj = join(TMP, 'proj'); mkdirSync(join(proj, 'out'), { recursive: true });
  // 3 s of picture, 1 s of black, 3 s of one still colour: a contact sheet, a black stretch and a frozen tail.
  execFileSync(bin('ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=3', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=1',
    '-f', 'lavfi', '-i', 'color=0x3366cc:s=640x360:r=24:d=3', '-filter_complex', '[0][1][2]concat=n=3:v=1', '-pix_fmt', 'yuv420p', join(proj, 'out', 'video.mp4')]);
  const S = 'film-session', base = { session_id: S, cwd: proj, tool_name: 'Bash' };
  const out = hook('post-tool-use', { ...base, tool_input: { command: 'node render.mjs --encode --out=out/video.mp4' } });
  const ctx: string = out.hookSpecificOutput.additionalContext;
  const sheet = /Contact sheet: (\S+\.jpg)/.exec(ctx)?.[1];
  assert.ok(sheet && existsSync(sheet), ctx);
  assert.match(ctx, /Black picture at 3\.0–4\.0 s — check it is intended/);
  assert.match(ctx, /frozen ≥ 2\.5 s at 4\.\d–7\.0 s/);

  const block = hook('stop', { session_id: S });
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /look-after-render[\s\S]*video\.mp4/);
  assert.equal(hook('stop', { session_id: S, stop_hook_active: true }), null, 'second stop goes through');
  hook('post-tool-use', { ...base, tool_name: 'Read', tool_input: { file_path: sheet } });
  assert.equal(hook('stop', { session_id: S }), null, 'looked at: free to stop');
});

test('post-tool-use + stop: review images are pending until that file is read', () => {
  const d = join(TMP, 'checks'); mkdirSync(join(d, 'out', 'check'), { recursive: true });
  const img = join(d, 'out', 'check', 'a.jpg'); writeFileSync(img, 'x');
  const S = 'check-session';
  assert.equal(hook('post-tool-use', { session_id: S, cwd: d, tool_name: 'Bash', tool_input: { command: 'node render.mjs --sheet=1,2 --out=out/check/a.jpg' } }), null);
  assert.equal(hook('stop', { session_id: S }).decision, 'block');
  hook('post-tool-use', { session_id: S, cwd: d, tool_name: 'Read', tool_input: { file_path: join(d, 'other.png') } });
  assert.equal(hook('stop', { session_id: S }).decision, 'block', 'a different image does not count');
  hook('post-tool-use', { session_id: S, cwd: d, tool_name: 'Read', tool_input: { file_path: img } });
  assert.equal(hook('stop', { session_id: S }), null);
});

test('post-tool-use: a background render is noted with the command to check it later', () => {
  const out = hook('post-tool-use', { session_id: 'bg', cwd: TMP, tool_name: 'Bash', tool_input: { command: 'npx hyperframes render --output out.mp4', run_in_background: true } });
  assert.match(out.hookSpecificOutput.additionalContext, /background[\s\S]*look\.mts .*out\.mp4/);
});

test('pre → post by tool_use_id: a video from just before this call is not taken for this call’s output', () => {
  const d = join(TMP, 'since'); mkdirSync(join(d, 'out'), { recursive: true });
  const f = join(d, 'out', 'video.mp4'); writeFileSync(f, 'x');
  const t = new Date(Date.now() - 20_000); utimesSync(f, t, t);   // last run, 20 s ago: inside the old 3-minute window
  const ev = { session_id: 'since', tool_use_id: 'toolu_since_1', cwd: d, tool_name: 'Bash', tool_input: { command: 'node render.mjs --encode --out=out/video.mp4' } };
  assert.equal(hook('pre-tool-use', ev), null);   // records the start
  const out = hook('post-tool-use', ev);
  assert.match(out.hookSpecificOutput.additionalContext, /wrote no new video at .*video\.mp4 during this call/);
  assert.equal(hook('stop', { session_id: 'since' }), null, 'nothing rendered, nothing to look at');
});
