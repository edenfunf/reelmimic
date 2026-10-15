// Bot commands. Each one is an entry in COMMANDS: aliases, a help line, and run(ctx) → the messages to send back.
// Adding a command (including ones that act, like approving a plan) means adding an entry here; see docs/LINE.md.
import * as J from '../jobs.ts';
import { quick, text, type LineMessage } from './client.ts';
import { listLine, report } from './progress.ts';
import type { BotLang, LineUser, Store } from './store.ts';

export interface Ctx {
  userId: string;
  user: LineUser | null;   // null: this LINE account isn't linked yet
  lang: BotLang;
  args: string;            // the text after the command word
  store: Store;
}
export interface Command {
  names: string[];                      // matched at the start of the message (Traditional and Simplified); an English alias makes the bot answer in English
  help?: Record<BotLang, string>;       // a line in 說明 / help (leave out to hide the command)
  open?: boolean;                       // usable before the account is linked (only linking itself)
  run: (ctx: Ctx) => LineMessage[] | Promise<LineMessage[]>;
}

const LIST_MAX = 8;
// The numbers in the last list each user saw, so "進度 2" means the project that was #2 there even after the order changed
const lastList = new Map<string, string[]>();
const t = (lang: BotLang, zh: string, en: string) => (lang === 'en' ? en : zh);
const btn = (lang: BotLang, zh: string, en: string) => ({ label: t(lang, zh, en), text: t(lang, zh, en) });

// "2" (from the last list) · a project id · part of a title · nothing (the most recently active project)
export function findProject(userId: string, ref: string) {
  const all = J.listJobs(), r = ref.trim();
  if (!r) return all[0] || null;
  if (/^\d{1,2}$/.test(r)) { const seen = lastList.get(userId), id = seen ? seen[+r - 1] : all[+r - 1]?.id; return all.find((p) => p.id === id) || null; }
  return all.find((p) => p.id === r) || all.find((p) => p.title.toLowerCase().includes(r.toLowerCase())) || null;
}

const help = ({ lang }: Pick<Ctx, 'lang'>) => [text([
  t(lang, 'ReelMimic 機器人可以用的指令：', 'What you can ask the ReelMimic bot:'),
  ...COMMANDS.filter((c) => c.help).map((c) => `• ${c.help![lang]}`),
].join('\n'), quick([btn(lang, '列表', 'list'), btn(lang, '進度', 'status')]))];

export const COMMANDS: Command[] = [
  { names: ['說明', '幫助', '指令', '说明', '帮助', 'help', 'menu', '?'], help: { zh: '說明：顯示這份清單', en: 'help: this list' }, run: help },
  {
    names: ['列表', '專案', '专案', '项目', 'list', 'projects'], help: { zh: '列表：最近的專案', en: 'list: recent projects' },
    run: ({ userId, lang }) => {
      const all = J.listJobs().slice(0, LIST_MAX), now = Date.now();
      if (!all.length) return [text(t(lang, '還沒有專案。到網頁上丟一支參考影片就能開始。', 'No projects yet. Drop a reference video on the web page to start one.'))];
      lastList.set(userId, all.map((p) => p.id));
      const lines = [t(lang, '最近的專案：', 'Recent projects:'), ...all.map((p, i) => listLine(p, i + 1, lang, now)), '', t(lang, '傳「進度 編號」看細節', 'Send "status <number>" for details')];
      return [text(lines.join('\n'), quick(all.map((p, i) => ({ label: `${i + 1}. ${p.title}`, text: `${t(lang, '進度', 'status')} ${i + 1}` }))))];
    },
  },
  {
    names: ['進度', '狀態', '进度', '状态', 'status', 'progress'], help: { zh: '進度 [編號／名稱]：一支影片做到哪裡（不填就是最近的那支）', en: 'status [number / name]: where a video is (the latest one if you leave it out)' },
    run: ({ userId, lang, args }) => {
      const p = findProject(userId, args), ref = args.trim();
      if (!p) return [text(ref ? t(lang, `找不到「${ref}」。`, `No project matches "${ref}".`) : t(lang, '還沒有專案。', 'No projects yet.'), quick([btn(lang, '列表', 'list')]))];
      return [text(report(J.snapshot(p.id), lang), quick([{ label: t(lang, '重新整理', 'Refresh'), text: `${t(lang, '進度', 'status')} ${p.id}` }, btn(lang, '列表', 'list')]))];
    },
  },
  {
    names: ['通知', 'notify', 'notifications'], help: { zh: '通知 開／關：企劃好了、需要你、完成或出錯時傳訊息給你', en: 'notify on / off: a message when a plan is ready, a video needs you, is done or fails' },
    run: ({ userId, user, lang, args, store }) => {
      const a = args.trim().toLowerCase(), on = /^(開|开|開啟|开启|on|yes)$/.test(a), off = /^(關|关|關閉|关闭|off|no)$/.test(a);
      if (on || off) store.set(userId, { notify: on });
      const now = on || (!off && !!user?.notify);
      return [text(now ? t(lang, '通知：開。企劃好了、需要你、完成或出錯時會傳訊息給你。', 'Notifications: on. You get a message when a plan is ready, a video needs you, is done or fails.')
        : t(lang, '通知：關。想知道進度時傳「進度」。', 'Notifications: off. Send "status" whenever you want to check.'),
      quick([now ? { label: t(lang, '關掉通知', 'Turn off'), text: t(lang, '通知 關', 'notify off') } : { label: t(lang, '打開通知', 'Turn on'), text: t(lang, '通知 開', 'notify on') }]))];
    },
  },
  {
    names: ['綁定', '绑定', 'pair', 'link'], open: true,
    run: ({ userId, lang, args, store }) => {
      const r = store.pair(userId, args.replace(/\s+/g, ''), lang);
      if (r === 'already') return [text(t(lang, '這個 LINE 帳號已經綁定了。', 'This LINE account is already linked.'))];
      const fresh = t(lang, '在執行 ReelMimic 的電腦上，到 app 資料夾執行 npm run line-code 拿一組新的配對碼（10 分鐘內有效）。', 'On the computer running ReelMimic, run npm run line-code in the app folder for a new code (valid for 10 minutes).');
      if (r === 'wrong') return [text(t(lang, '配對碼不對，再看一次終端機上的數字。', 'That code is wrong. Check the number in the terminal again.'))];
      if (r === 'burned') return [text(t(lang, `錯太多次，這組配對碼作廢了。${fresh}`, `Too many wrong tries, so that code no longer works. ${fresh}`))];
      if (r === 'expired') return [text(t(lang, `現在沒有有效的配對碼（過期或用過了）。${fresh}`, `There's no valid code right now (it expired or was used). ${fresh}`))];
      if (r === 'error') return [text(t(lang, '伺服器存不了綁定資料，請看終端機的錯誤訊息。', 'The server could not save the link. See the error in its terminal.'))];
      return [text(t(lang, '綁定好了 🎉 企劃好了、需要你、完成或出錯時會通知你。', 'Linked 🎉 You will get a message when a plan is ready, a video needs you, is done or fails.')), ...help({ lang })];
    },
  },
  {
    names: ['解除綁定', '解除绑定', 'unpair', 'unlink'], help: { zh: '解除綁定：這個 LINE 帳號不再收發 ReelMimic 訊息', en: 'unlink: stop using this LINE account with ReelMimic' },
    run: ({ userId, lang, store }) => {
      store.unpair(userId); lastList.delete(userId);
      return [text(t(lang, '已解除綁定。要再用時傳「綁定 配對碼」。如果你的 ID 寫在 LINE_ALLOWED_USERS，也要從那裡拿掉，否則伺服器重開後又會生效。',
        'Unlinked. Send "pair <code>" to link again. If your ID is in LINE_ALLOWED_USERS, remove it there too, or it comes back when the server restarts.'))];
    },
  },
];

// Longest alias first, so 解除綁定 wins over 綁定. CJK aliases may be followed directly by the argument (進度2);
// Latin ones need a space or the end of the message (so "listen" isn't "list"). NFKC folds full-width input (？, ２).
export const CJK = /[\u3400-\u9fff]/;
const ALIASES = COMMANDS.flatMap((c) => c.names.map((n) => ({ n: n.toLowerCase(), c }))).sort((a, b) => b.n.length - a.n.length);
export function parse(raw: string): { cmd: Command; args: string; lang: BotLang | null } | null {
  const s = raw.normalize('NFKC').trim().replace(/^[/!]/, ''), low = s.toLowerCase();
  for (const { n, c } of ALIASES) {
    if (!low.startsWith(n)) continue;
    const latin = /[a-z]/.test(n), next = s.charAt(n.length);
    if (latin && next && !/\s/.test(next)) continue;
    return { cmd: c, args: s.slice(n.length).trim(), lang: latin ? 'en' : CJK.test(n) ? 'zh' : null };
  }
  return null;
}
