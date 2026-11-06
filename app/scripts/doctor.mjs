// Checks everything ReelMimic needs and says how to fix what's missing.   npm run doctor
// Plain JavaScript on purpose: it must run (and say "upgrade Node") even on a Node too old to run the TypeScript server.
// @ts-check
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// The server runs its TypeScript directly (Node's built-in type stripping, on by default from 22.18).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) { console.log(`
  [31m✗[0m Node ${process.versions.node}: ReelMimic needs Node 22.18 or newer
      → https://nodejs.org
`); process.exit(1); }
await import('../server/env.ts');   // same secrets and Python choice as the server

const IS_WIN = platform() === 'win32';
/** @param {string} m */
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
/** @param {string} m @param {string} [fix] */
const bad = (m, fix) => { console.log(`  \x1b[31m✗\x1b[0m ${m}${fix ? `\n      → ${fix}` : ''}`); failed++; };
/** @param {string} m @param {string} [fix] */
const opt = (m, fix) => console.log(`  \x1b[33m○\x1b[0m ${m}${fix ? `  (${fix})` : ''}`);
let failed = 0;
// .cmd shims (claude, codex, npx) need a shell on Windows; real executables must not go through one (it would split `-c "import x"`)
/** @param {string} cmd @param {string[]} args */
const run = (cmd, args, shell = IS_WIN && !/python|ffmpeg|blender/i.test(cmd)) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell, timeout: 20000 }).trim(); } catch { return null; } };
const PY = process.env.PYTHON || 'python';

console.log('\nReelMimic — environment check\n');
console.log('Core');
ok(`Node ${process.versions.node}`);
const pyv = run(PY, ['--version']);
pyv ? ok(pyv) : bad('Python 3.10+ not found', 'install Python, or set PYTHON=/path/to/python');
const ff = run('ffmpeg', ['-version']);
const ffDir = process.env.FFMPEG_DIR && existsSync(join(process.env.FFMPEG_DIR, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'));
ff || ffDir ? ok(`FFmpeg ${(ff || '').split('\n')[0].split(' ')[2] || `(FFMPEG_DIR)`}`) : bad('FFmpeg not found', 'install FFmpeg and put it on PATH, or set FFMPEG_DIR');
const chromes = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(/** @returns {p is string} */ (p) => !!p);
const chrome = chromes.find((p) => existsSync(p));
chrome ? ok(`Chrome ${chrome}`) : bad('Chrome/Chromium not found (renders frames headlessly)', 'install Chrome, or set CHROME_PATH');

console.log('\nPython packages');
const mods = [['numpy', 'numpy'], ['cv2', 'opencv-python'], ['scenedetect', 'scenedetect'], ['librosa', 'librosa'], ['PIL', 'Pillow'], ['yt_dlp', 'yt-dlp']];
const optMods = [['faster_whisper', 'faster-whisper', 'lyrics auto-timing'], ['opencc', 'opencc-python-reimplemented', 'lyrics simplified→traditional']];
if (pyv) {
  const probe = (/** @type {string} */ m) => run(PY, ['-c', `import ${m}`]) !== null;
  for (const [m, pkg] of mods) probe(m) ? ok(pkg) : bad(pkg, `${PY} -m pip install -r requirements.txt`);
  for (const [m, pkg, why] of optMods) probe(m) ? ok(pkg) : opt(`${pkg} not installed`, why);
}

console.log('\nAI director (at least one)');
const claude = run('claude', ['--version']);
const codexBin = process.env.CODEX_BIN || 'codex';
const codex = run(codexBin, ['--version']);
claude ? ok(`Claude Code ${claude}`) : opt('Claude Code CLI not found', 'npm i -g @anthropic-ai/claude-code, then run `claude` once to log in');
codex ? ok(`Codex ${codex}`) : opt('Codex CLI not found', 'npm i -g @openai/codex, then `codex login`');
if (!claude && !codex) bad('no agent CLI available', 'install Claude Code or Codex (see above)');

console.log('\nOptional');
const secretsPath = [join(homedir(), '.reelmimic', 'secrets.json'), join(homedir(), '.clone-studio', 'secrets.json')].find((p) => existsSync(p)) || join(homedir(), '.reelmimic', 'secrets.json');
/** @type {Record<string, unknown>} */
let secrets = {};
try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch {}
const has = (/** @type {string} */ k) => process.env[k] || secrets[k];
has('YATING_KEY') ? ok('YATING_KEY (Taiwan TTS voices)') : opt('YATING_KEY not set', `natural Taiwan Mandarin narration; put it in ${secretsPath}`);
has('PIXABAY_KEY') ? ok('PIXABAY_KEY') : opt('PIXABAY_KEY not set', 'more stock images/music; Openverse works without a key');
// Notifications: ask each channel whether the keys work, so a dead webhook or token shows up here and not in the server log later
const { checkNotify } = await import('../server/notify-check.ts');
const channels = await checkNotify();
for (const c of channels) c.ok ? ok(`Notifications: ${c.name} (${c.detail})`) : opt(`Notifications: ${c.name} not working`, c.detail);
if (!channels.length) opt('No notifications set', 'DISCORD_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or WEBHOOK_URL: get a message when a video needs you or is done');
// Telegram: the bot token alone isn't enough, and the chat id is the hard part to find, so look it up from the bot's recent messages
if (has('TELEGRAM_BOT_TOKEN') && !has('TELEGRAM_CHAT_ID')) {
  /** @typedef {{ chat: { id: number, title?: string, username?: string, first_name?: string } }} WithChat */
  /** @type {{ ok?: boolean, description?: string, result?: { message?: WithChat, channel_post?: WithChat, my_chat_member?: WithChat }[] }} */
  let body = {}, failed = '';
  try { body = /** @type {typeof body} */ (await (await fetch(`https://api.telegram.org/bot${has('TELEGRAM_BOT_TOKEN')}/getUpdates`, { signal: AbortSignal.timeout(10000) })).json()); }
  catch (e) { failed = `couldn't reach Telegram: ${/** @type {Error} */ (e).message}`; }
  // private chats and groups send `message`, channels `channel_post`; adding the bot to a group/channel is `my_chat_member`
  const chats = [...new Map((body.result || []).flatMap((u) => { const c = (u.message || u.channel_post || u.my_chat_member)?.chat; return c ? [c] : []; })
    .map((c) => [c.id, `${c.id} (${c.title || c.username || c.first_name || 'chat'})`])).values()];
  opt('TELEGRAM_CHAT_ID not set', failed || (body.ok === false ? `Telegram says: ${body.description}` // e.g. 401 bad token, 409 a webhook is set
    : chats.length ? `put one of these in ${secretsPath}: ${chats.join(', ')}` : 'send your bot any message in Telegram, then run npm run doctor again to see your chat id'));
}
has('FREESOUND_KEY') ? ok('FREESOUND_KEY') : opt('FREESOUND_KEY not set', 'more sound effects');
run('blender', ['--version']) || process.env.BLENDER ? ok('Blender (3D track)') : opt('Blender not found', 'only needed for the paused 3D product track');
run('npx', ['--no-install', 'hyperframes', '--version']) ? ok('hyperframes CLI cached') : opt('hyperframes CLI not cached yet', 'downloaded automatically by npx on first use');

console.log(failed ? `\n${failed} required item(s) missing.\n` : '\nAll required items present. Start with: npm start\n');
process.exit(failed ? 1 : 0);
