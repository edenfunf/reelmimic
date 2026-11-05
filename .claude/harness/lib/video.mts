// What the post-render hook does to a fresh film before the agent looks at it: a contact sheet of evenly spaced
// frames (one image to Read instead of none), and a mechanical scan for the defects that are cheap to find by
// machine — black stretches and frozen picture — so the agent's eyes go to what only eyes can judge.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i;

/** ffmpeg / ffprobe, from FFMPEG_DIR when set (same lookup as app/server/env.ts), else PATH. */
export function bin(name: 'ffmpeg' | 'ffprobe') {
  const d = process.env.FFMPEG_DIR;
  const p = d && join(d, process.platform === 'win32' ? name + '.exe' : name);
  return p && existsSync(p) ? p : name;
}

export async function duration(file: string): Promise<number> {
  const { stdout } = await exec(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 20000 });
  const d = parseFloat(stdout);
  if (!(d > 0)) throw new Error(`no duration for ${file}`);
  return d;
}

export interface Sheet { path: string; times: number[]; cols: number; duration: number }

/** n frames at the middle of n equal slices (never the very first or last frame), tiled into one JPEG. Cached by
 *  file + size + mtime, so asking twice for the same render costs nothing. */
export async function contactSheet(file: string, n = 9, cols = 3, width = 480): Promise<Sheet> {
  const st = statSync(file), dur = await duration(file);
  const key = createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${n}|${cols}|${width}`).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), 'reelmimic-harness', 'sheets'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.jpg`).replace(/\\/g, '/');
  const times = Array.from({ length: n }, (_, k) => +(((k + 0.5) * dur) / n).toFixed(2));
  if (existsSync(path)) return { path, times, cols, duration: dur };
  const work = join(dir, key); mkdirSync(work, { recursive: true });
  try {
    // One seek per frame, in parallel: input seeking is near-instant, decoding the whole film to pick 9 frames is not.
    await Promise.all(times.map((t, k) => exec(bin('ffmpeg'), ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `scale=${width}:-2`, '-q:v', '3', join(work, `${k}.jpg`)], { timeout: 30000 })));
    await exec(bin('ffmpeg'), ['-v', 'error', '-y', '-start_number', '0', '-i', join(work, '%d.jpg'), '-frames:v', '1',
      '-vf', `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=0x18181c`, '-q:v', '3', path], { timeout: 30000 });
  } finally { rmSync(work, { recursive: true, force: true }); }
  return { path, times, cols, duration: dur };
}

export interface Span { start: number; end: number }
export interface Defects { black: Span[]; frozen: Span[]; scanned: boolean }

/** Black (≥ 0.4 s) and frozen (≥ 2.5 s) stretches in one decode pass at low resolution. Films longer than `maxSec`
 *  are skipped: the scan is linear in length and a hook must stay quick. */
export async function defects(file: string, dur: number, maxSec = 300): Promise<Defects> {
  if (dur > maxSec) return { black: [], frozen: [], scanned: false };
  const { stderr } = await exec(bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-an', '-vf',
    'scale=320:-2,blackdetect=d=0.4:pix_th=0.10,freezedetect=n=0.002:d=2.5', '-f', 'null', '-'],
  { timeout: 90000, maxBuffer: 64 * 1024 * 1024 });
  const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: +m[1], end: +m[2] }));
  const fs = [...stderr.matchAll(/freeze_start[:=]\s*([\d.]+)/g)].map((m) => +m[1]);
  const fe = [...stderr.matchAll(/freeze_end[:=]\s*([\d.]+)/g)].map((m) => +m[1]);
  const frozen = fs.map((s, k) => ({ start: s, end: fe[k] ?? dur }));
  return { black, frozen: dedupe(frozen), scanned: true };
}
const dedupe = (L: Span[]) => L.filter((s, i) => L.findIndex((x) => Math.abs(x.start - s.start) < 0.01) === i);
