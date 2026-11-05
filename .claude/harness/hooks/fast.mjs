// The fast path: which hook events can be answered without loading the TypeScript handlers at all.
// Plain JS on purpose: a .mts entry costs Node's type stripper (≈ 22 ms) before the first line runs, and every tool
// call of every production agent pays this twice (PreToolUse + PostToolUse; 870–2,330 tool calls per job measured).
//
// Contract: each filter is a cheap SUPERSET of what its handler acts on — it may send work to the handler that turns out
// to be nothing, never the reverse. test/fast.test.mts holds every case from the policy and render tests to it.
// Quotes and backslashes are dropped before matching, so `g''it`, "secrets.json" or secrets\.json cannot slip past
// a filter that the full shell parser would have caught.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const stateRoot = () => process.env.REELMIMIC_HARNESS_STATE || join(tmpdir(), 'reelmimic-harness');
/** Per-session state dir; shared with lib/hook.mts so both sides agree on where pending renders live. */
export const sessionDir = (/** @type {string | undefined} */ session) => join(stateRoot(), String(session || 'default').replace(/[^\w-]/g, '_'));

/** Where the API keys can be, as app/server/env.ts looks for them: the env override, then ~/.reelmimic, then the
 *  pre-rename ~/.clone-studio. Absolute, forward slashes. Shared with policy.mts. */
export const secretFiles = (/** @type {Record<string, string | undefined>} */ env = process.env) =>
  [env.REELMIMIC_SECRETS, env.CLONE_STUDIO_SECRETS, join(homedir(), '.reelmimic', 'secrets.json'), join(homedir(), '.clone-studio', 'secrets.json')]
    .filter((p) => !!p).map((p) => resolve(String(p)).replace(/\\/g, '/'));

const flat = (/** @type {unknown} */ s) => String(s ?? '').replace(/[\\'"`]/g, '');
const SECRETS = /secrets\.json/i;
// secrets-write/read: the file name, its folders, a home-relative path · git-add-projects: git ·
// second-server: the entry file, npm/pnpm/yarn, start scripts
// (`Program Files/Git/` is a folder, never the program the git policy looks at.)
const PRE_SHELL = /secrets|\.reelmimic|\.clone-studio|~|\bgit\b(?![\\/])|index\.ts|\b(?:npm|pnpm|yarn)\b|start\.(?:sh|bat|cmd)/i;
/** `$PATH`, `$PYTHONPATH`, `$PATHEXT`, …: search lists, not a path. Neither side expands them (lib/shell.mts expandVars). */
export const LIST_VAR = /PATH(?:EXT)?$/i;
// Folder-walking commands (policy.mts TREE, recursive readers, find): the only ones a bare `/` matters to.
const WALKS = /(?:^|[;&|(\n])\s*(?:sudo\s+)?(?:rm|rmdir|mv|cp|rsync|scp|tar|zip|7z|chmod|chown|shred|del|erase|rd|remove-item|ri|move-item|mi|copy-item|cpi|robocopy|xcopy|compress-archive|grep|egrep|fgrep|rg|ag|findstr|find|xargs)\b/im;

// The secrets policies also act on a folder above the keys (`rm -rf $HOME`, `grep -r . /c/Users/me`, `cd ../.. && cp
// -r . /tmp`). A command can only reach such a folder through an absolute path, a bare `cd` (home), or by climbing
// with `..` from where it runs. Each is checked on the command with variables expanded as the parser expands them.
const norm = (/** @type {string} */ p) => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
/** True when `dir` is the keys file or a folder they sit under. */
export const aboveSecrets = (/** @type {string} */ dir) => { const d = norm(dir); return secretFiles().some((f) => { const n = norm(f); return n === d || n.startsWith(`${d}/`); }); };
const expand = (/** @type {string} */ s) => s.replace(/\$\{([A-Za-z_]\w*)\}|\$env:([A-Za-z_]\w*)|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/gi,
  (m, a, b, c, d) => { const k = a ?? b ?? c ?? d; return LIST_VAR.test(k) ? m : process.env[k] ?? (/^(?:HOME|USERPROFILE)$/i.test(k) ? homedir() : m); });
// `\(` or `\|` is an escape, not the drive root; `\Users\me` (quoted) is a path.
const isAbs = (/** @type {string} */ t) => /^(?:[A-Za-z]:[\\/]|\/|\\(?=[\w.]))/.test(t);
const climbsAbove = (/** @type {string} */ cmd, /** @type {string} */ cwd) => {
  const q = expand(String(cmd).replace(/['"`]/g, ''));
  if (/(?:^|[;&|(\n])\s*(?:cd|pushd|set-location|sl)\s*(?:$|[;&|)\n])/im.test(q)) return true;   // bare cd: home
  // Every directory the command can be in starts from the event's cwd or an absolute `cd` target, and moves from there
  // by descending or by `..`. So anything it reaches by climbing lies under one of those, climbed at most k levels
  // (k = every `..` in the command). If none of those is above the keys, no relative path is. A command that opens
  // with `cd /abs` never uses the event's cwd (the parser applies a cd in order, and a subshell restores the cwd it
  // was opened in, which is already after it).
  const k = (q.match(/\.\.(?=[\\/]|$|[\s;&|)])/g) ?? []).length;
  const up = (/** @type {string} */ p) => aboveSecrets(resolve(gitBash(p), ...Array(k).fill('..')));
  const lead = /^\s*(?:cd|pushd|set-location|sl)(?:\s+-\S*)*\s+([^\s;&|)]+)\s*[;&|\n]/i.exec(q);
  if (!(lead && isAbs(lead[1])) && up(cwd || '.')) return true;
  for (const m of q.matchAll(/(?:^|[\s;&|(])(?:cd|pushd|set-location|sl)(?:\s+-\S*)*\s+([^\s;&|)]+)/gim)) if (isAbs(m[1]) && up(m[1])) return true;
  const walks = WALKS.test(q);
  return words(expand(String(cmd))).some(({ w, spaced }) => [w, w.slice(w.indexOf('=') + 1)].some((t) => {   // `D=/abs`: its value too
    if (!isAbs(t)) return false;
    // A glob, unless it was quoted with spaces (the shell does not glob a quoted word; policy.mts reaches() agrees).
    if (/[*?[]/.test(t) && !spaced) return aboveSecrets(resolve(gitBash(t.replace(/[^\\/]*[*?[].*$/, '')) || '/'));   // its literal folder
    return (walks || !/^(?:[A-Za-z]:)?[\\/]+$/.test(t)) && aboveSecrets(resolve(gitBash(t)));   // `/` alone matters only to a walker
  }));
};
/** Words as lib/shell.mts lex() splits them: quotes group and are dropped, `\` escapes as bash does inside and outside
 *  double quotes, operators separate. `spaced`: the word holds whitespace, so it was quoted. Here-documents are not
 *  told apart from commands: their text is checked too, which only sends more to the handler. */
const words = (/** @type {string} */ s) => {
  /** @type {{ w: string, spaced: boolean }[]} */ const out = [];
  let cur = '', q = '', any = false;
  const end = () => { if (any) out.push({ w: cur, spaced: /\s/.test(cur) }); cur = ''; any = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = ''; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = ''; else if (c === '\\' && '"\\$`'.includes(s[i + 1] ?? '')) cur += s[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; any = true; continue; }
    if (c === '\\') { if (s[i + 1] !== '\n') cur += s[i + 1] ?? ''; i++; any = true; continue; }
    if (/[\s;&|()<>`]/.test(c)) { end(); continue; }
    cur += c; any = true;
  }
  end();
  return out;
};
/** Git Bash `/c/Users` → `C:/Users` on Windows, as lib/shell.mts resolvePath does. */
const gitBash = (/** @type {string} */ p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:') : p);
// render.mts classify(): render.mjs, hyperframes, remotion, hf_frames.py, ffmpeg, `npm run render`
const RENDER = /render|hf_frames|ffmpeg|hyperframes|remotion/i;

const hasPending = (/** @type {string | undefined} */ session) => {
  const d = sessionDir(session);
  try { return existsSync(d) && readdirSync(d).some((f) => f.endsWith('.json')); } catch { return true; }
};

/**
 * @param {'pre' | 'post' | 'stop'} kind
 * @param {any} e the hook event, or null when stdin was not JSON (the handler logs that)
 */
export function needsHandler(kind, e) {
  if (!e || typeof e !== 'object') return true;
  const input = e.tool_input ?? {}, shell = e.tool_name === 'Bash' || e.tool_name === 'PowerShell';
  if (kind === 'pre') {
    if (shell) return PRE_SHELL.test(expand(flat(input.command))) || climbsAbove(input.command, e.cwd);
    if (e.tool_name === 'Grep') { const p = String(input.path ?? ''); return SECRETS.test(p) || /[*?[]/.test(p) || aboveSecrets(resolve(e.cwd || '.', gitBash(p) || '.')); }
    return SECRETS.test(String(input.file_path ?? input.notebook_path ?? ''));
  }
  if (kind === 'post') return shell ? RENDER.test(flat(input.command)) : e.tool_name === 'Read' && hasPending(e.session_id);
  if (kind === 'stop') return !e.stop_hook_active && hasPending(e.session_id);
  return true;
}

/** PreToolUse of a command that may render: note when it started, keyed by tool_use_id, so PostToolUse can tell the
 *  file this run wrote from one an earlier run left behind (exactly, instead of guessing from a time window). */
export function markStart(/** @type {any} */ e) {
  if (!e?.tool_use_id || !(e.tool_name === 'Bash' || e.tool_name === 'PowerShell') || !RENDER.test(flat(e.tool_input?.command))) return;
  try {
    const d = join(sessionDir(e.session_id), 'starts'); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, String(e.tool_use_id).replace(/[^\w-]/g, '_')), String(Date.now()));
  } catch {}
}
