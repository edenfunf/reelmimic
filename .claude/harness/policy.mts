// PreToolUse policies: the project rules that can be checked before a tool call runs. Each policy names the rule it
// enforces (the ids in CLAUDE.md's rule list); `sync-rules.mts --check` fails CI if a policy points at a rule that no
// longer exists, or a rule claims a policy that is not here. A policy returns null when it has nothing to say; when
// several speak, deny wins over ask. Reasons are written for the agent: what was stopped, why, and the allowed way.
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { secretFiles } from './hooks/fast.mjs';
import { ROOT } from './lib/hook.mts';
import { base, parse, resolvePath, samePath, within, type Simple } from './lib/shell.mts';

export interface Ctx { tool: string; input: Record<string, unknown>; cwd: string; env: Record<string, string | undefined>; commands: Simple[]; probe: (port: number) => Promise<boolean> }
export interface Verdict { decision: 'deny' | 'ask'; reason: string }
export interface Policy { id: string; rule: string; check: (c: Ctx) => Verdict | null | Promise<Verdict | null> }

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const filePath = (c: Ctx) => String(c.input.file_path ?? c.input.notebook_path ?? '');

// --- secrets ----------------------------------------------------------------------------------------------------
// Keys live in ~/.reelmimic/secrets.json (app/server/env.ts). The user fills it in; an agent writing it can silently
// replace a working key, and an agent printing it puts every key into the transcript and the job log.
// A command reaches the file by naming it, by a glob the shell expands to it (`cat ~/.reelmimic/*`), or, for tools
// that walk folders (`grep -r`, `rg`, `rm -r`, `cp -r`, `find … -delete`, the Grep tool), by naming a folder above it.
// `$HOME` and friends are expanded by the parser before any of this looks at a path.
const isSecrets = (p: string) => /(^|[\\/])secrets\.json$/i.test(p);
const READERS = new Set(['cat', 'type', 'head', 'tail', 'less', 'more', 'bat', 'jq', 'get-content', 'gc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls', 'strings', 'od', 'xxd', 'hexdump', 'base64']);
// Mentioning the file is harmless for these: they cannot write it except through a redirect, which is checked anyway.
// `find` only while it lists: with -delete / -exec / -ok / -fprint it acts on what it finds.
const INERT = new Set(['echo', 'printf', 'ls', 'dir', 'stat', 'test', '[', 'which', 'git', 'gh', 'find', 'wc', 'file', 'realpath', 'dirname', 'basename']);
const FIND_ACTS = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
// These act on whole folders, so naming a folder above the keys reaches them.
const TREE = new Set(['rm', 'rmdir', 'mv', 'cp', 'rsync', 'scp', 'tar', 'zip', '7z', 'chmod', 'chown', 'shred', 'del', 'erase', 'rd', 'remove-item', 'ri', 'move-item', 'mi', 'copy-item', 'cpi', 'robocopy', 'xcopy', 'compress-archive']);
const SECRETS_HELP = 'API keys belong to the user and live in ~/.reelmimic/secrets.json (copy secrets.example.json). Tell the user which key to add instead; to check whether one is set, use `test -f ~/.reelmimic/secrets.json` or read it from the environment the server exports.';

const recursiveRead = (p: string, argv: string[]) => p === 'rg' || p === 'ag'
  || (['grep', 'egrep', 'fgrep'].includes(p) && argv.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^--(?:dereference-)?recursive$/.test(a)))
  || (p === 'findstr' && argv.some((a) => /^[/-]s$/i.test(a)));
/** find with an action, unless every -name / -iname it filters on rules secrets.json out. */
const findActs = (argv: string[]) => {
  if (!argv.some((a) => FIND_ACTS.test(a))) return false;
  const names = argv.flatMap((a, i) => (a === '-name' || a === '-iname' ? [{ glob: argv[i + 1] ?? '', ci: a === '-iname' }] : []));
  return !names.length || names.some((n) => globRegex(n.glob, n.ci).test('secrets.json'));
};

/** The secrets file `arg` reaches, or null. `dirs`: the tool walks folders, so a folder above a known secrets file counts. */
export function reaches(arg: string, cwd: string, env: Record<string, string | undefined>, dirs: boolean): string | null {
  if (!arg || /^-[^/\\]*$/.test(arg)) return null;   // an option, not a path
  const p = resolvePath(arg, cwd);
  // A word with whitespace was quoted (code, a message), and the shell does not glob quoted words.
  for (const q of /[*?[]/.test(arg) && !/\s/.test(arg) ? expandGlob(p) : [p]) {
    if (isSecrets(q) && existsSync(q)) return q;
    if (dirs) { const f = secretFiles(env).find((s) => within(s, q) && existsSync(s)); if (f) return f; }
  }
  return null;
}

const secretsWrite: Policy = {
  id: 'secrets-write', rule: 'secrets',
  check(c) {
    if (WRITE_TOOLS.has(c.tool) && isSecrets(filePath(c))) return { decision: 'deny', reason: `Writing ${filePath(c)} is blocked (rule \`secrets\`). ${SECRETS_HELP}` };
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      const hit = s.redirects.find((r) => isSecrets(r) || reaches(r, s.cwd, c.env, false));
      if (hit) return { decision: 'deny', reason: `This command writes ${hit} (rule \`secrets\`). ${SECRETS_HELP}` };
      const p = base(s.argv[0] ?? ''), acts = p === 'find' && findActs(s.argv);
      if ((INERT.has(p) && !acts) || READERS.has(p)) continue;
      const args = s.argv.slice(1);
      const named = args.some((a) => /secrets\.json/i.test(a) && !/secrets\.example\.json/i.test(a));
      const f = named ? null : args.map((a) => reaches(a, s.cwd, c.env, acts || TREE.has(p))).find(Boolean);
      if (named || f) return { decision: 'deny', reason: `\`${s.argv.join(' ').slice(0, 160)}\` reaches ${f ?? 'a secrets.json file'} and could change or copy it (rule \`secrets\`). ${SECRETS_HELP}` };
    }
    return null;
  },
};

const secretsRead: Policy = {
  id: 'secrets-read', rule: 'secrets',
  check(c) {
    const ask = (p: string): Verdict => ({ decision: 'ask', reason: `Reading ${p} would copy the user's API keys into the transcript (rule \`secrets\`). Allow only if the user asked for it.` });
    if (c.tool === 'Read' && isSecrets(filePath(c)) && existsSync(filePath(c))) return ask(filePath(c));
    // The Grep tool searches folders: pointed at or above the keys, `pattern: "."` prints them all.
    if (c.tool === 'Grep') { const f = reaches(String(c.input.path ?? '') || '.', resolvePath(c.cwd || '.', ROOT), c.env, true); return f ? ask(f) : null; }
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      const p = base(s.argv[0] ?? '');
      if (!READERS.has(p)) continue;
      // Only real files count: `grep -rn secrets.json app/` searches for the name, it does not open the file.
      const f = s.argv.slice(1).map((a) => reaches(a, s.cwd, c.env, recursiveRead(p, s.argv))).find(Boolean);
      if (f) return ask(f);
    }
    return null;
  },
};

/** A shell glob as a regex over one path segment: `*` and `?` stop at `/`, `[!x]` negates, and as in bash a
 *  pattern that does not start with `.` does not match a dot-file. */
export function globRegex(g: string, ci = process.platform === 'win32'): RegExp {
  let r = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') r += '[^/]*';
    else if (ch === '?') r += '[^/]';
    else if (ch === '[' && g.indexOf(']', i + 2) > 0) { const j = g.indexOf(']', i + 2); r += `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = j; }
    else r += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${g.startsWith('.') ? '' : '(?!\\.)'}${r}$`, ci ? 'i' : ''); }
  catch { return new RegExp(`^${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, ci ? 'i' : ''); }   // `[z-a]`: bash matches it literally
}

/** What the shell expands an absolute glob path to, segment by segment. Capped: this runs inside a hook. */
export function expandGlob(p: string, cap = 500): string[] {
  const [root, ...segs] = p.split('/');
  let cur = [root];
  for (const seg of segs) {
    if (!seg) continue;
    if (!/[*?[]/.test(seg)) { cur = cur.map((d) => `${d}/${seg}`); continue; }
    const re = globRegex(seg), next: string[] = [];
    for (const d of cur) {
      let names: string[] = []; try { names = readdirSync(/^[A-Za-z]:$|^$/.test(d) ? `${d}/` : d); } catch {}   // `C:` alone is the drive's cwd
      for (const n of names) if (re.test(n) && next.length < cap) next.push(`${d}/${n}`);
    }
    cur = next;
  }
  return cur;
}

// --- projects-private ---------------------------------------------------------------------------------------------
// projects/ holds the user's references, uploads and films (gitignored). `git add -f` is the only way in, and once a
// film is pushed to a public repo it cannot be taken back.
const PROJECTS = `${ROOT}/projects`;
const gitAddProjects: Policy = {
  id: 'git-add-projects', rule: 'projects-private',
  check(c) {
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      if (base(s.argv[0] ?? '') !== 'git') continue;
      let i = 1, cwd = s.cwd;
      for (; i < s.argv.length && s.argv[i].startsWith('-'); i++) if (s.argv[i] === '-C' || s.argv[i] === '-c') { if (s.argv[i] === '-C') cwd = resolvePath(s.argv[i + 1] ?? '.', cwd); i++; }
      if (!['add', 'stage'].includes(s.argv[i] ?? '') || !within(cwd, ROOT)) continue;
      const args = s.argv.slice(i + 1), dd = args.indexOf('--');
      const opts = dd < 0 ? args.filter((a) => a.startsWith('-')) : args.slice(0, dd).filter((a) => a.startsWith('-'));
      const specs = (dd < 0 ? args.filter((a) => !a.startsWith('-')) : [...args.slice(0, dd).filter((a) => !a.startsWith('-')), ...args.slice(dd + 1)]);
      const force = opts.some((o) => o === '--force' || /^-[a-zA-Z]*f/.test(o));
      const whole = opts.some((o) => o === '-A' || o === '--all' || /^-[a-zA-Z]*A/.test(o)) && !specs.length;
      const paths = specs.map((p) => (p.startsWith(':/') ? `${ROOT}/${p.slice(2)}` : resolvePath(p, cwd)));
      const inside = paths.find((p) => within(p, PROJECTS) && !samePath(p, `${PROJECTS}/.gitkeep`));
      const covers = force && (whole ? ROOT : paths.find((p) => within(PROJECTS, p)));
      if (inside || covers) return { decision: 'deny', reason: `\`${s.argv.join(' ')}\` would stage ${inside ?? 'projects/'} (rule \`projects-private\`): projects/ is the user's references and films and never goes into git. Stage the code you changed by path instead.` };
    }
    return null;
  },
};

// --- one-server ---------------------------------------------------------------------------------------------------
// A second server on the real projects dir runs recoverOrphans() at startup (app/server/jobs.ts) and marks every job
// the first server is running as interrupted. Starting one is fine when none is up, or when it points at a scratch
// dir. restart.sh is the sanctioned way to replace a running one: it refuses while agents are working.
export function startsServer(s: Simple): boolean {
  const a = s.argv, p = base(a[0] ?? '');
  if (['node', 'tsx', 'bun'].includes(p)) return a.slice(1).some((x) => samePath(resolvePath(x, s.cwd), `${ROOT}/app/server/index.ts`));
  if (['npm', 'pnpm', 'yarn'].includes(p)) {
    const pre = a.indexOf('--prefix'), dir = pre > 0 ? resolvePath(a[pre + 1] ?? '.', s.cwd) : s.cwd;
    const script = a.find((x) => ['start', 'server'].includes(x));
    return !!script && samePath(dir, `${ROOT}/app`);
  }
  const script = a.find((x) => /(^|[\\/])start\.(sh|bat|cmd)$/i.test(x)) ?? (/(^|[\\/])start\.(sh|bat|cmd)$/i.test(a[0] ?? '') ? a[0] : null);
  return !!script && samePath(resolvePath(script, s.cwd), `${ROOT}/${script.replace(/^.*[\\/]/, '')}`);
}

export function probeHealth(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((done) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)).on('end', () => { try { done(JSON.parse(b).ok === true); } catch { done(false); } });
    });
    req.on('timeout', () => { req.destroy(); done(false); }).on('error', () => done(false)).end();
  });
}

const secondServer: Policy = {
  id: 'second-server', rule: 'one-server',
  async check(c) {
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      if (!startsServer(s)) continue;
      const dir = s.env.REELMIMIC_PROJECTS ?? c.env.REELMIMIC_PROJECTS;
      if (dir && !samePath(resolvePath(dir, s.cwd), PROJECTS)) continue;   // a scratch projects dir: isolated, fine
      const ports = [...new Set([+(s.env.PORT ?? c.env.PORT ?? 4318), 4318])];
      for (const port of ports) if (await c.probe(port)) {
        return { decision: 'deny', reason: `A ReelMimic server is already running on :${port} against projects/ (rule \`one-server\`). A second one would mark the jobs it is running as interrupted. To pick up server changes run \`bash app/restart.sh\` (it refuses while agents are working); to test, set REELMIMIC_PROJECTS to a scratch folder and PORT to a free port.` };
      }
    }
    return null;
  },
};

export const POLICIES: Policy[] = [secretsWrite, secretsRead, gitAddProjects, secondServer];

export async function evaluate(tool: string, input: Record<string, unknown>, cwd: string, env = process.env, probe = probeHealth): Promise<(Verdict & { policy: string; rule: string }) | null> {
  const commands = SHELL_TOOLS.has(tool) && typeof input.command === 'string' ? parse(input.command, resolvePath(cwd || homedir(), ROOT)) : [];
  const ctx: Ctx = { tool, input, cwd, env, commands, probe };
  let best: (Verdict & { policy: string; rule: string }) | null = null;
  for (const p of POLICIES) {
    const v = await p.check(ctx);
    if (v && (!best || (v.decision === 'deny' && best.decision === 'ask'))) best = { ...v, policy: p.id, rule: p.rule };
    if (best?.decision === 'deny') break;
  }
  return best;
}
