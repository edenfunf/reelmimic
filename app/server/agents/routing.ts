import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind, AgentRoute } from '../../shared/types.ts';
import type { Phase } from '../types.ts';

export const ROLE_GROUP = {
  style: 'director', plan: 'director', replan: 'director', plan_frames: 'director',
  setup: 'director', shared_fix: 'director', assemble: 'director', revise: 'director',
  pre_cast: 'builder', pre_assets: 'builder', build_chunk: 'builder',
  cast_qa: 'reviewer', shot_qa: 'reviewer', critique: 'reviewer',
  cast_fix: 'fixer', fix_chunk: 'fixer',
} as const satisfies Record<Phase, string>;
export const VISION = new Set<Phase>(['style', 'plan_frames', 'cast_qa', 'shot_qa', 'critique']);
interface Selection {
  default?: string;
  groups?: Partial<Record<(typeof ROLE_GROUP)[Phase], string>>;
  roles?: Partial<Record<Phase, string>>;
}
export interface RoutingConfig extends Selection {
  version: 1;
  routes: Record<string, AgentRoute>;
  projects?: Record<string, Selection>;
}

function fail(message: string): never { throw new Error(`Model routing: ${message}`); }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_./:@~+-]+$/.test(v) && !v.startsWith('-');
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail('unknown configuration field; see docs/MODEL_ROUTING.md');
}

export function validateRoute(value: unknown): asserts value is AgentRoute {
  if (!object(value)) fail('route must be an object');
  keys(value, ['runtime', 'model', 'provider', 'vision', 'timeoutMs']);
  if (!['codex', 'claude'].includes(String(value.runtime))) fail('runtime must be codex or claude');
  if (!token(value.model)) fail('model must be a non-empty model ID');
  if (value.vision !== undefined && typeof value.vision !== 'boolean') fail('vision must be true or false; omit for unverified');
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 7200000)) fail('timeoutMs must be 1000–7200000');
  if (value.provider !== undefined) {
    const p = value.provider;
    if (!object(p)) fail('provider must be an object');
    keys(p, ['id', 'baseUrl', 'protocol', 'envKey']);
    if (!token(p.id)) fail('provider requires an ID');
    if (p.protocol !== (value.runtime === 'codex' ? 'responses' : 'anthropic')) fail('Codex requires responses; Claude requires anthropic. Chat Completions is unsupported');
    if (typeof p.envKey !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(p.envKey)) fail('provider requires an environment-variable name in envKey');
    try {
      const u = new URL(String(p.baseUrl));
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
      if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error();
    } catch { fail('baseUrl must use HTTPS (HTTP allowed on loopback), with no credentials, query or fragment'); }
  }
}

export function parseRouting(value: unknown): RoutingConfig {
  if (!object(value)) fail('configuration must be an object');
  keys(value, ['version', 'routes', 'default', 'groups', 'roles', 'projects']);
  if (value.version !== 1 || !object(value.routes)) fail('expected version: 1 and routes object');
  for (const [id, route] of Object.entries(value.routes)) {
    if (!token(id)) fail('invalid route ID');
    validateRoute(route);
  }
  const selection = (s: Record<string, unknown>) => {
    for (const [field, allowed] of [['roles', Object.keys(ROLE_GROUP)], ['groups', ['director', 'builder', 'reviewer', 'fixer']]] as const) {
      const map = s[field];
      if (map !== undefined) {
        if (!object(map)) fail(`${field} must be an object`);
        if (Object.keys(map).some((k) => !(allowed as readonly string[]).includes(k))) fail(`unknown ${field} name`);
        for (const ref of Object.values(map)) if (typeof ref !== 'string' || !Object.hasOwn(value.routes as object, ref)) fail('selection references an unknown route');
      }
    }
    if (s.default !== undefined && (typeof s.default !== 'string' || !Object.hasOwn(value.routes as object, s.default))) fail('default references an unknown route');
  };
  selection(value);
  if (value.projects !== undefined) {
    if (!object(value.projects)) fail('projects must be an object');
    for (const project of Object.values(value.projects)) {
      if (!object(project)) fail('project selection must be an object');
      keys(project, ['default', 'groups', 'roles']); selection(project);
    }
  }
  return value as unknown as RoutingConfig;
}

// Complete routes are selected, never field-merged across different providers.
export function resolveRoute(config: RoutingConfig | null, project: string, phase: Phase): AgentRoute | null {
  if (!config) return null;
  const p = config.projects?.[project], group = ROLE_GROUP[phase];
  const name = p?.roles?.[phase] ?? config.roles?.[phase] ?? p?.groups?.[group] ?? config.groups?.[group] ?? p?.default ?? config.default;
  return name ? structuredClone(config.routes[name]) : null;
}

export function readRouting(): RoutingConfig | null {
  const file = process.env.REELMIMIC_ROUTING || join(homedir(), '.reelmimic', 'routing.json');
  if (!existsSync(file)) {
    if (process.env.REELMIMIC_ROUTING) fail('REELMIMIC_ROUTING file does not exist');
    return null;
  }
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { return fail('cannot read routing JSON; check syntax and permissions'); }
  return parseRouting(value);
}

export function preflightRoute(route: AgentRoute | null, phase: Phase, env: NodeJS.ProcessEnv = process.env) {
  if (!route) return;
  validateRoute(route);
  if (VISION.has(phase) && route.vision !== true) fail(route.vision === false
    ? `${phase} requires image input; selected route is text-only`
    : `${phase} vision capability is unverified; test image input, then set vision: true`);
  if (route.provider && !env[route.provider.envKey]?.trim()) fail(`missing credential environment variable ${route.provider.envKey}`);
  if (route.runtime === 'claude' && route.provider && ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => env[k] === '1')) fail('unset Claude cloud-provider switches before using a custom endpoint');
}

export function selectSessionRoute(saved: AgentRoute | null | undefined, requested: AgentRoute | null, sessionId?: string | null): AgentRoute | null {
  if (saved !== undefined) return structuredClone(saved);
  if (sessionId && requested) fail('existing legacy session cannot change provider/model; create a new project to enable routing');
  return requested;
}

export const routeLabel = (route: AgentRoute | null, legacy: AgentKind) => route
  ? `${route.runtime} / ${route.provider?.id || 'CLI-configured provider (unverified)'} / ${route.model}; vision=${route.vision === undefined ? 'unverified' : route.vision}; endpoint=unverified`
  : `${legacy} / CLI defaults; provider/model/usage/cost=unknown`;

// Routed provider failures never include raw stderr, which may echo authentication headers.
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  for (const [key, value] of Object.entries(env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) text = text.split(value).join('[redacted]');
  }
  return text;
}
