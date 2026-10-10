<p align="right"><b>English</b> · <a href="zh-TW/EXTENDING.md">繁體中文</a> · <a href="zh-CN/EXTENDING.md">简体中文</a></p>

# Extending ReelMimic

Extension points, from shallow to deep:

| You want to | Change | Code? |
|---|---|---|
| Add a video style | `.claude/skills/video-clone/styles/<name>.md` | No |
| Add a production engine (a new drawing / rendering method) | `.claude/skills/<engine>/` (an ordinary agent skill) | No |
| Change how an agent handles a step | `app/server/prompts.ts` | Text only, applies on the next turn |
| Give agents a new tool | `.claude/skills/video-clone/scripts/` | Write the script, then mention it in a prompt / SKILL.md |
| Plug in another AI director (a new agent CLI) | `app/server/agents/index.ts` | Yes |
| Change the steps or order of the production line | `app/server/jobs.ts` + `prompts.ts` + `CONTRACT.md` | Yes |

---

## 1. Add a style

A style = "for this kind of reference → use this engine with these defaults". During the styling step the director
reads every file in `styles/`, matches the reference against each file's recognition cues and writes the best match
into `analysis/route.json`.

1. Copy `styles/_TEMPLATE.md` to `styles/<name>.md`.
2. Fill in the frontmatter:

   ```yaml
   ---
   name: lofi-anime-loop        # unique id, same as the file name
   engine: hyperframes          # folder name under .claude/skills/
   medium: 2d-vector            # 2d-painted · 2d-vector · 3d-stylized · 3d-photoreal (hard constraint when picking an engine)
   priority: 60                 # when two styles match, the higher one wins
   ---
   ```
3. Write three sections:
   - **Recognition cues**: a sentence or two each for picture, editing, sound and text — things you can see or
     measure (e.g. average shot 2–3 s, cuts follow the narration, not the beat).
   - **Production defaults**: aspect ratio, length, fps, how characters are made (e.g. 2D vector characters always use
     `assets/vector_rig`), caption spec.
   - **Known pitfalls**: problems hit in earlier productions and their fixes. Add to it whenever a production teaches
     something new; the next video avoids it automatically.
4. Create a project with a representative reference and check that `analysis/route.json` picks your style.

To take a style out of selection, move the file to `styles/_disabled/`.

## 2. Add a production engine

An engine is an ordinary agent skill: a folder with a `SKILL.md` (instructions for the agent) and the scripts and
templates it needs.

```
.claude/skills/my-engine/
  SKILL.md          frontmatter (name, description) + how to create a project, preview a frame, export MP4, rules and pitfalls
  scripts/ …        render and preview tools
  template/ …       new-project skeleton (optional)
```

For it to plug into the production line, `SKILL.md` must make these clear (the director follows it in the setup step
to build `build/production.json`):

- **One file per shot**: parallel builders each edit only their own files, so they never collide.
- **Shared files**: character definitions, palette, caption layer and audio live in shared files; shots call
  characters, they never redraw body parts.
- **Preview command**: how to quickly render a single frame and a crop at a given time (all review depends on it).
  HyperFrames projects can use `scripts/hf_frames.py` directly.
- **Export command**: how to render the full MP4 and mix audio.
- **Determinism**: every frame depends only on time (no `Math.random()`, no cross-frame state), so frames can be
  rendered in parallel and reviewed out of order.

Then write a style file pointing to it (previous section). Before adding a third-party skill, read its scripts and add
its license to `THIRD_PARTY_NOTICES.md`.

### Optional hosted generation with Muapi

ReelMimic can stay local-first while using Muapi for an occasional generated image or video asset. This is an
opt-in helper; it does not replace a drawing engine or change the normal production line. Add `MUAPI_API_KEY` to
`~/.reelmimic/secrets.json` (or export it in the environment), then prepare a JSON request matching the current
schema for the model you choose. Find available models and their endpoint schemas at [muapi.ai/docs](https://muapi.ai/docs).

```bash
python .claude/skills/video-clone/scripts/muapi_generate.py \
  --endpoint <model-endpoint> --request request.json --out projects/<id>/assets/generated.png
```

The helper submits the request, polls until completion, and downloads the first output. Image and video models have
different inputs and outputs, so use the selected model's schema and choose an output extension that matches it.
Generation uses your Muapi account and may incur charges. Check the chosen model's terms for output rights; do not
assume generated assets are licensed for reuse. Record the model, endpoint, request ID, and applicable terms in the
project's `assets/ASSETS.md`. This helper needs Python 3.10+ and the standard library only.

### Starting from the engine kit

`.claude/skills/video-clone/assets/engine-kit/` is the fastest way to build a new look. It has the shared runtime the
pixel-art, paper-cutout, whiteboard and anime-cel engines are built on (timeline, motion helpers, camera, captions and
the render contract), the headless-Chrome `render.mjs`, a page template, `new_project.sh`, and `ENGINE_BRIEF.md`, the
checklist those engines were built from. Copy it into `.claude/skills/<your-engine>/template/`, write your drawing
library and characters, and you get parallel rendering, contact sheets and crops for review, and resumable export for
free.

### Character systems

- `assets/vector_rig/`: 2D vector characters — a skeleton (neck, shoulders, elbows, wrists, hips, knees) with one
  outline per depth layer, so limbs are always attached. See its README.
- `assets/cast_rig.js`: character skeleton for painted-animation (hand-painted watercolor).

If a new engine has its own way of making characters, keep the same rule — "characters defined in shared files, one
file per character, shots only pass pose parameters" — so the cast gate can review and fix them in parallel.

## 3. Tune agent behaviour (prompts.ts)

Each key in `app/server/prompts.ts` is one step of the pipeline:

| Key | Who | Does |
|---|---|---|
| `style` · `plan` · `replan` | director | pick the style, write the plan core, revise from feedback |
| `pre_cast` · `pre_assets` · `plan_frames` | character · assets · director | parallel pre-production: per-character drafts, asset search, merge and paint style frames |
| `setup` | director | engine project, shared files, characters, segments |
| `cast_qa` · `cast_fix` | reviewer · fixer | cast gate |
| `build_chunk` · `shot_qa` · `fix_chunk` | builder · reviewer · builder | segment production; each finished shot gets its own reviewer (`shots` / `out` select the shots and output file) |
| `shared_fix` | director | shared-file problems reported by builders |
| `assemble` · `critique` · `revise` | director · critic · director | assembly, final critique, revisions |

Shared fragments: `RULES` (content and licensing), `SPEED` (efficiency rules), `EYE` (human-eye checklist), `QA_OUT`
(review output format and the blocker/polish definitions).
The server checks this file for changes before every dispatch — **edits apply from the next agent turn, no restart**.

Suggested approach: run `python .claude/skills/video-clone/scripts/timeline.py projects/<id>` to see where time went
and which gate kept sending work back, then decide what to change. Moving "what the final critic keeps rejecting"
forward into the setup or build specs is the most effective speed-up.

## 4. Plug in another AI director

In `app/server/agents/index.ts`:

1. Write `xxxArgs(sessionId, cwd)`: command-line arguments for a non-interactive run that auto-approves file edits
   and can resume a session.
2. Write `parseXxx(obj, emit, st)`: turn the CLI's JSON stream into the common events:
   `session {id}`, `text {text}`, `thinking {text}`, `tool {name, detail}`, `error {text}`, and finally `done {ok, text}`.
3. Add the new `kind` to `runAgent` and `agentStatus`, and an option to the picker in the web app's `App.tsx`.

The agent must be able to: read and write files in the repo, run a shell (python, node, ffmpeg), look at images
(review depends on it) and resume a conversation.

## 5. Change the production line

Main functions in `app/server/jobs.ts`:

- `production()`: setup → `castGate()` (runs alongside segment building) → `runChunk()` × N → assemble.
- `castGate()` / `castSerial()`: per-character parallel review and fixing; the serial version is used for a single
  character or shared-file work.
- `finalPanel()`: final critic ⇄ revise.
- `turn()`: dispatches one agent turn (session handling, global slots, required-file check).

When changing a step, change three places together: `jobs.ts` (flow), `prompts.ts` (instructions) and `CONTRACT.md`
(format of any new file); plus `Project.tsx` if the web app should show it.
Parameters (parallelism, rounds per gate) are in `CONFIG` and can also be set through environment variables.

## 6. Adding UI text / translations

Interface strings are written in Traditional Chinese in the components. `app/web/src/i18n.ts` translates the page at
runtime: English comes from the `EN` table (plus `EN_RE` patterns for strings with numbers), Simplified Chinese is
converted automatically with OpenCC. When you add a new string, add its English entry to `EN`; mark elements that must
never be translated (user content, file names) with `data-no-i18n`.

## 7. Development

```bash
cd app
npm run server      # backend only (after editing server/, restart with: bash app/restart.sh)
npm run web         # UI dev server http://localhost:5173 (hot reload, /api proxied to 4318)
npm run build       # build app/dist for npm start / start.sh
npm run doctor      # environment check
```

Small tests: `_smoke/` (local, not version-controlled) holds single-component check pages; the full check is to
produce a real 30-second video, then look at the time breakdown with `timeline.py` and inspect the film frame by frame.
