// A new LINE link code from the running ReelMimic server (docs/LINE.md).   npm run line-code
// The code works once, for 10 minutes. Send it to the bot from the LINE account you want to link.
// @ts-check
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same port as the server: PORT from the environment, else from secrets.json, else the default
let port = process.env.PORT;
if (!port) try { port = JSON.parse(readFileSync(process.env.REELMIMIC_SECRETS || join(homedir(), '.reelmimic', 'secrets.json'), 'utf8')).PORT; } catch {}
port = String(port || 4318);

/** @type {Response} */
let r;
try { r = await fetch(`http://127.0.0.1:${port}/api/line/code`, { method: 'POST', headers: { 'X-ReelMimic': 'line-code' }, signal: AbortSignal.timeout(10000) }); }
catch { console.error(`ReelMimic isn't running on port ${port}. Start it first, then run this again.`); process.exit(1); }
const body = /** @type {{ code?: string; error?: string }} */ (await r.json().catch(() => ({})));
if (!r.ok) { console.error(body.error || `The server answered ${r.status}.`); process.exit(1); }
console.log(`\n  Send the LINE bot, within 10 minutes:\n\n    綁定 ${body.code}      (or: pair ${body.code})\n`);
