// PreToolUse policies: the project rules that can be checked before a tool call runs. Each policy names the rule it
// enforces (the ids in CLAUDE.md's rule list); `sync-rules.mts --check` fails CI if a policy points at a rule that no
// longer exists, or a rule claims a policy that is not here. A policy returns null when it has nothing to say; when
// several speak, deny wins over ask. Reasons are written for the agent: what was stopped, why, and the allowed way.
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
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
const isSecrets = (p: string) => /(^|[\\/])secrets\.json$/i.test(p);
const READERS = new Set(['cat', 'type', 'head', 'tail', 'less', 'more', 'bat', 'jq', 'get-content', 'gc', 'grep', 'rg', 'findstr', 'select-string', 'strings', 'od', 'xxd']);
// Mentioning the file is harmless for these: they cannot write it except through a redirect, which is checked anyway.
const INERT = new Set(['echo', 'printf', 'ls', 'dir', 'stat', 'test', '[', 'which', 'git', 'gh', 'find', 'wc', 'file', 'realpath', 'dirname', 'basename']);
const SECRETS_HELP = 'API keys belong to the user and live in ~/.reelmimic/secrets.json (copy secrets.example.json). Tell the user which key to add instead; to check whether one is set, use `test -f ~/.reelmimic/secrets.json` or read it from the environment the server exports.';

const secretsWrite: Policy = {
  id: 'secrets-write', rule: 'secrets',
  check(c) {
    if (WRITE_TOOLS.has(c.tool) && isSecrets(filePath(c))) return { decision: 'deny', reason: `Writing ${filePath(c)} is blocked (rule \`secrets\`). ${SECRETS_HELP}` };
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      const hit = s.redirects.find(isSecrets);
      if (hit) return { decision: 'deny', reason: `This command writes ${hit} (rule \`secrets\`). ${SECRETS_HELP}` };
      const p = base(s.argv[0] ?? '');
      if (!s.argv.slice(1).some((a) => /secrets\.json/i.test(a) && !/secrets\.example\.json/i.test(a)) || INERT.has(p) || READERS.has(p)) continue;
      return { decision: 'deny', reason: `\`${s.argv.join(' ').slice(0, 160)}\` touches a secrets.json file and could change or copy it (rule \`secrets\`). ${SECRETS_HELP}` };
    }
    return null;
  },
};

const secretsRead: Policy = {
  id: 'secrets-read', rule: 'secrets',
  check(c) {
    const ask = (p: string): Verdict => ({ decision: 'ask', reason: `Reading ${p} would copy the user's API keys into the transcript (rule \`secrets\`). Allow only if the user asked for it.` });
    if (c.tool === 'Read' && isSecrets(filePath(c)) && existsSync(filePath(c))) return ask(filePath(c));
    if (!SHELL_TOOLS.has(c.tool)) return null;
    for (const s of c.commands) {
      if (!READERS.has(base(s.argv[0] ?? ''))) continue;
      // Only real files count: `grep -rn secrets.json app/` searches for the name, it does not open the file.
      const f = s.argv.slice(1).map((a) => resolvePath(a, s.cwd)).find((a) => isSecrets(a) && existsSync(a));
      if (f) return ask(f);
    }
    return null;
  },
};

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
