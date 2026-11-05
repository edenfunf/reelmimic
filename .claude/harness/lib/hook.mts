// Shared plumbing for the Claude Code hooks: read the event from stdin, answer on stdout, keep an audit trail, and keep
// per-session state between hooks (a render seen by PostToolUse is what the Stop hook later checks for).
//
// Failure policy: a hook that crashes must never take the agent down or block work, so every handler runs through
// `respond()`, which logs the error and returns no decision (fail open). Guardrails here catch honest mistakes by an
// agent working in this repo; they are not a sandbox against a hostile one (see docs/HARNESS.md, "Limits").
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionDir } from '../hooks/fast.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..').replace(/\\/g, '/');

export interface HookEvent {
  session_id?: string;
  tool_use_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}
export type Handler = (e: HookEvent) => Promise<Output | null> | Output | null;

export type Output =
  | { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny' | 'ask'; permissionDecisionReason: string } }
  | { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } }
  | { decision: 'block'; reason: string };

const AUDIT = () => process.env.REELMIMIC_HARNESS_AUDIT || join(ROOT, '.claude/harness/audit.jsonl');

/** One line per decision the harness made (deny / ask / injected context / block / crash), for `tail` and review.
 *  Inside a production job the app sets REELMIMIC_JOB_DIR / REELMIMIC_AGENT on the agent (app/server/turn.ts), and the
 *  same line also goes to that project's logs/harness.jsonl, next to events.jsonl, where timeline.py reports it. */
export function audit(rec: Record<string, unknown>) {
  const job = process.env.REELMIMIC_JOB_DIR, line = JSON.stringify({ ts: new Date().toISOString(), agent: process.env.REELMIMIC_AGENT, ...rec }) + '\n';
  try { appendFileSync(AUDIT(), line); } catch {}
  if (job) try { mkdirSync(join(job, 'logs'), { recursive: true }); appendFileSync(join(job, 'logs', 'harness.jsonl'), line); } catch {}
}

/** Run a handler on the raw event and print its decision. Never throws: errors are audited and mean "no decision". */
export async function respond(name: string, raw: string, handle: Handler) {
  let e: HookEvent = {};
  try {
    e = JSON.parse(raw || '{}');
    if (process.env.REELMIMIC_HARNESS_DEBUG) audit({ hook: name, debug: e });
    const out = await handle(e);
    if (out) {
      audit({ hook: name, session: e.session_id, tool: e.tool_name, out });
      process.stdout.write(JSON.stringify(out));
    }
  } catch (err) {
    audit({ hook: name, session: e.session_id, tool: e.tool_name, error: String((err as Error)?.stack || err) });
  }
}

// --- session state: one file per pending item, so parallel tool calls never race on a shared read-modify-write ---

export interface Pending { id: string; kind: 'film' | 'check'; path: string; sheet?: string; at: number; command: string }
const dirOf = (session: string) => sessionDir(session);

/** When the call that may have rendered started (written by dispatch.mjs on PreToolUse), or null. Consumed once. */
export function takeStart(session: string, toolUseId: string | undefined): number | null {
  if (!toolUseId) return null;
  const f = join(dirOf(session), 'starts', toolUseId.replace(/[^\w-]/g, '_'));
  try { const t = +readFileSync(f, 'utf8'); rmSync(f, { force: true }); return t > 0 ? t : null; } catch { return null; }
}

export function addPending(session: string, p: Omit<Pending, 'id'>) {
  const d = dirOf(session); mkdirSync(d, { recursive: true });
  const id = `${p.at}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(d, id + '.json'), JSON.stringify({ id, ...p }));
}
export function listPending(session: string): Pending[] {
  const d = dirOf(session);
  try {
    return readdirSync(d).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try { return [JSON.parse(readFileSync(join(d, f), 'utf8')) as Pending]; } catch { return []; }
    });
  } catch { return []; }
}
export function clearPending(session: string, id: string) { rmSync(join(dirOf(session), id + '.json'), { force: true }); }
