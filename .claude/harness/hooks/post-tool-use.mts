// PostToolUse, the feedback half of rule `look-after-render`:
//   Bash / PowerShell that rendered a film → contact sheet + black/frozen scan, handed straight back to the agent as
//     context, and remembered as "not looked at yet";
//   … that rendered review images → remembered until read;
//   Read of an image → marks the renders it covers as looked at (the Stop hook checks what is left).
import { classify, freshOutput } from '../render.mts';
import { addPending, clearPending, listPending, takeStart, type Handler } from '../lib/hook.mts';
import { parse, resolvePath, samePath, within } from '../lib/shell.mts';
import { contactSheet, defects, type Span } from '../lib/video.mts';

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const fmt = (L: Span[]) => L.map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)} s`).join(', ');

export const handle: Handler = async (e) => {
  const session = e.session_id ?? 'default', input = e.tool_input ?? {};
  if (e.tool_name === 'Read') {
    const f = resolvePath(String(input.file_path ?? ''), e.cwd ?? process.cwd());
    if (!IMAGE.test(f)) return null;
    // A film counts as looked at once any image is read after it (the sheet, or frames the agent pulled itself);
    // review images only when that file (or a file in that folder, for --stills) is read.
    for (const p of listPending(session)) if (p.kind === 'film' || samePath(f, p.path) || within(f, p.path)) clearPending(session, p.id);
    return null;
  }
  if (e.tool_name !== 'Bash' && e.tool_name !== 'PowerShell') return null;
  const command = String(input.command ?? ''), cwd = e.cwd ?? process.cwd(), now = Date.now();
  const since = takeStart(session, e.tool_use_id);
  const notes: string[] = [];
  for (const c of parse(command, cwd)) {
    const r = classify(c);
    if (!r) continue;
    if (input.run_in_background) {
      if (r.kind === 'film') notes.push(`Render running in the background (${r.engine}). When it finishes, run \`node .claude/harness/look.mts ${r.out ?? '<video>'}\` for a contact sheet and Read it before going on (rule \`look-after-render\`).`);
      addPending(session, { kind: r.kind, path: r.out ?? c.cwd, at: now, command: command.slice(0, 200) });
      continue;
    }
    const out = freshOutput(r, c.cwd, { since, now });
    if (!out) { if (r.kind === 'film') notes.push(`${r.engine} ran but wrote no new video${r.out ? ` at ${r.out}` : ''}${since ? ' during this call' : ''}: check the command output before assuming it rendered.`); continue; }
    if (r.kind === 'check') { addPending(session, { kind: 'check', path: out, at: now, command: command.slice(0, 200) }); continue; }
    const sheet = await contactSheet(out);
    const d = await defects(out, sheet.duration);
    addPending(session, { kind: 'film', path: out, sheet: sheet.path, at: now, command: command.slice(0, 200) });
    const lines = [`Rendered ${out} (${sheet.duration.toFixed(1)} s). Contact sheet: ${sheet.path} — frames at ${sheet.times.join(', ')} s, left→right, top→bottom, ${sheet.cols} per row. Read it now (rule \`look-after-render\`); pull full-size frames for anything that needs a closer look.`];
    // A dark end card / fade-out is a house standard, not a defect: say where the black is and let the agent judge.
    const tail = (s: Span) => s.end >= sheet.duration - 0.05;
    if (d.black.length) lines.push(`Black picture at ${fmt(d.black)}${d.black.every(tail) ? ' (only at the end: the end fade?)' : ' — check it is intended'}.`);
    if (d.frozen.length) lines.push(`Picture frozen ≥ 2.5 s at ${fmt(d.frozen)} — a hold, or a render that stopped moving?`);
    if (!d.scanned) lines.push('(Longer than 5 min: black/frozen scan skipped.)');
    notes.push(lines.join(' '));
  }
  return notes.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n') } } : null;
};
