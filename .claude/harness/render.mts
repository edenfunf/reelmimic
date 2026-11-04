// Which shell commands render something an agent must then look at (rule `look-after-render`), and what they wrote.
//   film  — a video: the engines' `render.mjs --encode|--clip`, `hyperframes render`, `remotion render`, or ffmpeg
//           writing a project's out/*.mp4 (the assemble step). The post-render hook builds a contact sheet for it.
//   check — review images the agent asked for (`render.mjs --sheet|--strip|--stills`, `hf_frames.py`): already the
//           thing to Read, so the hook only remembers them until they are read.
// `render.mjs --frames` (frames to disk, encoded later) is neither: the encode that follows is the film.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { base, resolvePath, type Simple } from './lib/shell.mts';
import { VIDEO } from './lib/video.mts';

export interface Render { kind: 'film' | 'check'; out: string | null; engine: string }

const flag = (argv: string[], ...names: string[]) => {
  for (let i = 0; i < argv.length; i++) for (const n of names) {
    if (argv[i] === n) return argv[i + 1] ?? '';
    if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1);
  }
  return null;
};
const has = (argv: string[], ...names: string[]) => argv.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));

export function classify(c: Simple): Render | null {
  const { argv } = c, at = (p: string | null) => (p ? resolvePath(p, c.cwd) : null);
  if (!argv.length) return null;   // a bare redirect (`> log.txt`): found by replaying production commands
  const script = argv.findIndex((a) => /(^|[\\/])render\.mjs$/.test(a));
  if (script >= 0 && ['node', 'bun', 'deno'].includes(base(argv[0]))) {
    const rest = argv.slice(script + 1), out = at(flag(rest, '--out'));
    if (has(rest, '--sheet', '--strip', '--stills', '--loop')) return { kind: 'check', out, engine: 'render.mjs' };
    if (has(rest, '--frames') && !has(rest, '--encode', '--clip')) return null;
    return { kind: 'film', out: out ?? resolvePath('out/video.mp4', c.cwd), engine: 'render.mjs' };
  }
  const hf = argv.findIndex((a) => base(a) === 'hyperframes');
  if (hf >= 0 && argv[hf + 1] === 'render') return { kind: 'film', out: at(flag(argv, '--output', '-o')), engine: 'hyperframes' };
  const rm = argv.findIndex((a) => base(a) === 'remotion');
  if (rm >= 0 && argv[rm + 1] === 'render') return { kind: 'film', out: at(argv.slice(rm + 2).filter((a) => !a.startsWith('-')).find((a) => VIDEO.test(a)) ?? null), engine: 'remotion' };
  if (base(argv[0]).startsWith('python') && argv.some((a) => /(^|[\\/])hf_frames\.py$/.test(a))) return { kind: 'check', out: at(flag(argv, '--out')), engine: 'hf_frames' };
  if (base(argv[0]) === 'ffmpeg') {
    const last = argv[argv.length - 1] ?? '';
    if (VIDEO.test(last) && /(^|[\\/])out[\\/][^\\/]+$/.test(last.replace(/\\/g, '/'))) return { kind: 'film', out: at(last), engine: 'ffmpeg' };
  }
  if (['npm', 'pnpm', 'yarn'].includes(base(argv[0])) && argv.includes('render')) return { kind: 'film', out: null, engine: 'npm run render' };
  return null;
}

/** When a file must have been written to count as this run's output. With the call's start time (recorded on
 *  PreToolUse by tool_use_id) it is exact: anything older is a previous run's leftover, however recent. Without one
 *  (hooks enabled mid-call, an event without an id) fall back to a window. 2 s of slack covers filesystems that store
 *  mtime coarsely (FAT: 2 s) and a render that opens its output file just before the hook's clock reading. */
export interface Freshness { since?: number | null; withinMs?: number; now?: number }
const cutoff = ({ since, withinMs = 180_000, now = Date.now() }: Freshness) => (since ? since - 2000 : now - withinMs);

/** The newest video under `dir` (two levels down, skipping node_modules and dot-dirs) written after the cutoff:
 *  where the output went when the command did not say. */
export function newestVideo(dir: string, f: Freshness = {}): string | null {
  const after = cutoff(f);
  let best: { p: string; t: number } | null = null;
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 2) walk(p, depth + 1); }
      else if (VIDEO.test(n) && st.mtimeMs >= after && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
    }
  };
  walk(dir, 0);
  return best ? (best as { p: string }).p.replace(/\\/g, '/') : null;
}

/** The file this render wrote, if it is there and fresh (a failed render leaves last run's file behind, or nothing).
 *  Only a render that did not say where it writes is looked for: when it did, a missing or stale file means it failed,
 *  and the newest video nearby is some other command's. */
export function freshOutput(r: Render, cwd: string, f: Freshness = {}): string | null {
  if (r.out) {
    try { const st = statSync(r.out); if (st.mtimeMs >= cutoff(f)) return r.out; } catch {}   // a file, or a --stills folder
    return null;
  }
  return r.kind === 'film' ? newestVideo(cwd, f) : null;
}
