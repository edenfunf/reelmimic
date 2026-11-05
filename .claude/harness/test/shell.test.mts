import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { test } from 'node:test';
import { parse, resolvePath, within } from '../lib/shell.mts';

const CWD = resolvePath('/work/repo', process.cwd());
const argvs = (src: string) => parse(src, CWD).map((c) => c.argv);

test('splits on every operator and follows cd', () => {
  const [npm] = parse('cd app && npm start', CWD);
  assert.deepEqual(npm.argv, ['npm', 'start']);
  assert.equal(npm.cwd, `${CWD}/app`);
  assert.deepEqual(argvs('a; b || c | d & e\nf'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
});

test('quotes, escapes, comments and line continuations', () => {
  assert.deepEqual(argvs(`git commit -m "fix: a \\"b\\" c" -m 'it''s'`), [['git', 'commit', '-m', 'fix: a "b" c', '-m', 'its']]);
  assert.deepEqual(argvs('echo a\\ b # not run: rm -rf /'), [['echo', 'a b']]);
  assert.deepEqual(argvs('node render.mjs \\\n  --encode'), [['node', 'render.mjs', '--encode']]);
});

test('environment: K=V prefixes, export, and env/nohup/sudo launchers', () => {
  const [c] = parse('FOO=1 BAR="a b" node x.js', CWD);
  assert.deepEqual(c.env, { FOO: '1', BAR: 'a b' });
  assert.deepEqual(c.argv, ['node', 'x.js']);
  const e = parse('export REELMIMIC_PROJECTS=/tmp/p; node server/index.ts', CWD);
  assert.deepEqual(e.map((x) => x.argv), [['node', 'server/index.ts']]);
  assert.equal(e[0].env.REELMIMIC_PROJECTS, '/tmp/p');
  const [w] = parse('nohup env PORT=5000 node app/server/index.ts > log.txt 2>&1 &', CWD);
  assert.deepEqual(w.argv, ['node', 'app/server/index.ts']);
  assert.equal(w.env.PORT, '5000');
  assert.deepEqual(w.redirects, [`${CWD}/log.txt`]);   // 2>&1 copies a descriptor, it names no file
});

test('substitutions and subshells run as their own commands; a subshell cd does not leak', () => {
  assert.deepEqual(argvs('echo $(cat ~/.reelmimic/secrets.json)'), [['cat', '~/.reelmimic/secrets.json'], ['echo']]);
  const q = parse('echo "pre $(cat f) post" > out.txt', CWD);
  assert.deepEqual(q.map((c) => c.argv), [['cat', 'f'], ['echo', 'pre  post']]);
  assert.deepEqual(q[1].redirects, [`${CWD}/out.txt`]);
  assert.deepEqual(argvs('ls `which node`'), [['which', 'node'], ['ls']]);
  const s = parse('(cd sub; ls) && pwd', CWD);
  assert.equal(s[0].cwd, `${CWD}/sub`);
  assert.equal(s[1].cwd, CWD);
});

test('here-documents are stdin, not commands; an unquoted one still runs its substitutions', () => {
  // Found live: a commit message mentioning secrets.json, passed with -F - <<'EOF', was read as a command and denied.
  const msg = `git commit -q -F - <<'EOF'\nFix: yating_tts.py read secrets.json without an encoding\nrm -rf /\nEOF\ngit log --oneline -1`;
  assert.deepEqual(argvs(msg), [['git', 'commit', '-q', '-F', '-'], ['git', 'log', '--oneline', '-1']]);
  assert.deepEqual(argvs('cat <<-"END" > out.txt && ls\n\tbody line\n\tEND\npwd'), [['cat'], ['ls'], ['pwd']]);
  assert.deepEqual(parse('cat <<EOF > out.txt\nb\nEOF', CWD)[0].redirects, [`${CWD}/out.txt`]);
  assert.deepEqual(argvs('cat <<EOF\nkey: $(cat ~/.reelmimic/secrets.json) and `whoami`\nEOF'), [['cat'], ['cat', '~/.reelmimic/secrets.json'], ['whoami']]);
  assert.deepEqual(argvs('cat <<\\EOF\n$(rm x)\nEOF'), [['cat']], 'a backslash quotes the delimiter too');
  assert.deepEqual(argvs('grep x <<< "git add -f projects"'), [['grep', 'x']]);
});

test('variables expand from the command, then the environment; search lists do not', () => {
  const home = homedir().replace(/\\/g, '/');
  assert.deepEqual(argvs('cat $HOME/.k ${HOME}/.k')[0].slice(1).map((a) => a.replace(/\\/g, '/')), [`${home}/.k`, `${home}/.k`]);
  assert.deepEqual(argvs('D=/tmp/d; ls $D/x "${D}"/y'), [['ls', '/tmp/d/x', '/tmp/d/y']]);
  assert.deepEqual(argvs('HOME=/elsewhere cat $HOME/f')[0][1].replace(/\\/g, '/'), `${home}/f`, 'a prefix applies to the command, not to its own words');
  assert.deepEqual(argvs('echo $PATH $NOT_SET_ANYWHERE_X $1'), [['echo', '$PATH', '$NOT_SET_ANYWHERE_X', '$1']]);
  assert.deepEqual(parse('D=/tmp/d; echo x > $D/out.txt', CWD)[0].redirects, [resolvePath('/tmp/d/out.txt', CWD)]);
});

test('launchers are unwrapped with their own options', () => {
  assert.deepEqual(argvs('timeout 600 node a.js'), [['node', 'a.js']]);
  assert.deepEqual(argvs('timeout -s INT -k 5 10m node a.js'), [['node', 'a.js']]);
  assert.deepEqual(argvs('sudo -n node a.js'), [['node', 'a.js']], '-n takes no value: the old code ate `node`');
  assert.deepEqual(argvs('sudo -u bob node a.js'), [['node', 'a.js']]);
  assert.deepEqual(argvs('npx -y tsx a.ts'), [['tsx', 'a.ts']]);
  assert.deepEqual(argvs('npx --package tsx tsx a.ts'), [['tsx', 'a.ts']]);
  assert.deepEqual(argvs('pnpm exec -- tsx a.ts'), [['tsx', 'a.ts']]);
  assert.deepEqual(argvs('npm test'), [['npm', 'test']]);
});

test('bash -c is parsed as the commands it runs', () => {
  const L = parse(`bash -c 'cd /tmp && git add x'`, CWD);
  assert.deepEqual(L.map((c) => c.argv), [['bash', '-c', 'cd /tmp && git add x'], ['git', 'add', 'x']]);
  assert.equal(L[1].cwd, resolvePath('/tmp', CWD));
});

test('paths: ~, Git Bash drive paths, containment', () => {
  assert.equal(resolvePath('~/.reelmimic/secrets.json', CWD), resolvePath(`${homedir()}/.reelmimic/secrets.json`, CWD));
  if (process.platform === 'win32') assert.equal(resolvePath('/c/Users/x', CWD), 'C:/Users/x');
  assert.ok(within(`${CWD}/projects/a`, `${CWD}/projects`));
  assert.ok(!within(`${CWD}/projects-old`, `${CWD}/projects`));
});
