<p align="right"><b>English</b> · <a href="zh-TW/ARCHITECTURE.md">繁體中文</a> · <a href="zh-CN/ARCHITECTURE.md">简体中文</a></p>

# Architecture

ReelMimic has three layers: the **web app** (React), the **server** (Node — runs the workflow and dispatches
agents; both are TypeScript and share their API types in `app/shared/types.ts`) and the **agent workspace** (the repo root, where Claude Code, Codex or OpenCode read skills, write files and render).
The layers talk only through **files**: agents write files as specified in `CONTRACT.md`, the server decides whether a
step is done by checking whether the files it must produce were updated, and the web app renders those files directly.
So you can swap the agent, add an engine or change the UI without touching the other layers.

```
Browser (app/web, React + Vite)
   │  REST + Server-Sent Events
   ▼
Server (app/server)
   ├─ index.ts          HTTP API, uploads, SSE, project files (/files/:id/*)
   ├─ env.ts            loads ~/.reelmimic/secrets.json at startup
   ├─ jobs.ts           the user's actions (start, approve, message, retry…), project list and snapshot
   ├─ preprod.ts        analysis → style → plan (characters and assets drafted in parallel)
   ├─ production.ts     setup → cast gate → shot line (parallel builders, per-shot review) → assemble
   ├─ prerender.ts      background render of passed segments (engines with a frame cache), stopped by Cancel
   ├─ cast.ts           cast gate: per-character review/fix in parallel, line-up check, serial fallback
   ├─ final.ts          final panel: critic ⇄ revise
   ├─ review.ts         the review → fix loop every gate shares (round limits, needs_user, pass rule)
   ├─ turn.ts           one agent turn: global slots (reviews and fixes jump the queue), required-file check, failure reason
   ├─ contract.ts       format check for the JSON files agents write (plan, production, reviews, fixes, critique)
   ├─ runner.ts         one flow per project; Cancel stops every agent and tool process it started (whole process tree)
   ├─ store.ts          job.json (written atomically), event log, live-update bus, round limits and quality presets
   ├─ inputs.ts         required inputs and lyric timing
   ├─ prompts.ts        the instructions each step gives its agent (edits apply on the next turn, no restart)
   └─ agents/index.ts   agent adapters: Claude Code / Codex / OpenCode → one event stream
   │  spawn (prompt on stdin, events streamed on stdout)
   ▼
Agent workspace (repo root)
   ├─ .claude/skills/video-clone/   core skill (workflow, contract, style registry, tools)
   ├─ .claude/skills/<engine>/      production engine skills
   └─ projects/<id>/                every file for one video
```

## 1. Workflow (the life of one video)

```
new → analyzing → styling → planning → plan_review ⇄ replanning
                                             │ approve (every required input provided or skipped)
                                             ▼
                                         producing ──→ needs_input (something only the user can give / repeated review failures)
                                             │
                                             ▼
                              critiquing ⇄ revising → done ⇄ (user feedback) revising
```

| Stage | Who | Files it must write |
|---|---|---|
| analyzing | `scripts/analyze.py` (not an agent) | `analysis/report.json`, `sheet_1fps.jpg`, `sheet_scenes.jpg` |
| styling | director agent | `analysis/STYLE.md`, `analysis/route.json` (style → production engine) |
| planning | director writes the plan core → one agent per character and one for assets work in parallel → director merges and paints style frames | `plan.json`, `STORYBOARD.md` (shots mapped to the reference, assets with licenses, style frames, required_inputs), character definition drafts |
| replanning | director agent | `plan.json` (revised from the user's comments) |
| producing | the production line (next section) | `build/production.json` … `out/video.mp4` |
| critiquing | independent critic (fresh conversation) | `out/check/critique.json` |
| revising | director agent | `out/video.mp4`, `out/check/fixes.json` (before/after crops for every fix) |

**Files decide completion**: `turn()` records the modification time of the required files and checks after the agent
turn whether they were updated; if not, the job stops in `error` and the step can be retried. Updated JSON files are
then checked against the contract (`contract.ts`, only the fields the server acts on): a broken one goes back to the same
agent conversation once to be rewritten, and if it is still broken the step stops in `error` naming the bad fields.
On server start, jobs still marked as working are flagged as interrupted (`recoverOrphans`); a retry continues from the
current files.

## 2. Production line (after approval)

```
setup (director): shared assets, one definition file per character, character sheets, segments (build/production.json)
   │
   ├──────────────── cast gate (runs alongside shot building) ─────────────┐
   │  per character: reviewer (fresh) ⇄ fixer agent, up to N rounds (mode)  │
   │  items that need the shared rig changed → director fixes → re-review    │
   │  all passed → line-up check (relative scale, interactions)             │
   │                                                                        │
   ├── segments: up to BUILDERS builders in parallel, 1–4 shots each        │
   │     each finished shot writes <shot>.done.json → a fresh shot reviewer  │
   │     is dispatched at once; reviews wait for the cast gate ←────────────┘
   │     → failing shots go back to the same builder → only those are re-reviewed, up to N rounds (mode)
   │     → shared-file problems: the director fixes them on the spot (one at a time, additive only),
   │       the builder applies them in the same round
   ▼
assemble (director): assembly, mix, full render
   ▼
final critic (fresh): the climaxes against the reference, then the whole film; verifies every earlier "fixed" first
   ⇄ items inside one segment go back to that segment's builder (all segments at once); the rest to the director,
     who renders once (rounds by mode, more while the must-fix list keeps halving)
```

**Quality modes** (`job.quality`, picked when a project is created, changeable at any time): one table in
`jobs.ts` (`CONFIG.presets`) sets the rounds per gate, and the prompts read the mode to decide what blocks.

| mode | rounds cast / shots / final | what blocks | at a round limit |
|---|---|---|---|
| fast | 2 / 2 / 1, no extra rounds | only what a viewer sees at once (broken character, black frame, unreadable caption, missing climax) | carries on and lists what is left |
| standard | 2 / 3 / 2, +1 while shrinking | one-frame pose changes in the climax shots, everything visible at normal speed | pauses for the user |
| fine | 3 / 3 / 2, +3 while shrinking | every pose change checked frame by frame; a climax must beat the reference | pauses for the user |

New projects default to fine. Measured on real runs with the same inputs (30 s, 9 shots): fine 222 min (all scores ≥ 4, two 5s), fast 79 min (scores 4, two 3s, every climax still beats the reference). Standard is not measured yet and is shown as an estimate.
Upgrading a finished film (for example fast → fine) starts a new final review under the stricter bar and fixes from
the current film. Projects made before modes existed run the fine line. Times shown in the UI
(`QUALITY_MINUTES`, scaled by film length) come from real runs: fine 167–222 min, fast 79 min for a 30 s film.

Design points:
- **Catch defects where they are made**: characters are reviewed before shots, every shot as soon as it is built —
  problems don't pile up at the end.
- **Reviewers are always fresh conversations**: they did not build the work and have nothing to defend; builders keep
  their own conversation so they remember the details when fixing.
- **Two severities**: only `blocker` (visible at normal viewing) sends work back; `polish` (visible only when zoomed)
  is recorded and handled along the way.
- **Fixes need evidence**: every "fixed" item carries before/after crops of the same moment and region; the next
  review checks those first.
- **needs_user**: lyrics, your own character designs and similar are not defects — the job pauses and asks you to
  provide or skip them instead of looping.
- **Scheduling**: a global agent budget (`MAX_AGENTS`); reviews and fixes jump ahead of new builds so defects are
  fixed while the builder still has the details in mind.
- **Engine snapshot**: at approval the engine skill is copied to `build/engine/<engine>/`, so improving a skill never
  changes a job mid-flight.

## 3. File contract

The full format is in `.claude/skills/video-clone/CONTRACT.md`. In short:

```
projects/<id>/
  job.json               managed by the server: stage, session ids, chat, production state
  logs/events.jsonl      complete event log (never truncated; the UI gets the latest 600)
  brief.md / inputs/     the user's brief and uploaded inputs
  analysis/              report.json, STYLE.md, route.json, lyrics/subs.lrc|json
  plan.json              the pre-production plan (the web app's main view)
  build/                 engine project: production.json, character definitions, one file per shot, engine snapshot,
                         score/ (Motion Score: film.json + shots/<id>.json, compiled to the engine's score.js)
  out/check/             cast/ (sheets, reviews, fixes), shots/ (per-segment done/review/fixes/shared, per-shot frames), critique.json, fixes.json
  out/video.mp4          the film
```

## 4. Agent adapters

`agents/index.ts` turns all three CLIs into the same events: `session`, `text`, `thinking`, `tool`, `error`, `done`.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Command | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools …` | `codex exec --json -c sandbox_mode=danger-full-access -c approval_policy=never (CODEX_SANDBOX) …` | `opencode run --format json --auto [--model OPENCODE_MODEL] …` |
| Resume | `--resume <session>` | `exec resume <thread>` | `--session <session>` |
| Prompt | stdin | stdin | stdin |

The server keeps one session per role: the director (shared for the whole video, so discussion keeps context), one per
builder (kept across fix rounds); reviewers always start fresh.

## 5. Web app

- `App.tsx`: home (composer card, project list), routing, language menu.
- `Project.tsx`: project page with tabs Final / Production line / Plan / Reference analysis; pause and error cards,
  required inputs and lyric timing, time-stamped notes on the video.
- `Chat.tsx`: conversation and "thinking": merges `job.chat` with the event log; working agents show as live cards
  (plain-language steps, timers, thumbnails of frames they looked at); finished replies collapse into
  "Thought for N s · M steps"; plus a raw log tab.
- `i18n.ts`: interface language (繁體中文 source, English table, 简体中文 via OpenCC).
- Live updates: `GET /api/projects/:id/events` (SSE).

## 6. HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` once the server is listening (`start.bat` / `start.sh` wait for it before opening the browser) |
| GET | `/api/agents` | detect installed agent CLIs |
| GET/POST | `/api/projects` | list / create (multipart: reference or url, brief, agent, lang, inputs) |
| GET | `/api/projects/:id` | project snapshot (everything the web app needs) |
| POST | `/api/projects/:id/message` | talk to the director (plan feedback, film revisions, instructions while paused; attachments in `meta.attachments`) |
| POST | `/api/projects/:id/approve` | approve the plan (409 while a required input is missing) |
| POST | `/api/projects/:id/lyrics` | paste lyric text → automatic timing |
| POST | `/api/projects/:id/inputs` · `/waive` | upload more inputs (`?to=attachments` for chat attachments) · skip a required input |
| POST | `/api/projects/:id/resume` · `/accept` · `/retry` · `/cancel` | continue after a pause · accept current results · retry a failed step · stop |
| GET | `/api/projects/:id/events` | SSE event stream |
| GET | `/files/:id/*` | files inside a project (video, frames) |

## 7. Tools (`.claude/skills/video-clone/scripts/`)

| Tool | Purpose |
|---|---|
| `analyze.py` | download (yt-dlp) and measure the reference: shots, pacing, BPM, palette, camera moves, contact sheets |
| `compare.py` | shot-by-shot side-by-side comparison of the film and the reference, plus the measured `style_distance.json` |
| `motion_score.py` | Motion Score (`score/`, `optimize/`): the film's camera and timing as data — `from-ref` (transfer the reference's measured camera), `validate`, `predict` (render-free), `optimize` (CMA-ES), `compile` (runtime for the engines) — see [COMPILER.md](COMPILER.md) |
| `fingerprint.py` | Style Fingerprint (`perception/`): camera trajectories with fitted eases, tension peaks, cut/beat phase, cadence, colour; `style_distance` with findings; `plan-check` (does the plan cut as often as the reference) — see [COMPILER.md](COMPILER.md) |
| `hf_frames.py` | frame grabs for HyperFrames projects: many moments per call, PIL crops, content-hash cache, machine-wide concurrency limit |
| `fetch_assets.py` | license-safe asset search and download (Openverse, Pixabay, Freesound), writes ASSETS.md |
| `align_lyrics.py` | user-provided lyric text × audio → per-line timing (faster-whisper only as a ruler) |
| `yating_tts.py` | Yating Taiwan-Mandarin voices |
| `timeline.py` | where a video's production time went: per stage, per agent, per activity |
