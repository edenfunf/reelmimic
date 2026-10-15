<p align="right"><a href="../ARCHITECTURE.md">English</a> · <b>繁體中文</b> · <a href="../zh-CN/ARCHITECTURE.md">简体中文</a></p>

# 架構

ReelMimic 由三層組成：**網站**（React）、**伺服器**（Node，負責流程與派工）、**agent 工作區**（repo 根目錄，Claude Code 或 Codex 在這裡讀 skill、寫檔、渲染）。
三層之間只透過**檔案**溝通：agent 照 `CONTRACT.md` 寫檔，伺服器用「該寫的檔案有沒有更新」判斷每一步是否完成，網站直接讀這些檔案畫畫面。
所以換 agent、加引擎、改前端都不需要動到其他層。

```
瀏覽器（app/web，React + Vite）
   │  REST + Server-Sent Events
   ▼
伺服器（app/server）
   ├─ index.ts          HTTP API、上傳、SSE、提供專案檔案（/files/:id/*）
   ├─ env.ts            啟動時載入 ~/.reelmimic/secrets.json
   ├─ jobs.ts           使用者的操作（開始、核准、留言、重試…）、專案列表與快照
   ├─ preprod.ts        分析 → 風格 → 企劃（角色與素材平行打草稿）
   ├─ production.ts     製作準備 → 角色關 → 分段製作（多個 builder 平行、每鏡做完就審）→ 組裝
   ├─ prerender.ts      通過審查的段落在背景先渲染（有影格快取的引擎），取消時一起停
   ├─ cast.ts           角色關：每個角色平行審查修正、並排檢查、序列版
   ├─ final.ts          最後評審 ⇄ 修改
   ├─ review.ts         每一關共用的「審查 → 修正」迴圈（輪數上限、needs_user、通過規則）
   ├─ turn.ts           一次 agent 回合：全域名額（審查與修正插隊）、必須檔案檢查、失敗原因
   ├─ contract.ts       agent 寫的 JSON 檔格式檢查（企劃、製作規劃、審查、修正、評審）
   ├─ runner.ts         每個專案同時只跑一條流程；取消會停掉它開的所有 agent 與工具程序（整棵程序樹）
   ├─ store.ts          job.json、事件紀錄、即時更新、輪數設定
   ├─ inputs.ts         需要使用者提供的素材、歌詞對時
   ├─ prompts.ts        每個步驟給 agent 的指令（改檔後下一輪就生效，不用重啟）
   ├─ agents/index.ts   agent 轉接層：Claude Code / Codex → 統一事件
   └─ line/             可選的 LINE 機器人（用自己的埠）：查進度、通知（docs/zh-TW/LINE.md）
   │  spawn（stdin 給指令，stdout 串流事件）
   ▼
agent 工作區（repo 根目錄）
   ├─ .claude/skills/video-clone/   核心 skill（流程、合約、風格表、工具）
   ├─ .claude/skills/<engine>/      製作引擎 skill
   └─ projects/<id>/                這支影片的所有檔案
```

## 1. 流程（一支影片的一生）

```
new → analyzing → styling → planning → plan_review ⇄ replanning
                                             │ 核准（required_inputs 都已提供或略過）
                                             ▼
                                         producing ──→ needs_input（只有使用者能給的東西 / 審查多輪未過）
                                             │
                                             ▼
                              critiquing ⇄ revising → done ⇄（使用者回饋）revising
```

| 階段 | 誰做 | 必須寫出的檔案 |
|---|---|---|
| analyzing | `scripts/analyze.py`（不是 agent） | `analysis/report.json`、`sheet_1fps.jpg`、`sheet_scenes.jpg` |
| styling | 導演 agent | `analysis/STYLE.md`、`analysis/route.json`（風格 → 製作引擎） |
| planning | 導演寫企劃核心 → 每個角色一個 agent、素材一個 agent 同時做 → 導演整合並畫定調畫面 | `plan.json`、`STORYBOARD.md`（逐鏡對照參考片、素材與授權、定調畫面、required_inputs）、角色定義檔草稿 |
| replanning | 導演 agent | `plan.json`（依使用者意見修改） |
| producing | 生產線（見下節） | `build/production.json` … `out/video.mp4` |
| critiquing | 獨立評審（全新對話） | `out/check/critique.json` |
| revising | 導演 agent | `out/video.mp4`、`out/check/fixes.json`（每項附修改前後截圖） |

**完成的判準是檔案**：`turn()` 記下必須檔案的修改時間，agent 回合結束後檢查它們有沒有被更新；沒有就停在 `error`，可以「重試這一步」。更新過的 JSON 檔再照合約檢查（`contract.ts`，只查伺服器會用到的欄位）：格式不對就請同一個 agent 對話重寫一次，還是不對這一步就停在 `error`，並列出哪些欄位有問題。
伺服器重啟時，還標在工作中的專案會被標成「已中斷」（`recoverOrphans`），重試會從目前的檔案接著做。

## 2. 生產線（核准之後）

```
setup（導演）：共用素材、每個角色一個定義檔、角色設定圖、分段（build/production.json）
   │
   ├──────────────── 角色關（與做鏡頭同時進行）────────────────┐
   │  每個角色：審查員（全新對話）⇄ 修正 agent，最多 3 輪          │
   │  要改共用骨架的項目 → 導演統一改 → 相關角色重審               │
   │  全部通過 → 並排檢查（比例、互動）                          │
   │                                                          │
   ├── 分段製作：最多 BUILDERS 個製作 agent 平行，每段 1–4 鏡      │
   │     每做完一鏡就寫 <shot>.done.json → 立刻派一個鏡頭審查員（全新對話）│
   │     審查等角色關通過才開始 ←──────────────────────────────┘
   │     → 沒過的鏡頭交回同一個製作 agent 修正 → 只重審沒過的鏡頭，最多 3 輪
   │     → 需要改共用檔：導演當場改（一次一個，只做加法），製作 agent 同一輪套用
   ▼
assemble（導演）：組裝、混音、全片輸出
   ▼
最後評審（全新對話）：只看跨段的接縫、連戲、節奏、字幕一致；先核對之前每一個「已修正」 ⇄ 導演修改（最多 2 輪）
```

設計重點：
- **缺陷在哪產生就在哪攔**：角色在做鏡頭前審、每段做完立刻審，不堆到最後。
- **審查員永遠是全新對話**：沒有參與製作，不會替自己的作品辯護；製作 agent 則保留自己的對話，修正時記得細節。
- **兩級問題**：`blocker`（正常觀看就看得出來）才會退回；`polish`（要放大才看得到）記下來交給後面順手處理。
- **修正要有證據**：每個「已修正」都附同一秒、同一位置的前後截圖，下一輪審查先核對。
- **needs_user**：歌詞、自家角色設計圖這類只有使用者能給的東西不算缺陷，系統暫停請使用者提供或略過，不會一直重修。
- **排程**：全域 agent 名額（`MAX_AGENTS`）；審查與修正優先於新的製作，缺陷趁製作 agent 還記得細節時修掉。
- **引擎快照**：核准時把製作引擎 skill 複製到 `build/engine/<engine>/`，之後改 skill 不會影響進行中的專案。

## 3. 檔案合約

完整格式在 `.claude/skills/video-clone/CONTRACT.md`，重點：

```
projects/<id>/
  job.json               伺服器管理：階段、session id、對話、生產線狀態
  logs/events.jsonl      完整事件紀錄（不截斷；介面顯示最近 600 筆）
  brief.md / inputs/     使用者的需求原文與上傳的素材
  analysis/              report.json、STYLE.md、route.json、lyrics/subs.lrc|json
  plan.json              前製企劃（網站的主要畫面）
  build/                 引擎專案：production.json、角色定義、每鏡一個檔、engine 快照
  out/check/             cast/（設定圖、審查、修正）、shots/（每段 done/review/fixes/shared、每鏡截圖）、critique.json、fixes.json
  out/video.mp4          成片
```

## 4. Agent 轉接層

`agents/index.ts` 把兩種 CLI 統一成同一組事件：`session`、`text`、`thinking`、`tool`、`error`、`done`。

| | Claude Code | Codex |
|---|---|---|
| 指令 | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools …` | `codex exec --json -c sandbox_mode=danger-full-access -c approval_policy=never (CODEX_SANDBOX) …` |
| 接續對話 | `--resume <session>` | `exec resume <thread>` |
| 指令傳遞 | stdin | stdin |

伺服器記下每個角色的 session：導演一條（整支片共用，討論有上下文）、每個製作 agent 各一條（跨修正輪保留）、審查員每次都是新的。

## 5. 網站

- `App.tsx`：首頁（輸入卡片、專案列表）、路由、語言選單。
- `Project.tsx`：專案頁，分頁為成品／生產線／企劃／參考片拆解；暫停卡、錯誤卡、必要素材與歌詞對時、影片時間點留言。
- `Chat.tsx`：對話與「思考」：把 `job.chat` 與事件紀錄合併，工作中的 agent 顯示成即時卡片（白話步驟、計時、看過的影格縮圖），完成的回覆收成「思考了 N 秒 · M 個步驟」；另有原始紀錄分頁。
- `i18n.ts`：介面語言（繁體中文為原文、English 對照表、简体中文由 OpenCC 轉換）。
- 即時更新：`GET /api/projects/:id/events`（SSE）。

## 6. HTTP API

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/api/health` | 伺服器開始接受連線後回 `{ ok: true }`（`start.bat`／`start.sh` 等到它回應才開瀏覽器） |
| GET | `/api/agents` | 偵測已安裝的 agent CLI |
| GET/POST | `/api/projects` | 列表／建立（multipart：reference 或 url、brief、agent、lang、inputs） |
| GET | `/api/projects/:id` | 專案快照（網站需要的所有資料） |
| POST | `/api/projects/:id/message` | 對導演說話（企劃討論、成片修改、暫停時的指示；附件放 `meta.attachments`） |
| POST | `/api/projects/:id/approve` | 核准企劃（有未提供的必要素材會回 409） |
| POST | `/api/projects/:id/lyrics` | 貼歌詞文字 → 自動對時 |
| POST | `/api/projects/:id/inputs` · `/waive` | 補上傳素材（`?to=attachments` 為對話附件）· 略過某項必要素材 |
| POST | `/api/projects/:id/resume` · `/accept` · `/retry` · `/cancel` | 暫停後繼續 · 接受目前結果 · 重試失敗步驟 · 停止 |
| GET | `/api/projects/:id/events` | SSE 事件流 |
| GET | `/files/:id/*` | 專案內的檔案（影片、截圖） |
| POST | `/api/line/code` | 一組新的 LINE 配對碼，終端機也會印（`npm run line-code`；LINE 機器人沒開時 404） |

可選的 LINE 機器人用自己的埠（`LINE_PORT`，預設 4319），只提供有 LINE 簽章的 `POST /line/webhook`。要放到 HTTPS 通道後面的是這個埠，上面的 API 留在本機。見 [LINE.md](LINE.md)。

## 7. 工具（`.claude/skills/video-clone/scripts/`）

| 工具 | 用途 |
|---|---|
| `analyze.py` | 下載（yt-dlp）與量測參考片：鏡頭、節奏、BPM、配色、每秒一格總覽 |
| `compare.py` | 成片與參考片逐鏡並排比較 |
| `hf_frames.py` | HyperFrames 專案截圖：一次呼叫多個時間點、PIL 裁切、依內容快取、全機並行上限 |
| `fetch_assets.py` | 授權安全素材搜尋與下載（Openverse、Pixabay、Freesound），自動寫 ASSETS.md |
| `align_lyrics.py` | 使用者提供的歌詞文字 × 音檔 → 每句時間（faster-whisper 只當量尺） |
| `yating_tts.py` | 雅婷台灣華語語音 |
| `timeline.py` | 分析一支片的生產時間：每個階段、每個 agent、時間花在哪 |
