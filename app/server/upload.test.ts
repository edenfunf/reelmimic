// Uploads: long non-ASCII file names are trimmed to fit the file system, and an error while saving a file is answered
// with a JSON 500 instead of crashing the server (Express 4 doesn't catch rejected promises from async handlers).
// Starts the real server on a spare port against a throwaway projects folder. No agent is started: PYTHON is Node,
// so analyze.py fails at once and the new project stops at analysis.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'reelmimic-upload-'));
const PORT = 20000 + Math.floor(Math.random() * 20000), URL = `http://127.0.0.1:${PORT}`;
let server: ChildProcess, exited = false;

before(async () => {
  server = spawn(process.execPath, [join(import.meta.dirname, 'index.ts')], { env: { ...process.env, PORT: String(PORT), REELMIMIC_PROJECTS: TMP, PYTHON: process.execPath }, stdio: 'ignore' });
  server.on('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) { try { await fetch(`${URL}/api/projects`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
after(() => { server.kill(); rmSync(TMP, { recursive: true, force: true }); });

const form = (fields: Record<string, string>, files: string[]) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const name of files) f.append('inputs', new Blob(['x']), name);
  return f;
};
const alive = async () => { await new Promise((r) => setTimeout(r, 200)); assert.ok(!exited, 'server exited'); assert.equal((await fetch(`${URL}/api/projects`)).status, 200); };
const LONG = '歌'.repeat(100) + '.mp3';   // 304 bytes: over the 255-byte limit of Linux file systems

describe('uploads', () => {
  let id = '';
  test('a new project with a long Chinese file name is created, the name trimmed and the extension kept', async () => {
    const r = await fetch(`${URL}/api/projects`, { method: 'POST', body: form({ url: 'https://example.com/v', brief: 'b' }, [LONG]) });
    assert.equal(r.status, 200);
    id = ((await r.json()) as { id: string }).id;
    const name = '歌'.repeat(65) + '.mp3';   // 199 bytes
    assert.ok(existsSync(join(TMP, id, 'inputs', name)));
    await alive();
  });
  test('adding a file with a long Chinese name later works too', async () => {
    const r = await fetch(`${URL}/api/projects/${id}/inputs?to=attachments`, { method: 'POST', body: form({}, [LONG]) });
    assert.equal(r.status, 200);
    const [saved] = ((await r.json()) as { saved: string[] }).saved;
    assert.match(saved, /^inputs\/attachments\/\w+_歌+\.mp3$/);
    assert.ok(Buffer.byteLength(saved.split('/').pop()!) <= 255);
    await alive();
  });
  test('an error while saving is a JSON 500, and the server keeps running', async () => {
    rmSync(join(TMP, id, 'inputs', 'attachments'), { recursive: true });
    writeFileSync(join(TMP, id, 'inputs', 'attachments'), '');   // a file where the folder should be: mkdir fails
    const r = await fetch(`${URL}/api/projects/${id}/inputs?to=attachments`, { method: 'POST', body: form({}, ['a.png']) });
    assert.equal(r.status, 500);
    assert.ok(((await r.json()) as { error: string }).error);
    await alive();
  });
});
