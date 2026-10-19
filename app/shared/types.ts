// Shapes shared by the server and the web app: job.json, the project snapshot, live events.
// Files written by agents (plan.json, reviews, critique…) follow CONTRACT.md; only the fields the app reads are typed here.

export type AgentKind = 'claude' | 'codex';
export type Lang = 'zh-TW' | 'en' | 'zh-CN';

export type Stage =
  | 'new' | 'analyzing' | 'styling' | 'styled' | 'planning' | 'replanning' | 'plan_review'
  | 'producing' | 'critiquing' | 'revising' | 'needs_input' | 'done' | 'error';

export const ROUND_KEYS = ['castRounds', 'chunkRounds', 'finalRounds'] as const;
export type RoundKey = (typeof ROUND_KEYS)[number];
export type Rounds = Record<RoundKey, number>;

export interface Config extends Rounds {
  builders: number;
  maxAgentsGlobal: number;
  maxReviews: number;
  overlapCast: boolean;
}

export interface Reference { type: 'file' | 'url'; src: string }

export interface ChatMessage {
  role: 'user' | 'agent' | 'builder' | 'critic' | 'system';
  text: string;
  ts: string;
  phase?: string;
  who?: string;
  shot?: string;
  time?: number;
  attachments?: string[];
  notes?: { t: number; text: string }[];   // timed notes on the video, sent with a message
}

// Normalised agent events (agents/index.ts) plus the server's own turn and tool markers.
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | { type: 'error'; text: string }
  | { type: 'done'; ok: boolean; text: string; cost?: number | null };

export type TurnMarker = { type: 'turn'; state: 'start' | 'end'; phase: string; ok?: boolean };
export type LogEntry = (AgentEvent | TurnMarker) & { who?: string };
export type LogEvent = LogEntry & { ts: string };

// Something only the user can give (a file, a decision). Reviewers write these as needs_user.
export interface NeedRequest { issue: string; kind?: string; why?: string; input?: string; [k: string]: unknown }
export interface Need extends NeedRequest { from: string; at: string }

export type ChunkState =
  | 'queued' | 'building' | 'waiting_cast' | 'built' | 'reviewing' | 'fixing' | 'shared_fix'
  | 'needs_user' | 'passed' | 'failed' | 'error';

export interface ChunkProgress {
  shots?: string[];
  state: ChunkState;
  round: number;
  fixFirst?: boolean;
  open?: number;
  acceptedByUser?: boolean;
}

export type CastCharState = 'queued' | 'reviewing' | 'fixing' | 'waiting_shared' | 'needs_user' | 'passed' | 'failed' | 'error';
export interface CastCharProgress { state: CastCharState; round: number; issues?: number }

export interface CastProgress {
  round: number;
  pass: boolean;
  state?: 'reviewing' | 'fixing' | 'passed' | 'failed';
  mode?: 'parallel';
  lineup?: boolean;
  chars?: Record<string, CastCharProgress>;
  acceptedByUser?: boolean;
}

export interface Pipeline {
  phase?: 'setup' | 'cast' | 'shots' | 'assemble' | 'final';
  cast?: CastProgress;
  chunks?: Record<string, ChunkProgress>;
  final?: { round: number };
}

export interface EngineSnapshot {
  engine: string;
  frozenAt: string;
  path: string;
  /** The route.json spelling when it differed from the installed folder. */
  engineResolvedFrom?: string;
  /** True when the routed engine was not installed and the default was frozen instead. */
  fallback?: boolean;
}

export interface Job {
  id: string;
  title: string;
  agent: AgentKind;
  lang: Lang;
  reference: Reference;
  settings: Partial<Rounds>;
  stage: Stage;
  failed?: Stage | null;
  error?: string | null;
  sessionId: string | null;
  sessions: Record<string, string>;
  createdAt: string;
  updatedAt?: string;
  chat: ChatMessage[];
  log: LogEvent[];
  needs: Need[];
  waived: string[];
  provided?: Record<string, string[]>;   // required input id → files uploaded for it
  pipeline: Pipeline;
  pendingNotes?: string[];
  retryPending?: boolean;
  approvedAt?: string;
  approvedAtPrev?: boolean;
  approvedPlanVersion?: number | string;
  engineSnapshot?: EngineSnapshot | null;
  userNote?: string | null;
  critiqueRounds?: number;
  lastCritique?: { pass: boolean; must: number; at: string };
}

export type InputKind = 'lyrics' | 'audio' | 'image' | 'text' | 'other';

export interface RequiredInputSpec {
  id: string;
  kind: InputKind;
  label?: string;
  why?: string;
  file?: string;
  match?: string;
}

export interface RequiredInput extends RequiredInputSpec {
  status: 'missing' | 'provided' | 'waived';
  files: string[];
}

export interface PlanCharacter { id: string; name?: string; file?: string; [k: string]: unknown }

export interface Plan {
  title?: string;
  version?: number | string;
  required_inputs?: RequiredInputSpec[];
  music?: { file?: string; section?: { start_s?: number; end_s?: number } };
  characters?: PlanCharacter[];
  assets?: { status?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface Issue { issue: string; severity?: 'blocker' | 'polish' | string; fix?: string; character?: string; what?: string; [k: string]: unknown }

export interface Review {
  pass?: boolean;
  issues?: Issue[];
  needs_user?: NeedRequest[];
  [k: string]: unknown;
}

export interface ProjectSummary {
  id: string;
  title: string;
  stage: Stage;
  agent: AgentKind;
  updatedAt?: string;
  needs: number;
  thumb: string | null;
}

// GET /api/projects/:id: everything the project page shows, read straight from the contract files.
export interface Snapshot {
  job: Job;
  brief: string | null;
  report: Record<string, unknown> | null;
  styleMd: string | null;
  route: { engine?: string; [k: string]: unknown } | null;
  plan: Plan | null;
  storyboard: string | null;
  assetsMd: string | null;
  checks: string[];
  video: string | null;
  critique: Record<string, unknown> | null;
  cast: { sheets: string[]; review: Review | null };
  shots: string[];
  production: Record<string, unknown> | null;
  lyrics: unknown;
  requiredInputs: RequiredInput[];
  rounds: { values: Rounds; defaults: Rounds; min: number; max: number };
  inputs: string[];
}

// Server-Sent Events on /api/projects/:id/events
export type ServerEvent = { type: 'job'; stage: Stage } | { type: 'log'; ev: LogEvent };

export type AgentStatus = Record<AgentKind, string | null>;
