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
    if (anchor && !read(file).includes(anchor)) P.push(`\`${id}\`: "${anchor}" no longer appears in ${file}`);
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
