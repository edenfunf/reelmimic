// Agent adapters: run one turn of Claude Code, Codex or OpenCode headlessly, stream normalised events, return the session id so
// the next turn continues the same conversation (the "discussion" with the user lives inside that session).
//
//   runAgent({ kind, cwd, prompt, sessionId, onEvent, signal }) → Promise<AgentResult>
//
// Normalised events passed to onEvent:
//   { type: 'session', id }                      session/thread id known
//   { type: 'text', text }                        assistant prose
//   { type: 'tool', name, detail }                a tool call / shell command starting
//   { type: 'done', ok, text, cost? }             turn finished
//   { type: 'error', text }                       stderr or a failure
//
// The prompt always goes through stdin, so nothing user-typed is ever put on a command line.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AgentEvent, AgentKind, AgentStatus } from '../../shared/types.ts';
import { killTree, treeOpts } from '../runner.ts';

const IS_WIN = process.platform === 'win32';
// An old codex-cli can shadow a current one on PATH (e.g. a runtime manager's copy). Prefer CODEX_BIN, then npm's global shim.
const NPM_CODEX = IS_WIN && process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'codex.cmd') : null;
const NPM_OPENCODE = IS_WIN && process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'opencode.cmd') : null;
// Resolved per call, not at load, so a codex installed through npm after the server started is found on the next probe
const codexBin = () => process.env.CODEX_BIN || (NPM_CODEX && existsSync(NPM_CODEX) ? NPM_CODEX : 'codex');
const opencodeBin = () => process.env.OPENCODE_BIN || (NPM_OPENCODE && existsSync(NPM_OPENCODE) ? NPM_OPENCODE : 'opencode');
// OpenCode uses the model from OPENCODE_MODEL (secrets.json); without it, the CLI's own default is used.
const opencodeModel = () => process.env.OPENCODE_MODEL || '';
const CLAUDE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,Skill,WebFetch,WebSearch,TodoWrite';

export interface AgentRun {
  kind: AgentKind;
  cwd: string;
  prompt: string;
  sessionId?: string | null;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}
export interface AgentResult { sessionId?: string | null; text: string; ok: boolean; code: number | null; stderr: string; lastError: string }
// Turn state while the CLI streams: filled in by the parsers, returned when the process closes
interface TurnState { sessionId?: string | null; text: string; ok: boolean; cost: number | null; lastError: string }
type Emit = (e: AgentEvent) => void;
// One line of the CLIs' JSON streams; only the fields read below
type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

// Async: the probe re-runs while agent turns are streaming, and a blocking --version (slow on a cold Windows shell) would stall the server.
// Note the server keeps the PATH it started with: a CLI installed into a new PATH directory still needs a restart.
function probe(cmd: string): Promise<string | null> {
  return new Promise((done) => {
    let out = '';
    const child = spawn(cmd, ['--version'], { shell: IS_WIN, stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { out += d; });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim().split('\n')[0] || null : null));
  });
}

export async function agentStatus(): Promise<AgentStatus> {
  const [claude, codex, opencode] = await Promise.all([probe('claude'), probe(codexBin()), probe(opencodeBin())]);
  return { claude, codex, opencode };
}

function lines(stream: Readable, onLine: (l: string) => void) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
  stream.on('end', () => { if (buf.trim()) onLine(buf.trim()); });
}

const short = (v: unknown, n = 400) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

function claudeArgs(sessionId?: string | null) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_TOOLS];
  if (sessionId) a.push('--resume', sessionId);
  return a;
}
export function parseClaude(obj: Json, emit: Emit, st: TurnState) {
  if (obj.session_id && obj.session_id !== st.sessionId) { st.sessionId = obj.session_id; emit({ type: 'session', id: obj.session_id }); }
  if (obj.type === 'assistant' && obj.message?.content) {
    for (const c of obj.message.content) {
      if (c.type === 'text' && c.text.trim()) { st.text = c.text; emit({ type: 'text', text: c.text }); }
      if (c.type === 'thinking' && (c.thinking || '').trim()) emit({ type: 'thinking', text: short(c.thinking, 1200) });
      if (c.type === 'tool_use') emit({ type: 'tool', name: c.name, detail: short(c.input?.command || c.input?.file_path || c.input?.skill || c.input?.pattern || c.input) });
    }
  }
  if (obj.type === 'result') { st.ok = obj.subtype === 'success' && !obj.is_error; if (obj.result) st.text = obj.result; st.cost = obj.total_cost_usd; }
}

function codexArgs(sessionId: string | null | undefined, cwd: string) {
  // No approval prompts (headless). Codex's workspace-write sandbox can't start Chrome (spawn EPERM), and every render
  // needs it, so the default is full access — the same reach Claude Code gets with Bash allowed. Set CODEX_SANDBOX=
  // workspace-write to keep the sandbox (planning works; rendering won't). Set via -c: works for exec and resume.
  const mode = process.env.CODEX_SANDBOX || 'danger-full-access';
  const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode=${mode}`, '-c', 'approval_policy=never',
    ...(mode === 'workspace-write' ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])];
  return sessionId ? ['exec', 'resume', ...common, sessionId, '-'] : ['exec', ...common, '-C', cwd, '-'];
}
export function parseCodex(obj: Json, emit: Emit, st: TurnState) {
  const id = obj.thread_id || obj.session_id || obj.conversation_id;
  if (id && id !== st.sessionId) { st.sessionId = id; emit({ type: 'session', id }); }
  const it = obj.item;
  if (it && obj.type === 'item.completed' && it.type === 'agent_message' && it.text) { st.text = it.text; emit({ type: 'text', text: it.text }); }
  if (it && obj.type === 'item.started' && it.type === 'command_execution') emit({ type: 'tool', name: 'shell', detail: short(it.command) });
  if (it && obj.type === 'item.completed' && it.type === 'reasoning' && (it.text || '').trim()) emit({ type: 'thinking', text: short(it.text, 1200) });
  if (it && obj.type === 'item.completed' && it.type === 'file_change') emit({ type: 'tool', name: 'edit', detail: short((it.changes || []).map((c: { path: string }) => c.path).join(', ')) });
  if (obj.type === 'turn.completed') st.ok = true;
  if (obj.type === 'turn.failed' || obj.type === 'error') { st.ok = false; emit({ type: 'error', text: short(obj.error?.message || obj.message || obj, 400) }); }
}

function opencodeArgs(sessionId?: string | null) {
  // --auto approves tool calls (same reach as the other two); the message goes through stdin like the others.
  const a = ['run', '--format', 'json', '--auto'];
  const model = opencodeModel();
  if (model) a.push('--model', model);
  if (sessionId) a.push('--session', sessionId);
  return a;
}
export function parseOpencode(obj: Json, emit: Emit, st: TurnState) {
  if (obj.sessionID && obj.sessionID !== st.sessionId) { st.sessionId = obj.sessionID; emit({ type: 'session', id: obj.sessionID }); }
  const p = obj.part;
  if (obj.type === 'text' && p?.type === 'text' && (p.text || '').trim()) { st.text = p.text; emit({ type: 'text', text: p.text }); }
  if (obj.type === 'tool_use' && p?.type === 'tool') emit({ type: 'tool', name: p.tool, detail: short(p.state?.input?.command || p.state?.input?.filePath || p.state?.input?.path || p.state?.input) });
  if (obj.type === 'step_finish' && p?.cost) st.cost = (st.cost || 0) + p.cost;
  if (obj.type === 'error') { st.ok = false; emit({ type: 'error', text: short(obj.error?.message || obj.error || obj, 400) }); }
}

export interface DropTrack { n: number; sample: string }
// One stdout line: valid JSON goes to the parsers; anything else is counted
// (CLI warnings, truncated lines) instead of vanishing without a trace.
export function feedStdout(l: string, kind: AgentKind, emit: Emit, st: TurnState, drop: DropTrack): void {
  let obj: Json;
  try { obj = JSON.parse(l); } catch { drop.n++; if (!drop.sample) drop.sample = l.slice(0, 200); return; }
  (kind === 'claude' ? parseClaude : kind === 'codex' ? parseCodex : parseOpencode)(obj, emit, st);
}
// At turn end: if the CLI produced no text and nothing else explains why, say
// what was dropped so the error card names a cause instead of going out blank.
// Success paths (text present) and already-explained failures are untouched.
export function noteDropped(st: TurnState, drop: DropTrack, emit: Emit): void {
  if (st.text || drop.n === 0 || st.lastError) return;
  emit({ type: 'error', text: `dropped ${drop.n} non-JSON stdout line(s), first 200 chars: ${drop.sample}` });
}
export function runAgent({ kind, cwd, prompt, sessionId, onEvent = () => {}, signal }: AgentRun): Promise<AgentResult> {
  return new Promise((resolve) => {
    const st: TurnState = { sessionId, text: '', ok: false, cost: null, lastError: '' };
    const emit: Emit = (e) => { if (e.type === 'error') st.lastError = e.text; onEvent(e); };   // keep the last error for the job's error card
    const drop: DropTrack = { n: 0, sample: '' };
    const isClaude = kind === 'claude';
    const cmd = kind === 'claude' ? 'claude' : kind === 'codex' ? codexBin() : opencodeBin();
    const args = kind === 'claude' ? claudeArgs(sessionId) : kind === 'codex' ? codexArgs(sessionId, cwd) : opencodeArgs(sessionId);
    // Windows: npm shims (claude.cmd) need a shell; args are fixed literals, the prompt goes through stdin.
    // its own process group (POSIX), so a cancel stops the renders and browsers it started too, not only the CLI
    const child = spawn(cmd, args, { cwd, shell: IS_WIN, ...treeOpts, env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1' } });
    // the signal lives as long as the whole flow: drop the listener when this turn ends, so finished children aren't killed (or kept) later
    const onAbort = () => killTree(child);
    if (signal) { if (signal.aborted) killTree(child); else signal.addEventListener('abort', onAbort, { once: true }); }
    lines(child.stdout, (l) => feedStdout(l, kind, emit, st, drop));
    let err = '';
    lines(child.stderr, (l) => { err += l + '\n'; if (!/^\s*$/.test(l) && !/DeprecationWarning|ExperimentalWarning/.test(l)) emit({ type: 'error', text: short(l, 400) }); });
    child.on('error', (e) => { emit({ type: 'error', text: `${cmd} failed to start: ${e.message}` }); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) st.ok = false;
      else if (!isClaude && !st.lastError) st.ok = true;
      noteDropped(st, drop, emit);
      onEvent({ type: 'done', ok: st.ok, text: st.text, cost: st.cost });
      resolve({ sessionId: st.sessionId, text: st.text, ok: st.ok, code, stderr: err.slice(-2000), lastError: st.lastError });
    });
    child.stdin.end(prompt, 'utf8');
  });
}
