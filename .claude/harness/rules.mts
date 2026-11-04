// Every project rule, and every place that enforces it. A rule that only lives in a prompt is a wish; this table says
// which ones are wishes. `sync-rules.mts --check` (CI) keeps it honest in both directions:
//   - each rule id in CLAUDE.md's shared block has an entry here, and each entry here is a rule there;
//   - each `at` exists, and its `#anchor` (when given) still appears in that file outside comments — so renaming a policy, moving a
//     script or deleting the prompt line that carries a rule breaks the build instead of silently dropping the rule;
//   - each `hook` entry names a policy in policy.mts that declares this rule, and every policy is listed here.
export type Layer = 'hook' | 'runtime' | 'ci' | 'tool' | 'git' | 'prompt';
export interface Enforcement { layer: Layer; at: string; how: string }

export const LAYERS: Record<Layer, string> = {
  hook: 'Claude Code hook: every tool call of every Claude Code session in the repo, the app’s production agents included',
  runtime: 'the app pipeline: gates every production job, Claude Code or Codex',
  ci: 'GitHub Actions on every push and pull request',
  tool: 'a script the workflow runs, whose output is the evidence',
  git: 'repository configuration',
  prompt: 'instructions only: followed when read, nothing checks it',
};

export const ENFORCEMENT: Record<string, Enforcement[]> = {
  '2d-only': [
    { layer: 'prompt', at: '.claude/skills/video-clone/SKILL.md#目前只做 2D', how: 'style router filters by medium; 3D styles sit in styles/_disabled/' },
  ],
  'assets': [
    { layer: 'tool', at: '.claude/skills/video-clone/scripts/fetch_assets.py#ASSETS.md', how: 'only reuse-licensed sources; every download is recorded with its licence' },
    { layer: 'prompt', at: '.claude/skills/video-clone/SKILL.md', how: 'characters, lyrics and reference footage rules' },
  ],
  'compare-gate': [
    { layer: 'runtime', at: 'app/server/prompts.ts#每鏡 ≥ 4', how: 'the final critic scores every shot against the reference; must-fix items go back to the builders' },
    { layer: 'runtime', at: 'app/server/review.ts#reviewFix', how: 'review → fix loop with a fresh reviewer each round, up to the quality mode’s limit' },
    { layer: 'tool', at: '.claude/skills/video-clone/scripts/compare.py', how: 'side-by-side reference vs film, per shot' },
  ],
  'look-after-render': [
    { layer: 'hook', at: '.claude/harness/hooks/post-tool-use.mts#contactSheet', how: 'after a film render: contact sheet + black/frozen scan handed to the agent' },
    { layer: 'hook', at: '.claude/harness/hooks/stop.mts#stop_hook_active', how: 'an agent that rendered and never read an image is sent back once' },
    { layer: 'runtime', at: 'app/server/prompts.ts#動作只能從連續影格判斷', how: 'reviewers that did not build the shot judge it from consecutive frames, with before/after crops as evidence' },
  ],
  'secrets': [
    { layer: 'hook', at: '.claude/harness/policy.mts#secrets-write', how: 'writes to any secrets.json are denied (Write/Edit, redirects, cp/mv/sed/…, globs and folder-walking tools over it)' },
    { layer: 'hook', at: '.claude/harness/policy.mts#secrets-read', how: 'reading the real file asks the user first (Read, Grep, cat, globs, grep -r over a folder above it)' },
    { layer: 'git', at: '.gitignore#secrets.json', how: 'never committed' },
  ],
  'projects-private': [
    { layer: 'hook', at: '.claude/harness/policy.mts#git-add-projects', how: '`git add` of anything under projects/ (or -f over it) is denied' },
    { layer: 'git', at: '.gitignore#projects/*', how: 'ignored, so only a forced add could stage it' },
  ],
  'one-server': [
    { layer: 'hook', at: '.claude/harness/policy.mts#second-server', how: 'starting a server on the real projects/ while one answers /api/health is denied' },
    { layer: 'runtime', at: 'app/restart.sh#not restarting', how: 'the sanctioned restart refuses while agents are working' },
    { layer: 'ci', at: 'app/server/jobs.test.ts#REELMIMIC_PROJECTS', how: 'tests run against a throwaway projects dir' },
  ],
};
