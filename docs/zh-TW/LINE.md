<p align="right"><a href="../LINE.md">English</a> · <b>繁體中文</b> · <a href="../zh-CN/LINE.md">简体中文</a></p>

# LINE 機器人

在 LINE 上看影片做到哪裡；需要你處理或做好的時候，它會傳訊息給你，不用一直開著網頁。

這一版只回報，不會動到任何專案。指令的架構已經預留好「操作」（核准企劃、回答問題、取消），
之後每個操作加一筆就好，見[新增指令](#新增指令)。

## 能做什麼

| 傳 | 或 | 會得到 |
|---|---|---|
| `列表` | `list` | 最近 8 個專案，有編號和狀態 |
| `進度` | `status` | 最近那支做到哪裡 |
| `進度 2` · `進度 貓咪` | `status 2` · `status cat` | 上次列表裡第 2 個，或標題含這個詞的那支 |
| `通知 開` · `通知 關` | `notify on` · `notify off` | 打開或關掉你這個帳號的通知 |
| `說明` | `help` | 指令清單 |
| `解除綁定` | `unlink` | 這個 LINE 帳號不再收發 ReelMimic 訊息 |

中文指令可以直接接數字（`進度2`）。你用哪種語言下指令，它就用哪種語言回；通知用你最近一次用的語言。
大部分回覆下面都有按鈕，可以直接點下一個常用指令。

進度回覆長這樣：

```
🎬 貓咪洗澡日
⏳ 生產中 · 3 分鐘前
階段：分段製作
角色：通過
分段：4/7 通過 · 2 段進行中
```

**通知**會在這些時候傳：企劃好了等你核准、需要你提供東西而暫停、完成、出錯停下來。你自己按取消不會通知。
只算伺服器啟動之後的變化，所以重開伺服器不會把舊消息再傳一次。

## 設定

需要一個 LINE 帳號、大約十分鐘，還有讓電腦的一個埠有公開 HTTPS 網址的方法（通道，第 4 步說明）。

### 1. 建立機器人

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建一個 LINE 官方帳號（免費方案就可以）。
2. 在它的**設定 → Messaging API** 啟用 Messaging API，這會在 [LINE Developers 控制台](https://developers.line.biz/console/)建立一個 channel。
3. 到 Developers 控制台打開這個 channel：
   - **Basic settings** → 複製 **Channel secret**。
   - **Messaging API** → **Channel access token (long-lived)** → **Issue**，複製下來。
4. 回到 Official Account Manager 的**設定 → 回應設定**：打開 **Webhook**，關掉**自動回應訊息**（不然每則回覆旁邊都會多一則
   LINE 的制式回答）。**加入好友的歡迎訊息**也可以關掉，機器人自己會打招呼。

### 2. 放金鑰

兩個都放進 `~/.reelmimic/secrets.json`。這個檔在 repo 外面，不會被 commit：

```json
{
  "LINE_CHANNEL_SECRET": "…",
  "LINE_CHANNEL_ACCESS_TOKEN": "…"
}
```

### 3. 啟動 ReelMimic

照平常啟動。兩個金鑰都設好的話，終端機會多兩行（還沒有綁定任何帳號時才會印配對碼）：

```
LINE bot → webhook on http://127.0.0.1:4319/line/webhook (put only this port behind your HTTPS tunnel) · 0 linked accounts
LINE bot: to link a LINE account, send the bot within 10 minutes: 綁定 482913  (or: pair 482913)
```

### 4. 讓 webhook 有公開網址

LINE 要能用 HTTPS 連到你的電腦。用通道指向**只有 4319 這個埠**（LINE 用的埠，不是網站的 4318），例如：

```bash
cloudflared tunnel --url http://127.0.0.1:4319     # 會印出 https://<隨機>.trycloudflare.com
# 或
ngrok http 4319                                     # 會印出 https://<隨機>.ngrok-free.app
```

到 Developers 控制台的 **Messaging API → Webhook settings**，把 webhook URL 設成
`https://<你的通道網址>/line/webhook`，打開 **Use webhook**，按 **Verify**，應該會顯示 *Success*。

臨時通道每次啟動網址都會變。要長期用的話，設一個有名稱的 Cloudflare 通道或 ngrok 固定網域，webhook URL 才不用一直改。

### 5. 綁定你的 LINE 帳號

加機器人為好友（QR code 在 Developers 控制台的 **Messaging API** 頁），把終端機上那行傳給它，例如 `綁定 482913`。
配對碼只能用一次，10 分鐘內有效。

要新的配對碼（過期了，或要再綁另一個帳號，例如另一半的手機），在 ReelMimic 執行中時到 `app/` 執行：

```bash
npm run line-code
```

## 安全

- **只有 webhook 上網。** 網站沒有登入，又能啟動會在你電腦上執行指令的 AI agent，所以 4318 絕對不能讓網路連到。
  因此機器人用自己的埠，那個埠只提供 `POST /line/webhook`，其他路徑一律 404。
- **每個請求都要簽章。** 機器人用你的 channel secret 檢查每個請求的簽章，不對的一律 401。
- **陌生人什麼都看不到。** 任何人都能加 LINE 機器人好友，所以沒綁定的帳號它一律不回答，只會收到綁定說明。
- **只有你能產生配對碼。** 你在電腦上要了才會有配對碼（第一次啟動，或 `npm run line-code`，它會跟本機的伺服器要）。
  6 位數、只能用一次、10 分鐘內有效，錯 5 次就作廢。從 LINE 沒辦法要配對碼，所以陌生人每組最多只能猜 5 次。
- **只在一對一聊天回應。** 在群組裡，專案內容會被群組所有人看到，所以群組訊息一律不理。
- **綁定的帳號**存在 `~/.reelmimic/line.json`。從手機傳 `解除綁定` 可以移除一個；要全部移除，先關掉伺服器再刪這個檔（執行中的伺服器記憶體裡還有一份）。

## 訊息額度

回覆你的指令不用錢。通知是*推播訊息*，會算進官方帳號方案的每月訊息額度：一則通知傳給一個綁定帳號算一則。
免費方案每月大約幾百則，片做得多的話看一下你的方案。只想自己問的話，傳 `通知 關`。

## 設定值

除了前兩個，其他都可以不設。放在 `~/.reelmimic/secrets.json` 或環境變數。

| 鍵 | 用來做什麼 |
|---|---|
| `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` | 打開機器人（兩個都要） |
| `LINE_PORT` | webhook 的埠號（預設 4319） |
| `LINE_ALLOWED_USERS` | 不用配對碼就能用的 LINE user ID（`U…`，逗號分隔） |
| `LINE_STATE` | 綁定帳號存在哪裡（預設 `~/.reelmimic/line.json`） |
| `REELMIMIC_URL` | 手機能打開網站的網址，每則訊息會附上專案連結。只有在你已經用私人方式讓網站連得到（例如 [Tailscale](https://tailscale.com)）時才設，絕對不要公開 |

## 運作方式

```
LINE ──HTTPS──▶ 你的通道 ──▶ 127.0.0.1:4319  POST /line/webhook
                                │ 檢查簽章 → 綁定了嗎？→ 指令
                                ▼
                       server/line/  ──讀──▶ job.json 和合約檔（跟網站看到的是同一份快照）
                                ▲
             專案階段改變 ───────┘（job 狀態機的事件匯流排）→ 推播給綁定的帳號
```

| 檔案 | 做什麼 |
|---|---|
| `app/server/line/index.ts` | webhook 伺服器、事件處理、通知、`startLine()`（由 `server/index.ts` 呼叫） |
| `app/server/line/commands.ts` | 指令：一個指令一筆，加上解析器 |
| `app/server/line/progress.ts` | 列表和進度回報的文字 |
| `app/server/line/store.ts` | 綁定的帳號和配對碼 |
| `app/server/line/client.ts` | LINE API：檢查簽章、回覆、推播 |
| `app/scripts/line-code.mjs` | `npm run line-code`：跟執行中的伺服器要一組新的配對碼（`POST /api/line/code`，只限本機） |

機器人要等伺服器拿到自己的埠、也標記好被中斷的專案之後才啟動。所以重開伺服器不會把那些專案當成錯誤通知，
第二份伺服器也不會再開第二個機器人。

## 新增指令

在 `app/server/line/commands.ts` 的 `COMMANDS` 加一筆：別名、說明文字、`run`（回傳要傳回去的訊息）。
會動到專案的指令，要呼叫跟 HTTP API 一樣的函式、做一樣的檢查。例如核准企劃：

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

原則：

- **跟網站用一樣的規則。** 看 `app/server/index.ts` 對應的路由，做一樣的檢查（`J.busy`、必要素材），不要自己改 `job.json`。
- **不能復原的要先確認。** 像取消，先回一個快速回覆按鈕，讓它送出確認指令（例如 `取消 3 確定`），不要第一則訊息就執行。
  點快速回覆按鈕和 postback 收到的都是一般的指令文字。
- **文字都當成不可信。** 它來自手機，只拿來比對專案代號或標題，絕對不要丟進 shell 或檔案路徑。
- **加測試**到 `app/server/line/line.test.ts`。那裡的 LINE API 是假的，可以精確檢查機器人會傳什麼。

直接傳成片需要把影片放在公開的 HTTPS 網址（LINE 的影片訊息規定），等於要公開專案檔案，所以留到之後再做。
