// Rejected uploads: multer saves files to projects/.uploads/ before the route runs, so every rejection must delete them.
// Starts the real server on a spare port against a throwaway projects folder (as health.test.ts does). No agent is started.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, [join(import.meta.dirname, 'index.ts')], { env: { ...process.env, PORT: String(PORT), REELMIMIC_PROJECTS: TMP, PYTHON: 'reelmimic-no-such-python' }, stdio: 'ignore' });
after(() => { server.kill(); rmSync(TMP, { recursive: true, force: true }); });
before(async () => {
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});

const leftover = () => readdirSync(join(TMP, '.uploads'));
const form = (fields: Record<string, string>, files: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [k, name] of Object.entries(files)) f.append(k, new Blob(['not really a video']), name);
  return f;
};
const post = (path: string, body: FormData) => fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', body });

for (const [why, fields, files] of [
  ['an unknown agent', { agent: 'nobody' }, { reference: 'ref.mp4', inputs: 'song.mp3' }],
  ['bad round limits', { castRounds: '99' }, { reference: 'ref.mp4' }],
  ['no reference and no link', {}, { inputs: 'song.mp3' }],
  ['a reference that is not a video', {}, { reference: 'notes.txt', inputs: 'song.mp3' }],
] as const) {
  test(`new project with ${why}: 400 and nothing left in .uploads`, async () => {
    const r = await post('/api/projects', form(fields, files));
    assert.equal(r.status, 400);
    assert.deepEqual(leftover(), []);
  });
}

test('inputs for a project that does not exist: 404 and nothing left in .uploads', async () => {
  const r = await post('/api/projects/no-such-project/inputs', form({}, { inputs: 'song.mp3' }));
  assert.equal(r.status, 404);
  assert.deepEqual(leftover(), []);
});
