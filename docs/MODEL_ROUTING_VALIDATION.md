# Model routing validation

Test workstation: Windows, Node v26.10.0, Codex CLI 0.154.0. Claude Code is not installed.
Base: `edenfunf/reelmimic:main` at `782a3ba3cfa455663127348dbfcbcfafada05d52`.
The fork branch is `codex/per-role-model-routing`. Existing local changes in the original checkout were excluded.

## Baseline before edits

Commands run in `app/` (through the workstation's `rtk` proxy):

| Command | Exit | Result |
|---|---|---|
| `npm ci --ignore-scripts` | 0 | 258 packages installed; npm reported one existing high-severity dependency advisory |
| `npm run typecheck` (inside check) | 0 | server and web types passed |
| `npm run check` | 1 | existing unused `spawnSync` import in `server/agents/index.ts` failed lint; tests did not run in this command |
| `npm test` (separately) | 0 | 88 tests: 87 passed, 0 failed, 1 skipped |
| `npm run build` | 0 | Vite production build passed |

Baseline failure:

```text
server/agents/index.ts
  14:17  error  'spawnSync' is defined but never used  @typescript-eslint/no-unused-vars
```

The routing launcher now uses that import. No dependency upgrades or lockfile changes are included.
Upstream PR/issue searches found no existing per-role model/provider routing implementation. No contribution policy
requires a design issue before preparing a fork branch. The upstream PR remains pending the user's local testing.

## After changes

| Command | Exit | Result |
|---|---|---|
| `npm run check` | 0 | typecheck, lint and tests passed |
| `npm run build` | 0 | Vite production build passed |
| `npm run routing` | 0 | all 16 phases resolve to legacy mode when no routing file is present; no provider request |
| `git diff --check` | 0 | no whitespace errors |

Exact final test summary from `npm run check`:

```text
ℹ tests 96
ℹ suites 21
ℹ pass 95
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 11277.3671
```

The existing runner test `cancel kills a tool process and the processes it started` skips Windows. The added real
fake-CLI process test checks routed process cancellation, timeout and pre-aborted signals on Windows. It does not
claim to verify every renderer/browser descendant. POSIX process handling was reviewed but not executed here.

New checks cover all role/group keys, precedence, isolated complete route selection, missing model, invalid fields,
credential references, secret-safe errors, Responses/Anthropic protocol validation, unknown/text-only vision,
session pins, child environment isolation, new/resumed CLI arguments, streamed events, real temporary file writes,
terminal success validation, malformed JSON, provider-returned usage, quota failures before/after file writes,
no replay, cancellation and timeout. A full deterministic pipeline fixture checks director/builder/reviewer model
dispatch, builder resume for fixes, fresh reviewers, and routing edits between revisions. Existing pipeline tests
exercise contract repair, global behavior, cancellation and interrupted-job recovery.

## Deliberate limits before upstream submission

- No live provider requests or paid animation production were run. The fake CLI emits deterministic tool events and
  writes temporary files; this is not a real model tool/image compatibility test. Use the compatibility matrix in
  [MODEL_ROUTING.md](MODEL_ROUTING.md). OpenRouter, OmniRouter, Google-through-gateway and Claude live compatibility
  remain unverified. Image capability declarations must be validated by the user with a capped smoke test.
- Automatic fallback is deferred. No cross-provider replay is attempted even for a pre-tool quota failure, because
  native CLI hooks and earlier file writes cannot be ruled out from the event stream. Manual Retry resumes the pin.
- No OpenCode runtime, profile UI selector, budget estimator or direct Gemini transport is included. The config file,
  diagnostics command, persisted pins and event metadata provide the initial management interface.
- External native CLI provider/auth configuration is not snapshotted by model-only routes. Keep it unchanged during
  active sessions, or configure an explicit provider block in a new project.
- Baseline dependency advisory remains outside this change. No API keys, project media or original-checkout changes
  are included in the branch.

Before opening the upstream PR, test the selected real models for file writes, a shell command, image inspection,
session resume and one short 2D workflow, then record the exact CLI/provider versions and capped spend here.
