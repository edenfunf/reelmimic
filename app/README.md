# app/ — the ReelMimic web app

Install and start it as described in the root [README](../README.md); how it works is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

```
server/   index.ts (HTTP/SSE) · jobs.ts (workflow and production line) · prompts.ts (agent instructions) · agents/ (Claude Code / Codex adapters) · notify.ts (Discord / webhook messages) · env.ts (keys)
web/      React UI: App.tsx (home) · Project.tsx (project page) · Chat.tsx (chat and live agent steps) · ui.tsx (components) · i18n.ts (languages) · styles.css
shared/   types.ts (job.json, the project snapshot and live events: the contract between server and web)
scripts/  doctor.mjs (environment check; plain JS so it can run on any Node and say what to upgrade)
```

TypeScript throughout (strict). The server runs its `.ts` files directly on Node's built-in type stripping (Node 22.18+),
so there is no build step for it; Vite builds the web UI.

```
npm run server      start the server (http://localhost:4318)
npm run web         UI dev server with hot reload (proxies /api to the server)
npm run check       type check + lint + tests (what CI runs, plus npm run build)
```
