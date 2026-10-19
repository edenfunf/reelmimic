# Advanced: model routing

The Claude Code / Codex picker still works without any new configuration or API key. Advanced routing selects models
through those same coding CLIs, retaining file access, shell tools, image tools, streaming and session resume. It is
separate from the renderer: no media generation API or rendering engine is changed. OpenCode is not included in this
first version; another runtime belongs behind the existing agent adapter, not a plain-text completion transport.

## Setup

1. Copy `routing.example.json` to `~/.reelmimic/routing.json` (`%USERPROFILE%\.reelmimic\routing.json` on Windows).
   Alternatively set `REELMIMIC_ROUTING` to an absolute local configuration path before starting the server.
2. Replace every `REPLACE_WITH_...` model ID. These are illustrative placeholders, not tested or purchasable model IDs.
   Choose a cheaper tool-capable coding model for `builder`, a multimodal model for `reviewer`, and a strong multimodal
   model for `director`. Verify the exact model and protocol on the provider. `vision: true` is **your explicit capability
   declaration**, not a ReelMimic certification. Do not declare it until you have tested image input through that CLI.
3. Supply the referenced environment variables in the environment that starts the server, or add them to
   `~/.reelmimic/secrets.json`. For example, add `OPENROUTER_API_KEY` with your own key to that local file. Existing
   environment variables win. Never put credential values into routing configuration, project files or Git.
4. In `app/`, run `npm run routing` (or `npm run routing -- <project-id>`). This validates configuration and prints
   requested role/model/provider selections without invoking an agent or spending credits. It does not test provider
   connectivity or report active session pins. The project snapshot's `job.sessionRoutes` contains those pins.
5. Start a **new project** and select either CLI in the normal picker. Mapped roles use their configured `runtime`;
   unmapped roles use the picker. Both CLIs must be installed if both are selected by routes.

For a model-only route using your CLI's existing authentication/configuration, omit `provider`:

```json
{
  "version": 1,
  "routes": {
    "planning": { "runtime": "claude", "model": "sonnet", "vision": true },
    "coding": { "runtime": "codex", "model": "REPLACE_WITH_CODING_MODEL" },
    "checking": { "runtime": "claude", "model": "opus", "vision": true }
  },
  "groups": { "director": "planning", "builder": "coding", "reviewer": "checking", "fixer": "coding" }
}
```

Model aliases above are illustrative. A route is a complete configuration, never a merge of fields from different
providers. Optional `timeoutMs` is an integer from 1000 to 7200000; routed turns default to two hours. Legacy turns
retain their existing timeout behavior. Unknown fields, role names, route references, malformed endpoints, missing
model IDs and missing custom-provider credentials fail before agent dispatch. Credentials for native CLI authentication
are checked by that CLI; the diagnostic command does not open account credential stores.

## Roles, groups and precedence

| Phase (exact role key) | Group | Session | Input / work |
|---|---|---|---|
| `style` | director | director | reference contact sheets; reasoning |
| `plan`, `replan` | director | director | plan and user feedback; reasoning |
| `plan_frames` | director | director | merge drafts and inspect rendered images |
| `setup`, `assemble` | director | director | code, shell, render and file writes |
| `shared_fix`, `revise` | director | director | shared changes, render and image inspection |
| `pre_cast` | builder | per character (`cast-<id>`) | character files |
| `pre_assets` | builder | fresh | asset search and files |
| `build_chunk` | builder | per chunk | code, shell and rendered frames |
| `cast_qa`, `shot_qa`, `critique` | reviewer | fresh per review | image inspection; independent judgment |
| `cast_fix` | fixer | per character or director for shared/serial fixes | code and image evidence |
| `fix_chunk` | fixer | same chunk builder | code and image evidence |

All phases execute an agent with tools; none are plain text-only completions. Vision is enforced for `style`,
`plan_frames`, `cast_qa`, `shot_qa` and `critique`. Other phases can also need image tools when rendering or fixing;
choose multimodal models for those workflows. False vision capability is rejected for required phases. Missing vision
capability is called **unverified** and requires an explicit declaration for required phases; it is not guessed from a
vendor/model name. Images continue to be read by the native agent tools from prompt-specified files.

For a new session, resolution is:

1. `projects[projectId].roles[phase]`, then global `roles[phase]`.
2. Project `groups[group]`, then global `groups[group]`.
3. Project `default`, then global `default`.
4. Legacy UI picker / native CLI defaults.

For example, add `"roles": { "critique": "director" }` to use the strong route for the independent final critic.
A project override has the same selection keys, e.g. `"projects": { "20261018-demo": { "default": "backup" } }`.
Global role/group mappings still outrank a project default. Remove those mappings or override the relevant project
roles/groups when switching a fully mapped project.

## Session safety and recovery

The server persists the selected route **before spawning** each resumable session, including a null legacy route.
That pin wins over subsequent routing changes and later phase/group selections in that session. For example,
`fix_chunk` retains its builder's route, and a shared `cast_fix` retains the director's route. An explicit phase override
cannot change a running session. Configure the session's first phase/group to choose its model. Fresh reviewers resolve
configuration on each independent invocation. A review's one contract-repair attempt resumes that review with the
same route; it does not become a new independent review. Pins survive interrupted-job recovery and server restart.

Pre-existing projects with unpinned legacy sessions cannot enable routing on those sessions: create a new project.
Once pinned to legacy, a session stays legacy even if routing is added. To return to legacy mode for new sessions,
rename/remove the routing file and unset `REELMIMIC_ROUTING`. Start a new project for a complete reset. Active routed
sessions retain their route. Do not edit `sessionRoutes` or swap runtime while a job runs.

Model-only routes inherit native CLI provider settings. Pins freeze the selected runtime/model and any explicit
provider block, **not external CLI configuration files, credentials or environment variables**. Do not change those
while using active sessions. Unconfigured legacy behavior stays under native CLI control.

There is **no automatic provider/model fallback in this first version**. A CLI can run hooks or edit files before
emitting a tool event; absence of a tool event cannot prove absence of side effects. Rate limits, quota failures,
infrastructure errors, malformed output and timeouts therefore stop normally without cross-provider replay. Inspect
files, restore quota/access, then use Retry to resume the same pinned session. To use the example `backup` route,
select it for a **new project/session**. No retry loop or cost estimator is added. Custom Codex provider request/stream
retry settings are set to zero; native CLIs/gateways may have their own internal recovery behavior. ReelMimic does not
control provider-side failover. Spending limits and an automatic fallback transport are deferred.

## Provider protocols and compatibility

| Runtime | Provider | Roles / modality | Verification in this change |
|---|---|---|---|
| Codex | native configured provider | all groups; tools, images through CLI | local 0.154.0 help/flags checked; deterministic fake CLI exercises tools/events/resume; no live model call |
| Claude Code | native configured provider | all groups; tools and images | args/env and stream parser tested; CLI not installed on test workstation; live compatibility unverified |
| Codex | OpenRouter Responses endpoint | all groups with a suitable tool/vision model | configuration matches provider docs; real endpoint/model compatibility unverified |
| Codex | OmniRouter / custom Responses gateway | all groups if full tool and image protocol works | argument/preflight tests only; real gateway unverified |
| Claude Code | Anthropic-format gateway | all groups if full tool/image protocol works | environment/preflight tests only; endpoint unverified |
| Codex / Claude | Google model behind a compatible gateway | tools and vision depend on gateway/model | unverified; no direct Gemini API adapter |
| Codex | Chat Completions-only endpoint | any | rejected: Responses required |
| Claude Code | Responses / Chat Completions endpoint | any | rejected: Anthropic-format protocol required |

Codex uses `--model` and per-invocation `-c model_provider=...` / `model_providers.reelmimic_route.*`, including
`wire_api="responses"` and `env_key`. Nothing modifies your global Codex configuration or logged-in account.
See [Codex advanced configuration](https://developers.openai.com/codex/config-advanced) and
[OpenRouter's Codex integration](https://openrouter.ai/docs/cookbook/coding-agents/codex-cli).
Model-only selection uses `--model` on both CLIs. Custom Claude endpoints use a child-only `ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`; conflicting `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` variables are removed from that child.
Cloud-provider switches are rejected for custom endpoints. See [Claude gateway requirements](https://code.claude.com/docs/en/llm-gateway).
This does not configure Claude's native Google Vertex authentication; keep that in existing CLI configuration and omit
the route's provider block. A plain Gemini API key does not turn Codex or Claude into a Gemini agent runtime.

On Windows, routed invocations use native executables or standard npm JS entry points directly, without `cmd.exe`
argument expansion. `CODEX_BIN` can point to a native executable or an absolute JS entry path. Nonstandard shell wrappers
fail with an actionable error; legacy launching remains unchanged. macOS/Linux use normal executable argument arrays.
No live provider tests or full paid rendering workflow were run. No additional minimum CLI version is asserted without
testing it: use current CLIs exposing the documented flags and run a capped tool/image/resume smoke test first.

## Diagnostics and troubleshooting

Routed turns emit a `model routing` diagnostic in the existing event log: role, runtime, provider ID, model, declared
vision and unverified endpoint status. Provider-returned cost/usage is recorded on `done`; absent cost is null
(**unknown**), absent usage is **unknown**. No pricing is inferred. Known credential environment values are redacted
from routed stream text and results; routed stderr uses generic diagnostics because raw errors can echo credentials.
Routing configuration errors never quote invalid values. Avoid putting credentials in prompts or shell commands.

- **Codex rejects an endpoint:** a Chat Completions endpoint is insufficient. Confirm Responses streaming, tool
  calls/results, reasoning fields and image input. Change the gateway or use its proper Responses endpoint.
- **Reviewer cannot see images:** validate image tools end to end using your chosen CLI/model. An unverified model is
  blocked on required visual roles until you explicitly declare `vision: true`; a false declaration cannot add vision.
- **Claude authentication conflict:** restart the server with the intended environment. Do not combine custom endpoint
  routing with Bedrock/Vertex/Foundry switches. Check native CLI settings/helpers if model-only auth still conflicts.
- **Quota or rate limit:** check the provider dashboard, inspect partial files, restore access and Retry. The job retains
  its original session. Changing routing JSON cannot move that conversation to another provider.
- **Different model than requested:** inspect `job.sessionRoutes`. A builder's fix and the director's later phases use
  the original session pin; create a new project to apply a different route throughout.
- **CLI exits without valid JSON:** routed invocations require a successful terminal result, even with exit code zero.
  Check CLI version/protocol and preserve artifacts before Retry. Existing JSON/artifact checks remain in place.
