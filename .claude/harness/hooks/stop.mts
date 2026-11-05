// Stop: the gate half of rule `look-after-render`. If this session rendered something it never looked at, the agent is
// sent back once to look. `stop_hook_active` (set when Claude Code is already continuing because of a Stop hook) lets
// the second stop through, so a render that genuinely cannot be checked never traps the agent in a loop.
import { listPending, type Handler } from '../lib/hook.mts';

const STALE_MS = 6 * 3600_000;   // older than a working session: forget it rather than nag about yesterday's render

export const handle: Handler = (e) => {
  if (e.stop_hook_active) return null;
  const left = listPending(e.session_id ?? 'default').filter((p) => Date.now() - p.at < STALE_MS);
  if (!left.length) return null;
  const list = left.map((p) => `- ${p.kind === 'film' ? 'film' : 'review image'} ${p.path}${p.sheet ? ` (contact sheet ${p.sheet})` : ''}`).join('\n');
  return { decision: 'block', reason: `Rule \`look-after-render\`: these renders were never looked at:\n${list}\nRead them (or frames from them) and fix what you see before finishing. If one was superseded by a later render you did check, say so and stop.` };
};
