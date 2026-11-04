// The one entry point for every Claude Code hook (.claude/settings.json): `node dispatch.mjs pre|post|stop`.
// Reads the event, answers the common case on the fast path (./fast.mjs: no TypeScript, no module graph), and only
// otherwise loads the handler — with Node's compile cache on, so even that skips re-stripping and re-compiling the
// .mts files after the first run. Measured per call on Windows (median of 15): 99 ms before → see docs/HARNESS.md.
import module from 'node:module';
import { markStart, needsHandler } from './fast.mjs';

const kind = /** @type {'pre' | 'post' | 'stop'} */ (process.argv[2]);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let e = null;
try { e = JSON.parse(raw || '{}'); } catch {}

if (kind === 'pre') markStart(e);
if (needsHandler(kind, e)) {
  module.enableCompileCache?.();
  const [{ respond }, { handle }] = await Promise.all([
    import('../lib/hook.mts'),
    import(kind === 'pre' ? './pre-tool-use.mts' : kind === 'post' ? './post-tool-use.mts' : './stop.mts'),
  ]);
  await respond({ pre: 'pre-tool-use', post: 'post-tool-use', stop: 'stop' }[kind] ?? String(kind), raw, handle);
}
process.exit(0);
