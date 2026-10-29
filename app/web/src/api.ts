// Thin client for the ReelMimic server.
import type { AgentStatus, Config, ProjectSummary, Quality, RoundKey, ServerEvent, Snapshot } from '../../shared/types.ts';
import type { MessageMeta } from './types.ts';
type Ok = { ok: true };
const j = async <T>(r: Response): Promise<T> => { const d: unknown = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error((d as { error?: string }).error || r.statusText), { status: r.status }); return d as T; };
export const api = {
  agents: (refresh = false) => fetch(refresh ? '/api/agents?refresh=1' : '/api/agents').then(j<AgentStatus>),
  projects: () => fetch('/api/projects').then(j<ProjectSummary[]>),
  project: (id: string) => fetch(`/api/projects/${id}`).then(j<Snapshot>),
  create: (form: FormData) => fetch('/api/projects', { method: 'POST', body: form }).then(j<{ id: string }>),
  addInputs: (id: string, form: FormData, to?: string | null, forInput?: string) => fetch(`/api/projects/${id}/inputs?${new URLSearchParams({ ...(to ? { to } : {}), ...(forInput ? { for: forInput } : {}) })}`, { method: 'POST', body: form }).then(j<Snapshot & { saved: string[] }>),
  message: (id: string, text: string, meta?: MessageMeta) => fetch(`/api/projects/${id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, meta }) }).then(j<Ok>),
  approve: (id: string) => fetch(`/api/projects/${id}/approve`, { method: 'POST' }).then(j<Ok>),
  retry: (id: string) => fetch(`/api/projects/${id}/retry`, { method: 'POST' }).then(j<Ok>),
  lyrics: (id: string, text: string) => fetch(`/api/projects/${id}/lyrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).then(j<{ ok: boolean; aligned: boolean; report?: unknown }>),
  unwaive: (id: string, input: string) => fetch(`/api/projects/${id}/unwaive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }).then(j<Snapshot>),
  waive: (id: string, input: string) => fetch(`/api/projects/${id}/waive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }).then(j<Snapshot>),
  config: () => fetch('/api/config').then(j<Config>),
  settings: (id: string, body: Partial<Record<RoundKey, number | ''>>) => fetch(`/api/projects/${id}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(j<Snapshot>),
  quality: (id: string, quality: Quality) => fetch(`/api/projects/${id}/quality`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality }) }).then(j<Snapshot>),
  accept: (id: string) => fetch(`/api/projects/${id}/accept`, { method: 'POST' }).then(j<Ok>),
  resume: (id: string) => fetch(`/api/projects/${id}/resume`, { method: 'POST' }).then(j<Ok>),
  cancel: (id: string) => fetch(`/api/projects/${id}/cancel`, { method: 'POST' }).then(j<Ok>),
  // onOpen also runs when the browser reconnects on its own (server restart, laptop sleep): events from the gap are not resent
  events: (id: string, fn: (ev: ServerEvent) => void, onOpen?: () => void) => { const es = new EventSource(`/api/projects/${id}/events`); es.onmessage = (m: MessageEvent<string>) => fn(JSON.parse(m.data) as ServerEvent); if (onOpen) es.onopen = onOpen; return () => es.close(); },
  // encode each path segment ('#' would start the fragment, '%' makes a malformed URI); agents on Windows may write '\' as separator
  file: (id: string, p: string, bust?: number) => `/files/${id}/${p.split(/[\\/]/).map(encodeURIComponent).join('/')}${bust ? `?v=${bust}` : ''}`,
};
