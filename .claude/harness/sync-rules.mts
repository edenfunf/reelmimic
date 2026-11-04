// One rule set, two agents. CLAUDE.md (Claude Code) is the source; AGENTS.md (Codex) carries a copy of its shared block
// between the `harness:shared` markers. This script keeps the copy, the enforcement table (rules.mts) and the table
// in docs/HARNESS.md in step:
//   node .claude/harness/sync-rules.mts --check   CI: exit 1 listing every drift
//   node .claude/harness/sync-rules.mts --write   copy CLAUDE.md's block into AGENTS.md, regenerate the docs table
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/hook.mts';
import { POLICIES } from './policy.mts';
import { ENFORCEMENT, LAYERS, type Layer } from './rules.mts';

const SHARED = ['<!-- harness:shared', '<!-- /harness:shared -->'] as const;
const TABLE = ['<!-- harness:table', '<!-- /harness:table -->'] as const;
const RULE_LINE = /^- `([a-z0-9][a-z0-9-]*)` /;

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/** The text between a marker pair (the opening marker may carry a comment), or null when the markers are missing. */
export function block(text: string, [open, close]: readonly [string, string]): string | null {
  const a = text.indexOf(open), b = text.indexOf(close);
  if (a < 0 || b < a) return null;
  return text.slice(text.indexOf('\n', a) + 1, b);
}
function replaceBlock(text: string, [open, close]: readonly [string, string], body: string) {
  const a = text.indexOf(open), b = text.indexOf(close);
  return text.slice(0, text.indexOf('\n', a) + 1) + body + text.slice(b);
}
/** `src` with its comments blanked out, strings kept: an anchor must name live code or text, not a comment that still
 *  mentions a function after it is gone. JS/TS: `//`, `/* *\/`, with strings, templates and regex literals skipped
 *  so `'//'` or `/["']/` cannot open a false comment. Python / shell / .gitignore: `#` (shell only at a word start).
 *  Markdown: `<!-- -->`. Newlines are kept, so nothing joins across a removed comment. */
export function uncommented(src: string, file: string): string {
  if (/\.md$/i.test(file)) return src.replace(/<!--[\s\S]*?-->/g, '');
  if (/\.(?:py|sh)$|(?:^|\/)\.gitignore$/i.test(file)) {
    const py = /\.py$/i.test(file); let out = '', q = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { out += c; if (c === '\\') out += src[++i] ?? ''; else if (src.startsWith(q, i)) { out += q.slice(1); i += q.length - 1; q = ''; } continue; }
      if (c === '#' && (py || i === 0 || /\s/.test(src[i - 1]))) { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
      if ((c === '"' || c === "'") && !/\.gitignore$/.test(file)) { q = py && src.startsWith(c.repeat(3), i) ? c.repeat(3) : c; out += q; i += q.length - 1; continue; }
      out += c;
    }
    return out;
  }
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(file)) return src;
  let out = '';
  // Code up to the `}` that closes a template's `${` (when `close`), or to the end. `last` is the last significant
  // character: after an operator or bracket a `/` starts a regex, after a name or `)` it divides.
  const code = (i: number, close: boolean): number => {
    let depth = 0, last = '';
    for (; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (close && c === '{') depth++;
      else if (close && c === '}' && depth-- === 0) { out += c; return i + 1; }
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ''); i = end - 1; continue; }
      if (c === '`') { out += c; i = template(i + 1) - 1; last = c; continue; }
      if (c === '"' || c === "'" || (c === '/' && (!last || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)))) {
        let j = i + 1, cls = false;
        for (; j < src.length && src[j] !== '\n'; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (c === '/' && src[j] === '[') cls = true; else if (cls && src[j] === ']') cls = false;
          else if (src[j] === c && !cls) break;
        }
        out += src.slice(i, j + 1); i = j; last = c; continue;
      }
      out += c; if (!/\s/.test(c)) last = c;
    }
    return i;
  };
  // A template literal from just after its opening backtick; its `${ … }` parts are code (and may hold templates).
  const template = (i: number): number => {
    for (; i < src.length; i++) {
      if (src[i] === '\\') { out += src.slice(i, i + 2); i++; continue; }
      if (src[i] === '`') { out += '`'; return i + 1; }
      if (src[i] === '$' && src[i + 1] === '{') { out += '${'; i = code(i + 2, true) - 1; continue; }
      out += src[i];
    }
    return i;
  };
  code(0, false);
  return out;
}

/** True when `anchor` appears in `file` outside comments; a bare identifier must appear as a whole word. */
export function anchored(src: string, file: string, anchor: string): boolean {
  const code = uncommented(src.replace(/\r\n/g, '\n'), file);
  return /^[A-Za-z_$][\w$]*$/.test(anchor) ? new RegExp(`(?<![\\w$])${anchor.replace(/\$/g, '\\$')}(?![\\w$])`).test(code) : code.includes(anchor);
}

export const ruleIds = (shared: string) => shared.split('\n').map((l) => RULE_LINE.exec(l)?.[1]).filter((x): x is string => !!x);

export function renderTable(): string {
  const order: Layer[] = ['hook', 'runtime', 'ci', 'tool', 'git', 'prompt'];
  const rows = Object.entries(ENFORCEMENT).map(([id, L]) => {
    const by = [...L].sort((x, y) => order.indexOf(x.layer) - order.indexOf(y.layer));
    const strongest = by[0].layer;
    const cell = by.map((e) => `**${e.layer}** [${e.at.split('#')[0].replace(/^.*\//, '')}](../${e.at.split('#')[0]}) — ${e.how}`).join('<br>');
    return `| \`${id}\` | ${strongest === 'prompt' ? '⚠️ prompt only' : strongest} | ${cell} |`;
  });
  const legend = order.map((l) => `- **${l}** — ${LAYERS[l]}`).join('\n');
  return `| rule | strongest layer | enforced by |\n|---|---|---|\n${rows.join('\n')}\n\n${legend}\n`;
}

/** Every drift between the rule files, the enforcement table, the policies and the docs. Empty when in step. */
export function problems(): string[] {
  const P: string[] = [];
  const claude = read('CLAUDE.md'), agents = read('AGENTS.md'), docs = read('docs/HARNESS.md');
  const src = block(claude, SHARED), copy = block(agents, SHARED);
  if (src == null) return ['CLAUDE.md: no harness:shared block'];
  if (copy == null) P.push('AGENTS.md: no harness:shared block');
  else if (copy !== src) P.push('AGENTS.md: shared block differs from CLAUDE.md (run sync-rules.mts --write)');
  const ids = ruleIds(src);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) P.push(`CLAUDE.md: rule \`${d}\` listed twice`);
  for (const id of ids) if (!ENFORCEMENT[id]) P.push(`rule \`${id}\` (CLAUDE.md) has no entry in rules.mts`);
  for (const id of Object.keys(ENFORCEMENT)) if (!ids.includes(id)) P.push(`rules.mts: \`${id}\` is not a rule in CLAUDE.md`);
  for (const [id, L] of Object.entries(ENFORCEMENT)) for (const e of L) {
    const [file, anchor] = e.at.split('#');
    if (!existsSync(join(ROOT, file))) { P.push(`\`${id}\`: ${file} does not exist`); continue; }
    if (anchor && !anchored(read(file), file, anchor)) P.push(`\`${id}\`: "${anchor}" no longer appears in ${file} (comments do not count)`);
    if (e.layer === 'hook' && file.endsWith('policy.mts') && !POLICIES.some((p) => p.id === anchor && p.rule === id)) P.push(`\`${id}\`: policy.mts has no policy "${anchor}" for this rule`);
  }
  for (const p of POLICIES) {
    if (!ids.includes(p.rule)) P.push(`policy \`${p.id}\` enforces \`${p.rule}\`, which is not a rule in CLAUDE.md`);
    if (!(ENFORCEMENT[p.rule] ?? []).some((e) => e.at.endsWith(`#${p.id}`))) P.push(`policy \`${p.id}\` is missing from rules.mts`);
  }
  const t = block(docs, TABLE);
  if (t == null) P.push('docs/HARNESS.md: no harness:table block');
  else if (t !== renderTable()) P.push('docs/HARNESS.md: enforcement table is stale (run sync-rules.mts --write)');
  return P;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--write')) {
    const src = block(read('CLAUDE.md'), SHARED);
    if (src == null) { console.error('CLAUDE.md: no harness:shared block'); process.exit(1); }
    writeFileSync(join(ROOT, 'AGENTS.md'), replaceBlock(read('AGENTS.md'), SHARED, src));
    writeFileSync(join(ROOT, 'docs/HARNESS.md'), replaceBlock(read('docs/HARNESS.md'), TABLE, renderTable()));
  }
  const P = problems();
  for (const p of P) console.error('✗ ' + p);
  if (P.length) process.exit(1);
  console.log(`✓ rules in step: ${Object.keys(ENFORCEMENT).length} rules, ${POLICIES.length} policies, AGENTS.md and docs/HARNESS.md match CLAUDE.md`);
}
