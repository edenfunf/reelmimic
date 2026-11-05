import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/hook.mts';
import { evaluate } from '../policy.mts';

const down = async (_port: number) => false, up = async (_port: number) => true;
const bash = (command: string, cwd = ROOT, probe = down, env: Record<string, string> = {}) => evaluate('Bash', { command }, cwd, env, probe);
const verdict = async (p: ReturnType<typeof bash>) => { const v = await p; return v ? `${v.decision}:${v.policy}` : null; };

const SECRETS_DIR = mkdtempSync(join(tmpdir(), 'harness-secrets-')).replace(/\\/g, '/');   // as an agent writes it: unquoted `\` is an escape
const SECRETS = join(SECRETS_DIR, 'secrets.json').replace(/\\/g, '/');
writeFileSync(SECRETS, '{"YATING_KEY":"x"}');

test('secrets: writes are denied however they are spelled', async () => {
  assert.equal((await evaluate('Write', { file_path: SECRETS }, ROOT, {}, down))?.policy, 'secrets-write');
  assert.equal((await evaluate('Edit', { file_path: 'C:\\Users\\u\\.reelmimic\\secrets.json' }, ROOT, {}, down))?.decision, 'deny');
  for (const c of [
    `echo '{"K":1}' > ~/.reelmimic/secrets.json`,
    'cp mine.json ~/.reelmimic/secrets.json',
    `sed -i 's/a/b/' ~/.reelmimic/secrets.json`,
    `python -c "import json; json.dump({}, open('/home/u/.reelmimic/secrets.json', 'w'))"`,
    'cd ~/.reelmimic && tee secrets.json < new.json',
    'Set-Content ~/.reelmimic/secrets.json "{}"',
  ]) assert.equal(await verdict(bash(c)), 'deny:secrets-write', c);
});

test('secrets: reading the real file asks; naming it does not', async () => {
  assert.equal((await evaluate('Read', { file_path: SECRETS }, ROOT, {}, down))?.decision, 'ask');
  assert.equal(await verdict(bash(`cat ${SECRETS}`)), 'ask:secrets-read');
  assert.equal(await verdict(bash(`echo $(cat ${SECRETS})`)), 'ask:secrets-read');
  for (const c of ['grep -rn "secrets.json" app/', 'git commit -m "load keys from secrets.json"', `test -f ${SECRETS} && echo set`, 'cp secrets.example.json /tmp/x.json'])
    assert.equal(await verdict(bash(c)), null, c);
  assert.equal(await evaluate('Edit', { file_path: `${ROOT}/secrets.example.json` }, ROOT, {}, down), null);
});

// The keys file as app/server/env.ts would find it through REELMIMIC_SECRETS: what folder-walking tools are checked against.
const KEYED = { REELMIMIC_SECRETS: SECRETS };
const PARENT = dirname(SECRETS_DIR).replace(/\\/g, '/');

test('secrets: $HOME and variables are expanded before a path is looked at', async () => {
  assert.equal(await verdict(bash(`export SD=${SECRETS_DIR}; cat $SD/secrets.json`)), 'ask:secrets-read');
  assert.equal(await verdict(bash(`SD=${SECRETS_DIR}; cat \${SD}/secrets.json`)), 'ask:secrets-read');
  assert.equal(await verdict(bash(`D=${SECRETS_DIR}; echo '{}' > $D/secrets.json`)), 'deny:secrets-write', 'a redirect target is expanded too');
});

test('secrets: a glob the shell expands to the file reaches it', async () => {
  for (const g of [`${SECRETS_DIR}/*`, `${SECRETS_DIR}/s*.json`, `${SECRETS_DIR}/secret?.json`, `${PARENT}/harness-secrets-*/*`])
    assert.equal(await verdict(bash(`cat ${g}`)), 'ask:secrets-read', g);
  assert.equal(await verdict(bash(`cp ${SECRETS_DIR}/* /tmp/keys/`)), 'deny:secrets-write');
  assert.equal(await verdict(bash(`ls ${SECRETS_DIR}/*`)), null, 'listing is not reading');
  assert.equal(await verdict(bash(`cat ${SECRETS_DIR}/*.txt`)), null, 'a glob that matches nothing of ours');
  assert.equal(await verdict(bash(`python -c "print([1, 2][0])"`)), null, 'quoted code is not a glob');
});

test('secrets: folder-walking tools reach the file through any folder above it', async () => {
  const keyed = (c: string) => verdict(evaluate('Bash', { command: c }, ROOT, KEYED, down));
  for (const c of [`grep -r . ${SECRETS_DIR}`, `grep -rn KEY ${PARENT}`, `rg sk- ${SECRETS_DIR}`, `cd ${SECRETS_DIR} && grep -R x .`])
    assert.equal(await keyed(c), 'ask:secrets-read', c);
  for (const c of [`rm -rf ${SECRETS_DIR}`, `cp -r ${SECRETS_DIR} /tmp/backup`, `tar czf k.tgz ${SECRETS_DIR}`, `find ${SECRETS_DIR} -delete`, `find ${PARENT} -name secrets.json -exec cat {} ;`, `find ${SECRETS_DIR} -iname 'SECRETS.*' -delete`])
    assert.equal(await keyed(c), 'deny:secrets-write', c);
  for (const c of [`grep x ${SECRETS_DIR}`, `find ${SECRETS_DIR} -name '*.tmp' -delete`, `find ${SECRETS_DIR} -name secrets.json`, `rm -rf ${SECRETS_DIR}/cache`, 'grep -rn secrets.json app/'])
    assert.equal(await keyed(c), null, c);
});

test('secrets: find acts on what it finds once it has -delete / -exec', async () => {
  assert.equal(await verdict(bash('find ~/.reelmimic -name secrets.json -delete')), 'deny:secrets-write');
  assert.equal(await verdict(bash(String.raw`find . -name secrets.json -exec rm {} \;`)), 'deny:secrets-write');
  assert.equal(await verdict(bash('find . -name secrets.json')), null, 'just listing');
});

test('secrets: the Grep tool asks when its path is the file or a folder above it', async () => {
  const grep = (input: Record<string, unknown>, cwd = ROOT) => evaluate('Grep', { pattern: '.', ...input }, cwd, KEYED, down);
  assert.equal((await grep({ path: SECRETS }))?.decision, 'ask');
  assert.equal((await grep({ path: SECRETS_DIR }))?.policy, 'secrets-read');
  assert.equal((await grep({}, SECRETS_DIR))?.decision, 'ask', 'no path: searches the cwd');
  assert.equal(await grep({ path: `${ROOT}/app` }), null);
});

test('secrets: deny wins over ask in the same command', async () => {
  assert.equal(await verdict(bash(`cat ${SECRETS} && echo x > ${SECRETS}`)), 'deny:secrets-write');
});

test('projects-private: nothing under projects/ gets staged', async () => {
  for (const [c, cwd] of [
    ['git add projects/20261019-hvuc0/out/video.mp4', ROOT],
    ['git add -f projects', ROOT],
    ['git add -fA', ROOT],
    ['git add --force .', `${ROOT}/projects`],
    ['git add -f out/video.mp4', `${ROOT}/projects/abc`],
    ['git -C projects add -f abc', ROOT],
    ['git add :/projects/abc/plan.json', `${ROOT}/app`],
    ['cd projects/abc && git add -f .', ROOT],
  ]) assert.equal(await verdict(bash(c, cwd)), 'deny:git-add-projects', c);
  for (const c of ['git add -A', 'git add .', 'git add app/server/jobs.ts docs/', 'git add projects/.gitkeep', 'git add -f .claude/settings.json', 'git status projects'])
    assert.equal(await verdict(bash(c)), null, c);
  assert.equal(await verdict(bash('git add -f projects', join(tmpdir(), 'elsewhere'))), null, 'another repo is not ours to police');
});

test('one-server: a second server on the real projects dir is denied while one answers', async () => {
  for (const [c, cwd] of [
    ['node app/server/index.ts', ROOT],
    ['cd app && npm start', ROOT],
    ['npm run server', `${ROOT}/app`],
    ['npm --prefix app start', ROOT],
    ['nohup node server/index.ts > /tmp/log 2>&1 &', `${ROOT}/app`],
    ['bash start.sh', ROOT],
    ['./start.sh', ROOT],
    ['timeout 600 node app/server/index.ts', ROOT],
    ['timeout -k 5 --signal=INT 10m node app/server/index.ts', ROOT],
    ['npx tsx app/server/index.ts', ROOT],
    ['npx -y tsx watch server/index.ts', `${ROOT}/app`],
    ['pnpm exec tsx app/server/index.ts', ROOT],
    ['sudo -n node app/server/index.ts', ROOT],
  ]) {
    assert.equal(await verdict(bash(c, cwd, up)), 'deny:second-server', c);
    assert.equal(await verdict(bash(c, cwd, down)), null, `${c} (nothing running)`);
  }
});

test('one-server: scratch projects dirs, restart.sh and tests pass', async () => {
  for (const c of ['REELMIMIC_PROJECTS=/tmp/scratch PORT=4400 node app/server/index.ts', 'export REELMIMIC_PROJECTS=/tmp/s; cd app && npm start', 'bash app/restart.sh', 'cd app && npm test', 'node app/scripts/doctor.mjs'])
    assert.equal(await verdict(bash(c, ROOT, up)), null, c);
  assert.equal(await verdict(bash('node app/server/index.ts', ROOT, up, { REELMIMIC_PROJECTS: '/tmp/s' })), null, 'isolated by the session environment');
  assert.equal(await verdict(bash(`REELMIMIC_PROJECTS=${ROOT}/projects node app/server/index.ts`, ROOT, up)), 'deny:second-server', 'pointing at the real dir is not isolation');
});

test('one-server: probes the port the new server would use and the default', async () => {
  const seen: number[] = [];
  await bash('PORT=5001 node app/server/index.ts', ROOT, async (p) => { seen.push(p); return false; });
  assert.deepEqual(seen, [5001, 4318]);
});

test('other tools and harmless commands are left alone', async () => {
  assert.equal(await evaluate('Grep', { pattern: 'secrets.json' }, ROOT, {}, up), null);
  assert.equal(await verdict(bash('node render.mjs --encode --out=out/video.mp4', `${ROOT}/projects/x/build`, up)), null);
});
