// GET /api/health: what start.bat / start.sh wait for before opening the browser.
// Starts the real server on a spare port against a throwaway projects folder; PYTHON is set so startup doesn't go
// looking for an interpreter. No agent is started.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, [join(import.meta.dirname, 'index.ts')], { env: { ...process.env, PORT: String(PORT), REELMIMIC_PROJECTS: TMP, PYTHON: 'reelmimic-no-such-python' }, stdio: 'ignore' });
after(() => { server.kill(); rmSync(TMP, { recursive: true, force: true }); });

const health = async () => {
  for (let i = 0; i < 100; i++) { try { return await fetch(`http://127.0.0.1:${PORT}/api/health`); } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
};

test('answers { ok: true } once the server is listening', async () => {
  const r = await health();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /^application\/json/);
  assert.deepEqual(await r.json(), { ok: true });
});
