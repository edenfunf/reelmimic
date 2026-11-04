// The post-render check by hand, for renders that ran in the background or outside an agent:
//   node .claude/harness/look.mts <video> [--n 9] [--cols 3]   → contact sheet path + black/frozen stretches
import { contactSheet, defects } from './lib/video.mts';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: node .claude/harness/look.mts <video> [--n 9] [--cols 3]'); process.exit(2); }
const opt = (k: string, d: number) => { const i = rest.indexOf(k); return i >= 0 ? +rest[i + 1] : d; };
const sheet = await contactSheet(file, opt('--n', 9), opt('--cols', 3));
const d = await defects(file, sheet.duration);
console.log(JSON.stringify({ sheet: sheet.path, times: sheet.times, duration: +sheet.duration.toFixed(2), black: d.black, frozen: d.frozen, scanned: d.scanned }, null, 1));
