// The fast path: which hook events can be answered without loading the TypeScript handlers at all.
// Plain JS on purpose: a .mts entry costs Node's type stripper (≈ 22 ms) before the first line runs, and every tool
// call of every production agent pays this twice (PreToolUse + PostToolUse; 870–2,330 tool calls per job measured).
//
// Contract: each filter is a cheap SUPERSET of what its handler acts on — it may send work to the handler that turns out
// to be nothing, never the reverse. test/fast.test.mts holds every case from the policy and render tests to it.
// Quotes and backslashes are dropped before matching, so `g''it`, "secrets.json" or secrets\.json cannot slip past
// a filter that the full shell parser would have caught.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const stateRoot = () => process.env.REELMIMIC_HARNESS_STATE || join(tmpdir(), 'reelmimic-harness');
/** Per-session state dir; shared with lib/hook.mts so both sides agree on where pending renders live. */
export const sessionDir = (/** @type {string | undefined} */ session) => join(stateRoot(), String(session || 'default').replace(/[^\w-]/g, '_'));

const flat = (/** @type {unknown} */ s) => String(s ?? '').replace(/[\\'"`]/g, '');
const SECRETS = /secrets\.json/i;
// secrets-write/read: the file name · git-add-projects: git · second-server: the entry file, npm/pnpm/yarn, start scripts
const PRE_SHELL = /secrets\.json|\bgit\b|index\.ts|\b(?:npm|pnpm|yarn)\b|start\.(?:sh|bat|cmd)/i;
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
  if (kind === 'pre') return shell ? PRE_SHELL.test(flat(input.command)) : SECRETS.test(String(input.file_path ?? input.notebook_path ?? ''));
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
