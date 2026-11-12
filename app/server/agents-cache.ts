// Cache for the installed-agent probe.
//
// agentStatus() spawns each CLI with --version, which is too slow to run on every request. It used to be cached for
// the lifetime of the process, so a Claude Code or Codex installed while the server was running never appeared in the
// picker until the next restart. Now:
//   - a stale answer is served at once while a background probe refreshes it (no request waits on a re-probe);
//   - an answer with a missing agent goes stale sooner (MISS_TTL_MS), so a fresh install shows up quickly;
//   - status(true) (GET /api/agents?refresh=1, the header's agent pill) waits for a new probe.
//
// AGENTS_TTL_MS overrides the window; 0 disables the cache (useful when testing the picker).
import { agentStatus } from './agents/index.ts';
import type { AgentStatus } from '../shared/types.ts';

export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const MISS_TTL_MS = 30 * 1000;

// Unset, empty or not a non-negative number ('5m', '-1') → the default, never a silently disabled cache
export function ttlFromEnv(v: string | undefined): number {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

export function createAgentCache(
  detect: () => Promise<AgentStatus> = agentStatus,
  ttlMs: number = ttlFromEnv(process.env.AGENTS_TTL_MS),
  now: () => number = Date.now,
) {
  let cached: AgentStatus | null = null;
  let at = 0;
  let running: Promise<AgentStatus> | null = null;
  const probe = () => running ??= detect()
    .then((s) => { cached = s; at = now(); return s; })
    .finally(() => { running = null; });
  return async function status(force = false): Promise<AgentStatus> {
    if (!cached || force || ttlMs === 0) return probe();
    const ttl = cached.claude && cached.codex && cached.opencode ? ttlMs : Math.min(ttlMs, MISS_TTL_MS);
    if (now() - at >= ttl) probe().catch(() => {});   // refresh in the background, answer with what we have
    return cached;
  };
}
