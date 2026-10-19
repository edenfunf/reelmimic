// Server-only shapes: build/production.json (written by the director at setup) and the variables each agent step gets.
import type { Config, Issue, Lang, NeedRequest, PlanCharacter } from '../shared/types.ts';

export interface Chunk { id: string; shots: string[] }
export interface CastMember { id: string; name?: string; file: string; sheet: string }

export interface Production {
  chunks?: Chunk[];
  characters?: CastMember[];
  rig_files?: string[];
  [k: string]: unknown;
}

// A problem a builder or character agent can't fix alone because it lives in a shared file (rig, cast, common assets).
export interface SharedItem { status: 'shared'; issue: string; shot?: string; character?: string; [k: string]: unknown }
export interface ShotEntry { id: string; pass?: boolean; issues?: Issue[] }
export interface ChunkReview { shots?: ShotEntry[]; verified_fixes?: unknown[]; needs_user?: NeedRequest[]; pass?: boolean; issues?: Issue[] }
export interface PeakVerdict { id: string; ours?: number[]; ref?: number[]; strip?: string; verdict?: 'ours_better' | 'equal' | 'ref_better'; why?: string }
export interface Critique { must_fix?: { shot?: string; time?: number; issue: string; fix?: string }[]; needs_user?: NeedRequest[]; peaks?: PeakVerdict[] }

type NoVars = Record<never, never>;

// Every prompt gets these…
export interface BaseVars { dir: string; brief: string; inputs: string[]; config: Config; lang: Lang }
// …plus the variables of its own step.
export interface StepVars {
  style: NoVars;
  plan: NoVars;
  pre_cast: { character: PlanCharacter };
  pre_assets: NoVars;
  plan_frames: { results: { what: string; ok: boolean }[] };
  replan: { message: string };
  setup: { reconcile?: string[] };
  cast_qa: { round: number | 'lineup'; character?: CastMember; lineup?: boolean };
  cast_fix: { issues: unknown[]; round: number | 'user' | 'shared'; character?: CastMember; rigFiles?: string[]; shared?: boolean; message?: string };
  build_chunk: { chunk: Chunk };
  shot_qa: { chunk: Chunk; shots: string[]; round: number; out: string };
  fix_chunk: { chunk: Chunk; bad: ShotEntry[]; round: number; message?: string | null };
  shared_fix: { chunk: Chunk; items: SharedItem[] };
  assemble: NoVars;
  critique: { round: number };
  revise: { message: string; round: number | 'user' };
}
export type Phase = keyof StepVars;
export type Prompts = { [P in Phase]: (p: BaseVars & StepVars[P]) => string };
