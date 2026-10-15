<p align="right"><b>English</b> · <a href="zh-TW/LINE.md">繁體中文</a> · <a href="zh-CN/LINE.md">简体中文</a></p>

# LINE bot

Check on your videos from LINE, and get a message when one needs you or is done, without keeping the web page open.

This first version only reports. It never changes a project. The commands are built so actions (approve a plan,
answer a question, cancel) can be added later as one entry each: see [Adding a command](#adding-a-command).

## What it does

| Send | Or | What you get |
|---|---|---|
| `列表` | `list` | The latest 8 projects, numbered, with their status |
| `進度` | `status` | Where the latest project is |
| `進度 2` · `進度 貓咪` | `status 2` · `status cat` | Where project #2 from your last list is, or one whose title contains the word |
| `通知 開` · `通知 關` | `notify on` · `notify off` | Turn notifications on or off for your account |
| `說明` | `help` | The list of commands |
| `解除綁定` | `unlink` | Stop using this LINE account with ReelMimic |

Chinese commands can run straight into the number (`進度2`). The bot answers in the language of the command you used,
and sends notifications in the language you used last. Most replies have buttons for the next likely command.

A status reply looks like this:

```
🎬 Cat bath day
⏳ Producing · 3 min ago
Step: Building segments
Characters: passed
Segments: 4/7 passed · 2 in progress
```

**Notifications** arrive when a video's plan is ready for approval, when it pauses because it needs something from you,
when it's done, and when it stops with an error. Cancelling a turn yourself doesn't send one. Only changes after the
server starts count, so restarting the server doesn't repeat old news.

## Setup

You need a LINE account, about ten minutes, and a way to give your computer a public HTTPS address for one port
(a tunnel, explained in step 4).

### 1. Create the bot

1. Create a LINE Official Account at [LINE Official Account Manager](https://manager.line.biz/) (the free plan is fine).
2. In its **Settings → Messaging API**, turn on the Messaging API. This creates a channel in the
   [LINE Developers console](https://developers.line.biz/console/).
3. In the Developers console, open the channel:
   - **Basic settings** → copy the **Channel secret**.
   - **Messaging API** → **Channel access token (long-lived)** → **Issue**, and copy it.
4. Back in the Official Account Manager, under **Settings → Response settings**: turn **Webhook** on, and turn
   **Auto-reply messages** off (otherwise LINE's own canned answer arrives next to every bot reply). You can turn the
   **Greeting message** off too, since the bot greets new friends itself.

### 2. Add the keys

Put both in `~/.reelmimic/secrets.json`. That file is outside the repo, so it never gets committed:

```json
{
  "LINE_CHANNEL_SECRET": "…",
  "LINE_CHANNEL_ACCESS_TOKEN": "…"
}
```

### 3. Start ReelMimic

Start it as usual. With both keys set, the terminal shows two more lines (the code only while no account is linked yet):

```
LINE bot → webhook on http://127.0.0.1:4319/line/webhook (put only this port behind your HTTPS tunnel) · 0 linked accounts
LINE bot: to link a LINE account, send the bot within 10 minutes: 綁定 482913  (or: pair 482913)
```

### 4. Give the webhook a public address

LINE has to reach your computer over HTTPS. Point a tunnel at **port 4319 only** (the LINE port, not the web app's 4318),
for example:

```bash
cloudflared tunnel --url http://127.0.0.1:4319     # prints https://<random>.trycloudflare.com
# or
ngrok http 4319                                     # prints https://<random>.ngrok-free.app
```

In the Developers console, under **Messaging API → Webhook settings**, set the webhook URL to
`https://<your tunnel address>/line/webhook`, turn **Use webhook** on and click **Verify**. It should say *Success*.

Quick tunnels get a new address every time they start. For a bot you keep using, set up a named Cloudflare tunnel or an
ngrok static domain, so the webhook URL doesn't change.

### 5. Link your LINE account

Add the bot as a friend (QR code under **Messaging API** in the Developers console) and send it the line from the
terminal, such as `綁定 482913`. A code works once, for 10 minutes.

For a new code (it expired, or you want to link another account, a partner's phone say), run this in `app/` while
ReelMimic is running:

```bash
npm run line-code
```

## Security

- **Only the webhook goes online.** The web app has no login, and it can start AI agents that run commands on your
  computer, so port 4318 must never be reachable from the internet. That's why the bot listens on its own port, and
  that port serves only `POST /line/webhook`. Everything else there answers 404.
- **Every request is signed.** The bot checks each request's signature against your channel secret and rejects
  anything else with 401.
- **Strangers learn nothing.** Anyone can add a LINE bot as a friend, so the bot answers nobody until they link their
  account. Unlinked accounts only get the linking instructions.
- **Only you can make a link code.** A code exists only after you ask for one on the computer (the first start, or
  `npm run line-code`, which asks the server on localhost). It has 6 digits, works once, for 10 minutes, and 5 wrong
  tries burn it. Nobody can request a code from LINE, so a stranger gets at most 5 guesses per code you make.
- **One-to-one chats only.** In a group, project details would reach everyone in it, so the bot ignores groups.
- **Your linked accounts** are saved in `~/.reelmimic/line.json`. Send `解除綁定` / `unlink` from a phone to remove one, or
  stop the server and delete the file to remove them all (the running server keeps them in memory).

## Message quota

Replies to your commands are free. Notifications are *push messages*, which count toward your Official Account plan's
monthly message allowance. One notification to one linked account is one message. The free plan allows a few hundred
a month, so check your plan if you make many videos. If you only want to ask, send `通知 關` / `notify off`.

## Settings

All optional except the first two. They go in `~/.reelmimic/secrets.json` or the environment.

| Key | What it's for |
|---|---|
| `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` | Turn the bot on (both are needed) |
| `LINE_PORT` | The webhook's port (default 4319) |
| `LINE_ALLOWED_USERS` | LINE user IDs (`U…`, comma-separated) that may use the bot without a link code |
| `LINE_STATE` | Where linked accounts are saved (default `~/.reelmimic/line.json`) |
| `REELMIMIC_URL` | Where your phone can open the web app, to put a link in each message. Only set this if you've made the web app reachable privately, for example over [Tailscale](https://tailscale.com). Never expose it publicly |

## How it works

```
LINE ──HTTPS──▶ your tunnel ──▶ 127.0.0.1:4319  POST /line/webhook
                                   │ signature check → linked? → command
                                   ▼
                          server/line/  ──reads──▶ job.json + contract files (the same snapshot the web app shows)
                                   ▲
              job stage changes ───┘ (the job machine's event bus) → push to linked accounts
```

| File | What it does |
|---|---|
| `app/server/line/index.ts` | The webhook server, event handling, notifications, `startLine()` (called by `server/index.ts`) |
| `app/server/line/commands.ts` | The commands: one entry each, plus the parser |
| `app/server/line/progress.ts` | The text of the list and the status report |
| `app/server/line/store.ts` | Linked accounts and the link code |
| `app/server/line/client.ts` | The LINE API: signature check, reply, push |
| `app/scripts/line-code.mjs` | `npm run line-code`: asks the running server (`POST /api/line/code`, localhost only) for a new link code |

The bot starts only after the server owns its port and has marked interrupted jobs. So a restart never announces
those as errors, and a second copy of the server never starts a second bot.

## Adding a command

Add an entry to `COMMANDS` in `app/server/line/commands.ts`. It needs its aliases, a help line, and `run`, which
returns the messages to send back. A command that acts on a project should call the same functions the HTTP API
calls, with the same checks. For example, approving a plan:

```ts
{
  names: ['核准', 'approve'], help: { zh: '核准 [編號]：核准企劃、開始製作', en: 'approve [number]: approve the plan and start production' },
  run: ({ userId, lang, args }) => {
    const p = findProject(userId, args);
    if (!p) return [text(t(lang, '找不到這個專案。', 'No such project.'))];
    if (J.busy(p.id)) return [text(t(lang, 'AI 正在工作中，等這一輪做完。', 'An agent is working on it; wait for this turn to finish.'))];
    const open = J.openInputs(p.id);
    if (open.length) return [text(t(lang, `還缺：${open.map((r) => r.label || r.id).join('、')}`, `Still missing: ${open.map((r) => r.label || r.id).join(', ')}`))];
    J.approve(p.id).catch((e) => console.error(e));
    return [text(t(lang, '開始製作了，有消息會通知你。', 'Production started. You will hear from me.'))];
  },
},
```

Guidelines:

- **Use the same rules as the web app.** Look at the matching route in `app/server/index.ts` and do the same checks
  (`J.busy`, required inputs). Don't write to `job.json` yourself.
- **Confirm anything you can't undo.** For cancel, say, reply with a quick-reply button that sends a confirming command,
  such as `取消 3 確定`, instead of acting on the first message. Tapping a quick-reply button or a postback both arrive as
  plain command text.
- **Treat the text as untrusted.** It comes from a phone. Match it against project ids or titles and never pass it to a
  shell or a file path.
- **Add a test** in `app/server/line/line.test.ts`. The LINE API is mocked there, so you can check exactly what the bot
  would send.

Sending the finished video itself would need its file on a public HTTPS address, which LINE requires for video
messages. That's left for later, because it means publishing project files.
