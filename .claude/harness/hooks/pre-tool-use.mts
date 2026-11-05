// PreToolUse: run the policies (../policy.mts) on the call about to happen; deny or ask with a reason the agent can act on.
import type { Handler } from '../lib/hook.mts';
import { evaluate } from '../policy.mts';

export const handle: Handler = async (e) => {
  const v = await evaluate(e.tool_name ?? '', e.tool_input ?? {}, e.cwd ?? process.cwd());
  return v && { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, permissionDecisionReason: `[harness:${v.policy}] ${v.reason}` } };
};
