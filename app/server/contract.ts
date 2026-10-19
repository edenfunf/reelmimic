// The JSON files agents write and the server decides on (CONTRACT.md), checked when the turn that wrote them ends.
// Only the fields the server reads are checked, and extra fields are fine. A broken file goes back to the agent that wrote it
// (turn.ts) instead of being read as {} — an empty review would fail the gate, an empty plan would build nothing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../shared/types.ts';
import type { Production } from './types.ts';

type Check = (v: unknown, at: string) => string[];

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const is = (want: string): Check => (v, at) => (kind(v) === want ? [] : [`${at}: expected ${want}, got ${kind(v)}`]);
const str = is('string'), num = is('number'), bool = is('boolean');
const either = (...cs: Check[]): Check => (v, at) => { const all = cs.map((c) => c(v, at)); return all.some((p) => !p.length) ? [] : all[0]; };
const arr = (item: Check, { min = 0 } = {}): Check => (v, at) => {
  if (!Array.isArray(v)) return is('array')(v, at);
  if (v.length < min) return [`${at}: needs at least ${min} item${min > 1 ? 's' : ''}`];
  return v.flatMap((x, i) => item(x, `${at}[${i}]`));
};
const obj = (fields: Record<string, Check>, required: string[] = []): Check => (v, at) => {
  if (kind(v) !== 'object') return is('object')(v, at);
  const o = v as Record<string, unknown>;
  return [
    ...required.filter((k) => o[k] === undefined).map((k) => `${at}.${k}: missing`),
    ...Object.entries(fields).flatMap(([k, c]) => (o[k] === undefined ? [] : c(o[k], `${at}.${k}`))),
  ];
};
const nul: Check = (v, at) => (v === null ? [] : [`${at}: expected null`]);

const need = obj({ issue: str }, ['issue']);
const issue = obj({ issue: str, severity: str }, ['issue']);
const review: Check = (v, at) => {
  const p = obj({ pass: bool, issues: arr(issue), needs_user: arr(need), shots: arr(obj({ id: str, pass: bool, issues: arr(issue) }, ['id'])) })(v, at);
  if (p.length) return p;
  const o = v as Record<string, unknown>;   // a verdict is required: an empty review would read as "failed, nothing to fix"
  return typeof o.pass === 'boolean' || Array.isArray(o.issues) || Array.isArray(o.shots) ? [] : [`${at}: needs "pass", "issues" or "shots"`];
};
const fix = obj({ status: str, issue: str });
const fixes = either(arr(fix), obj({ fixes: arr(fix) }, ['fixes']));

const SCHEMAS: [RegExp, Check][] = [
  [/(^|\/)analysis\/route\.json$/, obj({ engine: str, style: str })],
  [/(^|\/)plan\.json$/, obj({
    title: str, version: either(num, str),
    characters: arr(obj({ id: str, name: str, file: str }, ['id'])),
    assets: arr(obj({ id: str, status: str })),
    required_inputs: arr(obj({ id: str, kind: str, label: str, file: str, match: str }, ['id', 'kind'])),
    music: obj({ file: str }),
  })],
  [/(^|\/)build\/production\.json$/, obj({
    chunks: arr(obj({ id: str, shots: arr(str, { min: 1 }) }, ['id', 'shots']), { min: 1 }),
    characters: arr(obj({ id: str, name: str, file: str, sheet: str }, ['id'])),
    rig_files: arr(str),
  }, ['chunks'])],
  [/(^|\/)out\/check\/critique\.json$/, obj({ must_fix: arr(either(nul, obj({ issue: str }, ['issue']))), needs_user: arr(need) })],
  [/(^|\/)(review(_[^/]+)?|[^/]+\.review)\.json$/, review],
  [/(^|\/)(fixes(_[^/]+)?|[^/]+\.fixes)\.json$/, fixes],
];

// Problems with one agent-written file (project-relative path), [] when it's fine. Any .json must at least parse.
export function checkFile(rel: string, text: string): string[] {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return [`${rel}: not valid JSON (${(e as Error).message})`]; }
  const s = SCHEMAS.find(([re]) => re.test(rel));
  return s ? s[1](v, rel) : [];
}

// Setup and retries must agree on the cast before deciding which review artifacts are required.
// Never infer "no characters" from an empty production array when the approved plan still lists a cast.
export function checkProduction(dir: string): string[] {
  const texts: Record<string, string> = {};
  const bad = ['plan.json', 'build/production.json'].flatMap((file) => {
    try { texts[file] = readFileSync(join(dir, file), 'utf8'); }
    catch { return [`${file}: missing or unreadable`]; }
    return checkFile(file, texts[file]);
  });
  if (bad.length) return bad;
  const plan = JSON.parse(texts['plan.json']) as Plan, prod = JSON.parse(texts['build/production.json']) as Production;
  const planned = plan.characters || [], produced = prod.characters || [];
  const ids = new Set(planned.map((c) => c.id)), actual = new Set(produced.map((c) => c.id));
  if (ids.size !== planned.length) bad.push('plan.json.characters: duplicate character IDs');
  if (actual.size !== produced.length) bad.push('build/production.json.characters: duplicate character IDs');
  for (const id of ids) if (!actual.has(id)) bad.push(`build/production.json.characters: planned character "${id}" is missing; reconcile cast versus assets without deleting scene objects`);
  for (const id of actual) if (!ids.has(id)) bad.push(`build/production.json.characters: unplanned character "${id}"`);
  // A mismatch needs a classification decision first, not an invented sheet for a motion-graphics asset.
  if (bad.length) return bad;
  if (produced.length && !existsSync(join(dir, 'out/check/cast/sheet.jpg'))) bad.push('out/check/cast/sheet.jpg: required for character-based production');
  for (const c of produced) {
    if (!c.file?.trim()) bad.push(`build/production.json.characters.${c.id}.file: required`);
    if (!c.sheet?.trim()) bad.push(`build/production.json.characters.${c.id}.sheet: required`);
    else if (!existsSync(join(dir, c.sheet))) bad.push(`${c.sheet}: missing character sheet for "${c.id}"`);
  }
  return bad;
}
