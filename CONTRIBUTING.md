<p align="right"><b>English</b> · <a href="docs/zh-TW/CONTRIBUTING.md">繁體中文</a></p>

# Contributing

Thanks for wanting to help make ReelMimic better!

## Setup

Install it as described in the [README](README.md), then:

```bash
cd app
npm run server   # backend (after editing server/, restart with: bash app/restart.sh)
npm run web      # UI with hot reload at http://localhost:5173
npm run doctor   # environment check
```

How it works is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and how to extend it is in [docs/EXTENDING.md](docs/EXTENDING.md).

## Good first contributions

- **A new style**: add `.claude/skills/video-clone/styles/<name>.md`, with a short description of the reference you
  tested it on (please don't attach copyrighted video files).
- **Known pitfalls**: problems you ran into while making a video and how you fixed them. Add them to the matching
  style file or the engine's `SKILL.md`.
- **A new rendering engine**: an agent skill folder. For third-party skills, include the source and license and update
  `THIRD_PARTY_NOTICES.md`.
- **Pipeline and prompts**: if you change `app/server/prompts.ts` or `jobs.ts`, say which video you tested with and
  include a before/after timing from `timeline.py`.

## Before you open a PR

- In `app/`: `npm run check` (type check, lint, tests) and `npm run build` pass. CI runs the same on every PR.
- The app is TypeScript (strict). The server runs its `.ts` files directly on Node's type stripping, so there is no build step
  for it; use only erasable syntax (no `enum`, `namespace` or parameter properties).
- Don't commit `projects/`, API keys (`~/.reelmimic/secrets.json`), reference videos, or any asset you don't have the
  rights to.
- Comments and docs can be in English or Traditional Chinese. Match what's around them.

## Community

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
