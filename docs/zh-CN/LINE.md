<p align="right"><a href="../LINE.md">English</a> · <a href="../zh-TW/LINE.md">繁體中文</a> · <b>简体中文</b></p>

# LINE 机器人

在 LINE 上看视频做到哪里；需要你处理或做好的时候，它会发消息给你，不用一直开着网页。

这一版只回报，不会动到任何项目。指令的架构已经预留好「操作」（核准企划、回答问题、取消），
之后每个操作加一笔就好，见[新增指令](#新增指令)。

## 能做什么

| 发送 | 或 | 会得到 |
|---|---|---|
| `列表` | `list` | 最近 8 个项目，有编号和状态 |
| `进度` | `status` | 最近那支做到哪里 |
| `进度 2` · `进度 猫咪` | `status 2` · `status cat` | 上次列表里第 2 个，或标题含这个词的那支 |
| `通知 开` · `通知 关` | `notify on` · `notify off` | 打开或关掉你这个账号的通知 |
| `说明` | `help` | 指令清单 |
| `解除绑定` | `unlink` | 这个 LINE 账号不再收发 ReelMimic 消息 |

中文指令可以直接接数字（`进度2`）。你用哪种语言下指令，它就用哪种语言回；通知用你最近一次用的语言。
大部分回复下面都有按钮，可以直接点下一个常用指令。

进度回复长这样（机器人目前用繁体中文回复）：

```
🎬 貓咪洗澡日
⏳ 生產中 · 3 分鐘前
階段：分段製作
角色：通過
分段：4/7 通過 · 2 段進行中
```

**通知**会在这些时候传：企划好了等你核准、需要你提供东西而暂停、完成、出错停下来。你自己按取消不会通知。
只算服务器启动之后的变化，所以重开服务器不会把旧消息再传一次。

## 设置

需要一个 LINE 账号、大约十分钟，还有让电脑的一个端口有公开 HTTPS 网址的方法（隧道，第 4 步说明）。

### 1. 创建机器人

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 创建一个 LINE 官方账号（免费方案就可以）。
2. 在它的**设置 → Messaging API** 启用 Messaging API，这会在 [LINE Developers 控制台](https://developers.line.biz/console/)创建一个 channel。
3. 到 Developers 控制台打开这个 channel：
   - **Basic settings** → 复制 **Channel secret**。
   - **Messaging API** → **Channel access token (long-lived)** → **Issue**，复制下来。
4. 回到 Official Account Manager 的**设置 → 回应设置**：打开 **Webhook**，关掉**自动回应消息**（不然每则回复旁边都会多一则
   LINE 的制式回答）。**加入好友的欢迎消息**也可以关掉，机器人自己会打招呼。

### 2. 放密钥

两个都放进 `~/.reelmimic/secrets.json`。这个文件在 repo 外面，不会被 commit：

```json
{
  "LINE_CHANNEL_SECRET": "…",
  "LINE_CHANNEL_ACCESS_TOKEN": "…"
}
```

### 3. 启动 ReelMimic

照常启动。两个密钥都设好的话，终端会多两行（还没有绑定任何账号时才会打印配对码）：

```
LINE bot → webhook on http://127.0.0.1:4319/line/webhook (put only this port behind your HTTPS tunnel) · 0 linked accounts
LINE bot: to link a LINE account, send the bot within 10 minutes: 綁定 482913  (or: pair 482913)
```

### 4. 让 webhook 有公开网址

LINE 要能用 HTTPS 连到你的电脑。用隧道指向**只有 4319 这个端口**（LINE 用的端口，不是网页的 4318），例如：

```bash
cloudflared tunnel --url http://127.0.0.1:4319     # 会打印 https://<随机>.trycloudflare.com
# 或
ngrok http 4319                                     # 会打印 https://<随机>.ngrok-free.app
```

到 Developers 控制台的 **Messaging API → Webhook settings**，把 webhook URL 设为
`https://<你的隧道网址>/line/webhook`，打开 **Use webhook**，按 **Verify**，应该会显示 *Success*。

临时隧道每次启动网址都会变。要长期用的话，设置一个命名的 Cloudflare 隧道或 ngrok 固定域名，webhook URL 才不用一直改。

### 5. 绑定你的 LINE 账号

加机器人为好友（QR code 在 Developers 控制台的 **Messaging API** 页），把终端上那行发给它，例如 `绑定 482913`。
配对码只能用一次，10 分钟内有效。

要新的配对码（过期了，或要再绑另一个账号，例如另一半的手机），在 ReelMimic 运行时到 `app/` 执行：

```bash
npm run line-code
```

## 安全

- **只有 webhook 上网。** 网页没有登录，又能启动会在你电脑上执行指令的 AI agent，所以 4318 绝对不能让网络连到。
  因此机器人用自己的端口，那个端口只提供 `POST /line/webhook`，其他路径一律 404。
- **每个请求都要签名。** 机器人用你的 channel secret 检查每个请求的签名，不对的一律 401。
- **陌生人什么都看不到。** 任何人都能加 LINE 机器人好友，所以没绑定的账号它一律不回答，只会收到绑定说明。
- **只有你能生成配对码。** 你在电脑上要了才会有配对码（第一次启动，或 `npm run line-code`，它会向本机的服务器要）。
  6 位数、只能用一次、10 分钟内有效，错 5 次就作废。从 LINE 没办法要配对码，所以陌生人每组最多只能猜 5 次。
- **只在一对一聊天回应。** 在群组里，项目内容会被群组所有人看到，所以群组消息一律不理。
- **绑定的账号**存在 `~/.reelmimic/line.json`。从手机发送 `解除绑定` 可以移除一个；要全部移除，先关掉服务器再删这个文件（运行中的服务器内存里还有一份）。

## 消息额度

回复你的指令不用钱。通知是*推送消息*，会算进官方账号方案的每月消息额度：一则通知传给一个绑定账号算一则。
免费方案每月大约几百则，片做得多的话看一下你的方案。只想自己问的话，发送 `通知 关`。

## 设置项

除了前两个，其他都可以不设。放在 `~/.reelmimic/secrets.json` 或环境变量。

| 键 | 用来做什么 |
|---|---|
| `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` | 打开机器人（两个都要） |
| `LINE_PORT` | webhook 的端口（默认 4319） |
| `LINE_ALLOWED_USERS` | 不用配对码就能用的 LINE user ID（`U…`，逗号分隔） |
| `LINE_STATE` | 绑定账号存在哪里（默认 `~/.reelmimic/line.json`） |
| `REELMIMIC_URL` | 手机能打开网页的网址，每则消息会附上项目链接。只有在你已经用私人方式让网页访问得到（例如 [Tailscale](https://tailscale.com)）时才设置，绝对不要公开 |

## 运作方式

```
LINE ──HTTPS──▶ 你的隧道 ──▶ 127.0.0.1:4319  POST /line/webhook
                                │ 检查签名 → 绑定了吗？→ 指令
                                ▼
                       server/line/  ──读──▶ job.json 和合约文件（跟网页看到的是同一份快照）
                                ▲
             项目阶段改变 ───────┘（job 状态机的事件总线）→ 推送给绑定的账号
```

| 文件 | 做什么 |
|---|---|
| `app/server/line/index.ts` | webhook 服务器、事件处理、通知、`startLine()`（由 `server/index.ts` 调用） |
| `app/server/line/commands.ts` | 指令：一个指令一笔，加上解析器 |
| `app/server/line/progress.ts` | 列表和进度回报的文字 |
| `app/server/line/store.ts` | 绑定的账号和配对码 |
| `app/server/line/client.ts` | LINE API：检查签名、回复、推送 |
| `app/scripts/line-code.mjs` | `npm run line-code`：向运行中的服务器要一组新的配对码（`POST /api/line/code`，仅限本机） |

机器人要等服务器拿到自己的端口、也标记好被中断的项目之后才启动。所以重开服务器不会把那些项目当成错误通知，
第二份服务器也不会再开第二个机器人。

## 新增指令

在 `app/server/line/commands.ts` 的 `COMMANDS` 加一笔：别名、说明文字、`run`（返回要传回去的消息）。
会动到项目的指令，要调用跟 HTTP API 一样的函数、做一样的检查。例如核准企划：

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

原则：

- **跟网页用一样的规则。** 看 `app/server/index.ts` 对应的路由，做一样的检查（`J.busy`、必要素材），不要自己改 `job.json`。
- **不能复原的要先确认。** 像取消，先回一个快速回复按钮，让它送出确认指令（例如 `取消 3 确定`），不要第一则消息就执行。
  点快速回复按钮和 postback 收到的都是一般的指令文字。
- **文字都当成不可信。** 它来自手机，只拿来比对项目代号或标题，绝对不要丢进 shell 或文件路径。
- **加测试**到 `app/server/line/line.test.ts`。那里的 LINE API 是假的，可以精确检查机器人会传什么。

直接传成片需要把视频放在公开的 HTTPS 网址（LINE 的视频消息规定），等于要公开项目文件，所以留到之后再做。
