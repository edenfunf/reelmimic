// Reads an agent's shell command the way the shell will run it — enough for policy, not a shell. Splits a command line
// into simple commands (on ; && || | & newlines, subshells and $( ) / `` substitutions, whose insides run too), honours
// quotes and escapes, and tracks what changes between them: `cd` / `pushd` / `git -C` move the working directory,
// `export K=V` and `K=V cmd` set the environment, and `bash -c '…'` / `sh -c` / `env` / `nohup` / `sudo` are unwrapped.
// A regex over the raw string would miss `cd app && npm start` and `echo $(cat ~/.reelmimic/secrets.json)`.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface Simple {
  argv: string[];
  env: Record<string, string>;        // inherited exports + this command's K=V prefixes
  redirects: string[];                // files written by > >> &> (not 2>&1 style fd copies)
  cwd: string;                        // where it runs
}
type Tok = { k: 'w'; v: string } | { k: 'op'; v: string };

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'stdbuf']);
const SHELLS = /^(?:.*[\\/])?(?:bash|sh|zsh|dash)(?:\.exe)?$/i;

export function lex(src: string): Tok[] {
  const out: Tok[] = []; let cur = '', word = false, i = 0;
  const end = () => { if (word) out.push({ k: 'w', v: cur }); cur = ''; word = false; };
  const op = (v: string) => { end(); out.push({ k: 'op', v }); };
  // Here-documents whose bodies start after the current line: `cat <<'EOF' > msg.txt && git commit -F msg.txt`.
  // A body is the command's stdin, not commands. Quoted delimiter: plain data. Unquoted: its $( ) and `…` still run.
  const heredocs: { delim: string; tabs: boolean; quoted: boolean }[] = [];
  const bodies = () => {
    for (const h of heredocs.splice(0)) {
      for (;;) {
        const e = src.indexOf('\n', i), line = src.slice(i, e < 0 ? src.length : e).replace(/\r$/, '');
        i = e < 0 ? src.length : e + 1;
        if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim || e < 0) break;
        for (let j = 0; !h.quoted && j < line.length; j++) {
          let inner: string | null = null;
          if (line[j] === '$' && line[j + 1] === '(') { const e = closeParen(line, j + 1); inner = line.slice(j + 2, e); j = e; }
          else if (line[j] === '`') { const e = line.indexOf('`', j + 1), k = e < 0 ? line.length : e; inner = line.slice(j + 1, k); j = k; }
          if (inner != null) out.push({ k: 'op', v: ';' }, ...lex(inner), { k: 'op', v: ';' });
        }
      }
    }
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1] ?? '';
    if (c === '\\') { if (n === '\n') { i += 2; continue; } cur += n; word = true; i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1), e = j < 0 ? src.length : j; cur += src.slice(i + 1, e); word = true; i = e + 1; continue; }
    if (c === '"') {
      // A $( ) inside double quotes still runs: hand it to the caller as its own command, keep the rest as the word.
      word = true; i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && '"\\$`'.includes(src[i + 1] ?? '')) { cur += src[i + 1]; i += 2; }
        else if (src[i] === '$' && src[i + 1] === '(') { const j = closeParen(src, i + 1); out.push({ k: 'op', v: '(' }, ...lex(src.slice(i + 2, j)), { k: 'op', v: ')' }); i = j + 1; }
        else if (src[i] === '`') { const j = src.indexOf('`', i + 1), e = j < 0 ? src.length : j; out.push({ k: 'op', v: '(' }, ...lex(src.slice(i + 1, e)), { k: 'op', v: ')' }); i = e + 1; }
        else cur += src[i++];
      }
      i++; continue;
    }
    if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { end(); i++; continue; }
    if (c === '\n') { op(';'); i++; bodies(); continue; }
    if (c === '<' && n === '<' && src[i + 2] === '<') { op('<'); i += 3; continue; }   // here-string: the word after it is data
    if (c === '<' && n === '<') {
      end(); i += 2;
      const tabs = src[i] === '-'; if (tabs) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      const m = /^(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\s;&|<>()])+))/.exec(src.slice(i)) ?? ['', '', '', ''];
      const raw = m[3] ?? '';
      heredocs.push({ delim: m[1] ?? m[2] ?? raw.replace(/\\(.)/g, '$1'), tabs, quoted: m[1] != null || m[2] != null || raw.includes('\\') });
      i += m[0].length; continue;
    }
    if (c === '$' && n === '(') { const j = closeParen(src, i + 1); out.push({ k: 'op', v: '(' }, ...lex(src.slice(i + 2, j)), { k: 'op', v: ')' }); i = j + 1; continue; }
    if (c === '`') { const j = src.indexOf('`', i + 1), e = j < 0 ? src.length : j; out.push({ k: 'op', v: '(' }, ...lex(src.slice(i + 1, e)), { k: 'op', v: ')' }); i = e + 1; continue; }
    if (c === '&' && n === '&') { op('&&'); i += 2; continue; }
    if (c === '|' && n === '|') { op('||'); i += 2; continue; }
    if (c === '&' && n === '>') { op(src[i + 2] === '>' ? '>>' : '>'); i += src[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '>' || c === '<') {
      if (word && /^\d+$/.test(cur)) { cur = ''; word = false; }            // 2> file: the fd number is not a word
      if (c === '>' && n === '&') { end(); i += 2; while (/[\d-]/.test(src[i] ?? '')) i++; continue; }   // 2>&1: no file
      const v = c === '>' && n === '>' ? '>>' : c === '<' && n === '<' ? '<<' : c;
      op(v); i += v.length; continue;
    }
    if (';|&()'.includes(c)) { op(c); i++; continue; }
    cur += c; word = true; i++;
  }
  end();
  return out;
}

function closeParen(s: string, open: number) {
  for (let d = 0, i = open; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i; }
  return s.length;
}

/** Every simple command in `src`, in the order they run, with the cwd and environment each one sees. */
export function parse(src: string, cwd: string, env: Record<string, string> = {}, depth = 0): Simple[] {
  const out: Simple[] = []; let words: string[] = [], redirects: string[] = [], pending = '';
  const state = { cwd, env: { ...env } };
  // ( … ) and $( … ) run on their own: park the enclosing command's words, parse the inside, then pick them back up.
  // The inside's `cd` does not leak out (a subshell has its own cwd).
  const stack: { words: string[]; redirects: string[]; pending: string; cwd: string }[] = [];
  const flush = () => {
    if (words.length || redirects.length) out.push(...expand(words, redirects, state, depth));
    words = []; redirects = []; pending = '';
  };
  for (const t of lex(src)) {
    if (t.k === 'op' && (t.v === '>' || t.v === '>>' || t.v === '<' || t.v === '<<')) { pending = t.v; continue; }
    if (t.k === 'op' && t.v === '(') { stack.push({ words, redirects, pending, cwd: state.cwd }); words = []; redirects = []; pending = ''; continue; }
    if (t.k === 'op' && t.v === ')') { flush(); const s = stack.pop(); if (s) { ({ words, redirects, pending } = s); state.cwd = s.cwd; } continue; }
    if (t.k === 'op') { flush(); continue; }
    if (pending) { if (pending === '>' || pending === '>>') redirects.push(resolvePath(t.v, state.cwd)); pending = ''; continue; }
    words.push(t.v);
  }
  flush();
  return out;
}

function expand(words: string[], redirects: string[], state: { cwd: string; env: Record<string, string> }, depth: number): Simple[] {
  const local: Record<string, string> = {};
  let i = 0;
  for (; i < words.length && /^[A-Za-z_]\w*=/.test(words[i]); i++) { const [k, ...v] = words[i].split('='); local[k] = v.join('='); }
  let argv = words.slice(i);
  // Unwrap launchers so the policy sees the real program: `env -i K=V node x`, `nohup node x &`, `sudo -u u cmd`.
  for (;;) {
    const a0 = base(argv[0] ?? '');
    if (a0 === 'env') { argv = argv.slice(1); while (argv[0] && (argv[0].startsWith('-') || argv[0].includes('='))) { const w = argv.shift()!; if (w.includes('=') && !w.startsWith('-')) { const [k, ...v] = w.split('='); local[k] = v.join('='); } } continue; }
    if (WRAPPERS.has(a0)) { argv = argv.slice(1); while (argv[0]?.startsWith('-')) argv = argv.slice(argv[0] === '-u' || argv[0] === '-n' ? 2 : 1); continue; }
    break;
  }
  const env = { ...state.env, ...local };
  if (!argv.length) { Object.assign(state.env, local); return redirects.length ? [{ argv: [], env, redirects, cwd: state.cwd }] : []; }
  const a0 = base(argv[0]);
  if ((a0 === 'cd' || a0 === 'pushd' || a0 === 'set-location' || a0 === 'sl') && argv.length <= 2) {
    const to = argv[1] && argv[1] !== '-' ? argv[1] : argv[1] ? state.cwd : homedir();
    state.cwd = resolvePath(to, state.cwd);
    return [];
  }
  if (a0 === 'export') { for (const w of argv.slice(1)) if (w.includes('=')) { const [k, ...v] = w.split('='); state.env[k] = v.join('='); } return []; }
  const self: Simple = { argv, env, redirects, cwd: state.cwd };
  if (depth < 4 && SHELLS.test(argv[0])) {
    const c = argv.indexOf('-c');
    if (c > 0 && argv[c + 1] != null) return [self, ...parse(argv[c + 1], state.cwd, env, depth + 1)];
  }
  return [self];
}

/** Lower-case program name without directory or .exe/.cmd, so `C:\…\node.exe` and `node` compare equal. */
export const base = (p: string) => p.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

/** An absolute, forward-slash path: `~` → home, Git Bash `/c/Users` → `C:/Users`, relative → against cwd. */
export function resolvePath(p: string, cwd: string): string {
  let s = p.replace(/^~(?=$|[\\/])/, homedir().replace(/\\/g, '/'));
  if (process.platform === 'win32') s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return resolve(cwd, s).replace(/\\/g, '/').replace(/^[a-z](?=:)/, (d) => d.toUpperCase());   // Claude Code reports c:\…, Node C:\…
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\/+$/, '');
export const samePath = (a: string, b: string) => norm(a) === norm(b);
/** True when `child` is `parent` or anything below it. */
export const within = (child: string, parent: string) => { const c = norm(child), p = norm(parent); return c === p || c.startsWith(p + '/'); };
