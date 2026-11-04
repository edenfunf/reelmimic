# Harness

Most of ReelMimic's work is done by agents (Claude Code or Codex). "Harness" here means everything around them
that makes that work checkable instead of trusted: the rules they read, the hooks that stop or redirect a tool call,
the gates every production job passes, CI, and the logs that show afterwards what happened.

The design rule: **a rule that only lives in a prompt is a wish.** Every project rule is listed with the strongest thing that
enforces it. The list is generated from code and checked in CI, so a rule nobody enforces shows up as one.

```
        agent reads                          agent acts                              after the fact
 ┌──────────────────────┐   ┌──────────────────────────────────────────────┐   ┌───────────────────────┐
 │ CLAUDE.md / AGENTS.md│   │ PreToolUse  policy.mts   deny / ask + reason │   │ logs/events.jsonl     │
 │  (one shared block,  │──▶│ PostToolUse render  →  contact sheet, scan   │──▶│ timeline.py           │
 │   rule ids)          │   │ Stop        rendered but never looked → back │   │ .claude/harness/      │
 │ skills, CONTRACT.md  │   │ app gates   contract.ts, review.ts loops     │   │   audit.jsonl         │
 └──────────────────────┘   └──────────────────────────────────────────────┘   └───────────────────────┘
            ▲                                    ▲
            └──────── CI: sync-rules --check, harness tests, typecheck, lint, app + perception tests ────────┘
```

## Rules and who enforces them

Generated from [`.claude/harness/rules.mts`](../.claude/harness/rules.mts) by `node .claude/harness/sync-rules.mts --write`. CI fails when it is stale,
when a rule in CLAUDE.md has no entry, when a file is missing, or when an anchor (the policy id, the prompt line, the
function) is no longer in the file it points to. Comments do not count: a comment that still mentions a deleted function
does not keep its anchor alive. A bare identifier must match as a whole word. Strings, templates and regex literals are
skipped properly, so `'http://…'` does not start a comment.

<!-- harness:table — generated, do not edit by hand -->
| rule | strongest layer | enforced by |
|---|---|---|
| `2d-only` | ⚠️ prompt only | **prompt** [SKILL.md](../.claude/skills/video-clone/SKILL.md) — style router filters by medium; 3D styles sit in styles/_disabled/ |
| `assets` | tool | **tool** [fetch_assets.py](../.claude/skills/video-clone/scripts/fetch_assets.py) — only reuse-licensed sources; every download is recorded with its licence<br>**prompt** [SKILL.md](../.claude/skills/video-clone/SKILL.md) — characters, lyrics and reference footage rules |
| `compare-gate` | runtime | **runtime** [prompts.ts](../app/server/prompts.ts) — the final critic scores every shot against the reference; must-fix items go back to the builders<br>**runtime** [review.ts](../app/server/review.ts) — review → fix loop with a fresh reviewer each round, up to the quality mode’s limit<br>**tool** [compare.py](../.claude/skills/video-clone/scripts/compare.py) — side-by-side reference vs film, per shot |
| `look-after-render` | hook | **hook** [post-tool-use.mts](../.claude/harness/hooks/post-tool-use.mts) — after a film render: contact sheet + black/frozen scan handed to the agent<br>**hook** [stop.mts](../.claude/harness/hooks/stop.mts) — an agent that rendered and never read an image is sent back once<br>**runtime** [prompts.ts](../app/server/prompts.ts) — reviewers that did not build the shot judge it from consecutive frames, with before/after crops as evidence |
| `secrets` | hook | **hook** [policy.mts](../.claude/harness/policy.mts) — writes to any secrets.json are denied (Write/Edit, redirects, cp/mv/sed/…, globs and folder-walking tools over it)<br>**hook** [policy.mts](../.claude/harness/policy.mts) — reading the real file asks the user first (Read, Grep, cat, globs, grep -r over a folder above it)<br>**git** [.gitignore](../.gitignore) — never committed |
| `projects-private` | hook | **hook** [policy.mts](../.claude/harness/policy.mts) — `git add` of anything under projects/ (or -f over it) is denied<br>**git** [.gitignore](../.gitignore) — ignored, so only a forced add could stage it |
| `one-server` | hook | **hook** [policy.mts](../.claude/harness/policy.mts) — starting a server on the real projects/ while one answers /api/health is denied<br>**runtime** [restart.sh](../app/restart.sh) — the sanctioned restart refuses while agents are working<br>**ci** [jobs.test.ts](../app/server/jobs.test.ts) — tests run against a throwaway projects dir |

- **hook** — Claude Code hook: every tool call of every Claude Code session in the repo, the app’s production agents included
- **runtime** — the app pipeline: gates every production job, Claude Code or Codex
- **ci** — GitHub Actions on every push and pull request
- **tool** — a script the workflow runs, whose output is the evidence
- **git** — repository configuration
- **prompt** — instructions only: followed when read, nothing checks it
<!-- /harness:table -->

## Hooks (`.claude/harness/hooks/`, wired in `.claude/settings.json`)

They run on every tool call of every Claude Code session in the repo. That includes the app's production agents: the
app starts each one at the repo root (`turn.ts`, `cwd: ROOT`), where `.claude/settings.json` is loaded. The app also tells
each agent its job folder and its name (`REELMIMIC_JOB_DIR`, `REELMIMIC_AGENT`). Every hook decision then lands in
that project's `logs/harness.jsonl` too, and `timeline.py` prints it per job:

```
harness (hooks):
  render: contact sheet + scan                    3   builder-C1×2, director×1
  stop: sent back to look at a render             1   shot-qa-S4×1
```

Hooks don't change where an agent's commands run: the `cwd` in each event follows the agent's own `cd` (checked live).
So `cd .claude` followed by `git add -f ../projects/x` is still resolved to `projects/` and denied.

### Cost: the fast path

Every tool call starts a hook process before it runs (PreToolUse) and after (PostToolUse), and a production job makes
870–2,330 tool calls (19 real jobs). So start-up time is the budget. The only entry is [`hooks/dispatch.mjs`](../.claude/harness/hooks/dispatch.mjs). It is
plain JS: loading Node's TypeScript stripper alone costs ≈ 22 ms. It answers what it can on a **fast path**
([`hooks/fast.mjs`](../.claude/harness/hooks/fast.mjs), no imports beyond Node built-ins). Only the rest loads the TypeScript handlers, with
Node's compile cache on.

The fast-path filters are a **conservative superset**: each tests for a token every matching case must contain
(`secrets`, `git`, `index.ts`, `render`, …) after quotes and backslashes are dropped. So `g''it` or `"secrets.json"` cannot slip past.
The secrets policies can also reach the keys without naming them, through a glob or a folder above them (`rm -rf $HOME`).
For that the fast path expands variables the way the parser does and bounds where the command can be. Every directory a
command can be in starts at the event's cwd or at an absolute `cd` target, and moves by descending or by `..`. So if
none of those, climbed by every `..` in the command, sits above the keys, no relative path does either. Absolute paths
are checked directly (a glob by its literal folder); a bare `/` only counts for a folder-walking command.
[`test/fast.test.mts`](../.claude/harness/test/fast.test.mts) checks it as a property: on a tricky-spelling corpus, and, where production logs exist, on every
shell command real agents ran. For each command, *a policy acts or a render is found* ⇒ *the fast path lets it through*.
On 13,211 production commands: no unsafe skip, and the fast path is taken by **97.5 %** of PreToolUse and **80.5 %**
of PostToolUse shell calls. The PreToolUse figure is a floor: the logs cut commands at 400 characters, and a cut-off
`D="C:/Users/me/` reads as a path above the keys. On PostToolUse the rest are mostly the builders' own
`render.mjs --sheet` checks, which do need the handler.

Measured through the real `bash -c` command line, median of 21 runs, Windows:

| hook call | before | after |
|---|---|---|
| fast path (Read, Grep, `ls`, …: almost every call) | 108–124 ms | **63–68 ms** |
| handler path (`git …`, a render) | 109–124 ms | 89–96 ms |
| floor: `bash -c "node -e 0"` | 57–62 ms | |

The fast path costs ≈ 5 ms more than starting Node at all.

**PreToolUse → [`policy.mts`](../.claude/harness/policy.mts).** Shell commands are parsed first ([`lib/shell.mts`](../.claude/harness/lib/shell.mts)):
split into the simple commands that will actually run, with `cd`, `git -C`, `export`, `K=V` prefixes, `bash -c '…'`,
`$( )` and launchers (`env`, `nohup`, `sudo`, `timeout`, `npx`, `pnpm exec`, each with its own options) followed.
`$HOME`, `${VAR}`, `$env:VAR` and `%VAR%` are expanded from the command's own exports, then the environment; search lists
like `$PATH` are not. Here-document bodies are read as stdin data, not commands. An unquoted
body's `$( )` still runs, so it is still checked. This matters because a regex over the raw string misses `cd app && npm start`
or `echo $(cat ~/.reelmimic/secrets.json)`.

| policy | stops | the allowed way (told to the agent) |
|---|---|---|
| `secrets-write` | Write/Edit of any `secrets.json`; redirects into it; any other command that reaches it: by name (`cp`, `mv`, `sed -i`, `python -c "…open(…secrets.json,'w')"`), by a glob (`cp ~/.reelmimic/* /tmp`), or as a folder-walking tool over a folder above it (`rm -rf`, `cp -r`, `tar`, `find … -delete / -exec`) | tell the user which key to add; `test -f` to check |
| `secrets-read` | asks before reading the real file: Read, `cat`, `Get-Content`, …, a glob that expands to it, `grep -r` / `rg` over a folder above it, the Grep tool pointed at or above it. A search for the *name* (`grep -rn secrets.json app/`) passes | — |
| `git-add-projects` | `git add` / `git stage` of a path under `projects/` (except `.gitkeep`), or `-f` over a folder that contains it | stage changed code by path |
| `second-server` | starting `app/server/index.ts` (directly or through `timeout` / `npx tsx`, `npm start`/`npm run server`, `start.sh`/`start.bat`) on the real `projects/` while a server answers `/api/health` on 4318 or `$PORT` | `bash app/restart.sh` (refuses while agents work), or a scratch `REELMIMIC_PROJECTS` |

When more than one policy matches, deny beats ask. Every reason is prefixed `[harness:<policy>]` and names its rule.

**PostToolUse: render feedback.** [`render.mts`](../.claude/harness/render.mts) tells a *film* render (`render.mjs --encode|--clip`, `hyperframes render`,
`remotion render`, ffmpeg writing `out/*.mp4`) apart from *review images* (`render.mjs --sheet|--strip|--stills`, `hf_frames.py`).
After a film render, the hook finds the output file and checks that **this call** wrote it. The dispatcher records the
start of every render-like command on PreToolUse, keyed by `tool_use_id` (present in every event, checked live).
PostToolUse only accepts a file written after that. A failed re-render 20 s after a good one leaves a file that any
time window would call fresh; this way it is reported as "wrote no new video during this call". When there is no start
time, a 3-minute window is the fallback. A command that names its output (`--out`, `-o`, the default `out/video.mp4`)
is judged on that file alone: if it is missing, the render failed, and the newest video nearby belongs to something
else. Only an unnamed output is looked for. It then builds a 3×3 contact sheet (one input seek per frame,
in parallel, cached by size + mtime + layout) and scans the film once at 320 px for black (≥ 0.4 s) and frozen (≥ 2.5 s) picture.
The sheet path, frame times and any findings are handed back to the agent as context. Black that only touches the
last frame is reported as a likely end fade, not a defect. Renders started in the background are noted, with
the command to check them by hand: `node .claude/harness/look.mts <video>`.

**Stop: the gate.** Every render is remembered per session, one file per item so that parallel tool calls never race.
Reading an image clears it: any image clears a film, and only that file (or folder) clears review images. If anything is
left when the agent tries to finish, it is sent back once with the list. `stop_hook_active` lets the second stop
through, so a render that cannot be checked never traps the agent in a loop. Items older than 6 h are forgotten.

**Failure policy: fail open.** Every handler runs through `respond()` in [`lib/hook.mts`](../.claude/harness/lib/hook.mts), which catches any error,
writes it to the audit log and returns no decision; the dispatcher always exits 0. A bug in a guardrail must not stop production. Decisions are
returned as JSON on stdout, not as exit code 2, so the reason reaches the agent as written.

**Audit.** Every deny, ask, injected context, block and crash is one line in `.claude/harness/audit.jsonl` (gitignored).
`REELMIMIC_HARNESS_AUDIT` and `REELMIMIC_HARNESS_STATE` move the log and the session state, which the tests use.
`REELMIMIC_HARNESS_DEBUG=1` also logs every event a handler receives (how `tool_use_id` and `cwd` were checked).

## One rule set, two agents

Claude Code reads CLAUDE.md and Codex reads AGENTS.md. The rules, tools and folders sections exist once, in CLAUDE.md
between `harness:shared` markers, and AGENTS.md carries a copy (`sync-rules.mts --write` makes it, `--check` fails CI on
any difference). Each rule line starts with its id (`` `secrets` ``), which ties it to its row in the table above.
Codex does not run Claude Code hooks. For Codex, the rules whose strongest layer is `hook` are backed only by the app's gates,
and AGENTS.md says so.

## CI (`.github/workflows/ci.yml`)

| job | checks |
|---|---|
| App | typecheck (app and harness), eslint, server tests, build on Node 22.18 and 24 |
| Perception | ruff over all of `video-clone/scripts`, the perception / score / optimizer tests |
| Harness | `sync-rules.mts --check`, then the harness tests: shell parsing, every policy (with a fake server on a free port for `second-server`), render classification and freshness, the fast-path superset property, and the hooks end to end through `dispatch.mjs` as Claude Code runs them: JSON on stdin, a real ffmpeg-made film, pre → post by `tool_use_id`, the Stop gate before and after a Read |
| App | also: every production agent is started with its job folder and name (`pipeline.test.ts`) |

## Adding a rule

1. Add a line to the rules list in CLAUDE.md: `` - `my-rule` … ``.
2. Add `'my-rule': [...]` to `rules.mts` with where it is enforced. If nothing enforces it yet, say so (`layer: 'prompt'`):
   the table will show it as ⚠️ prompt only.
3. If a tool call can be checked before it runs, add a policy to `policy.mts` with `rule: 'my-rule'` and a test in
   `test/policy.test.mts`, then list it in `rules.mts` as `{ layer: 'hook', at: '.claude/harness/policy.mts#<policy id>' }`.
4. `node .claude/harness/sync-rules.mts --write`.

## Limits

- Codex agents run no Claude Code hooks. For a Codex job, the runtime gates are what is left.
- The production timings in ARCHITECTURE.md (fast 79 min, fine 222 min) were measured before the hooks. The start-up
  cost per call is measured above. The Stop gate's extra turns and the contact sheets' effect on review quality show up
  in `logs/harness.jsonl` and `timeline.py` on the next real runs. They have not been measured yet.
- The hooks catch honest mistakes by an agent working in this repo. They are not a sandbox. Code that builds a path at
  runtime (`open(os.path.expanduser('~') + …)`) is invisible to a command parser.
- Folder-walking checks know the keys files `app/server/env.ts` would load (`$REELMIMIC_SECRETS`, `~/.reelmimic/`, the
  pre-rename `~/.clone-studio/`). A `secrets.json` elsewhere is still caught by name or by glob, not through a folder
  above it. Globs are expanded up to 500 matches per segment. `rg` skips dot-folders unless told otherwise; the policy
  asks anyway.
- `second-server` can only see servers on the ports it probes (4318 and `$PORT`). A server on some other port with the real
  `projects/` is not detected.
- The black / frozen scan finds what a machine can see. Whether a hold is intended, or a pose reads, is still the reviewer's call.
  Films longer than 5 min skip the scan.
- The Stop gate checks that an image was read, not that it was understood. The judgement stays with the reviewers
  in the app pipeline (`review.ts`, `final.ts`).
