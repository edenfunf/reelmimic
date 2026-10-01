<p align="right"><a href="../ARCHITECTURE.md">English</a> · <a href="../zh-TW/ARCHITECTURE.md">繁體中文</a> · <b>简体中文</b></p>

# 架构

ReelMimic 由三层组成：**网站**（React）、**服务器**（Node，负责流程与派工）、**agent 工作区**（repo 根目录，Claude Code 或 Codex 在这里读 skill、写档、渲染）。
三层之间只通过**文件**沟通：agent 照 `CONTRACT.md` 写档，服务器用「该写的文件有没有更新」判断每一步是否完成，网站直接读这些文件画画面。
所以换 agent、加引擎、改前端都不需要动到其他层。

```
浏览器（app/web，React + Vite）
   │  REST + Server-Sent Events
   ▼
服务器（app/server）
   ├─ index.ts          HTTP API、上传、SSE、提供项目文件（/files/:id/*）
   ├─ env.ts            启动时加载 ~/.reelmimic/secrets.json
   ├─ jobs.ts           流程状态机 + 生产线调度（谁先谁后、平行几个、何时暂停）
   ├─ prompts.ts        每个步骤给 agent 的指令（改档后下一轮就生效，不用重启）
   ├─ notify.ts         视频需要你处理或完成时，发 Discord／webhook 消息
   └─ agents/index.ts   agent 转接层：Claude Code / Codex → 统一事件
   │  spawn（stdin 给指令，stdout 串流事件）
   ▼
agent 工作区（repo 根目录）
   ├─ .claude/skills/video-clone/   内核 skill（流程、合约、风格表、工具）
   ├─ .claude/skills/<engine>/      制作引擎 skill
   └─ projects/<id>/                这支视频的所有文件
```

## 1. 流程（一支视频的一生）

```
new → analyzing → styling → planning → plan_review ⇄ replanning
                                             │ 核准（required_inputs 都已提供或略过）
                                             ▼
                                         producing ──→ needs_input（只有用户能给的东西 / 审查多轮未过）
                                             │
                                             ▼
                              critiquing ⇄ revising → done ⇄（用户回馈）revising
```

| 阶段 | 谁做 | 必须写出的文件 |
|---|---|---|
| analyzing | `scripts/analyze.py`（不是 agent） | `analysis/report.json`、`sheet_1fps.jpg`、`sheet_scenes.jpg` |
| styling | 导演 agent | `analysis/STYLE.md`、`analysis/route.json`（风格 → 制作引擎） |
| planning | 导演写企划内核 → 每个角色一个 agent、素材一个 agent 同时做 → 导演集成并画定调画面 | `plan.json`、`STORYBOARD.md`（逐镜对照参考片、素材与授权、定调画面、required_inputs）、角色定义档草稿 |
| replanning | 导演 agent | `plan.json`（依用户意见修改） |
| producing | 生产线（见下节） | `build/production.json` … `out/video.mp4` |
| critiquing | 独立评审（全新对话） | `out/check/critique.json` |
| revising | 导演 agent | `out/video.mp4`、`out/check/fixes.json`（每项附修改前后截屏） |

**完成的判准是文件**：`turn()` 记下必须文件的修改时间，agent 回合结束后检查它们有没有被更新；没有就停在 `error`，可以「重试这一步」。
服务器重启时，还标在工作中的项目会被标成「已中断」（`recoverOrphans`），重试会从目前的文件接着做。

## 2. 生产线（核准之后）

```
setup（导演）：共用素材、每个角色一个定义档、角色设置图、分段（build/production.json）
   │
   ├──────────────── 角色关（与做镜头同时进行）────────────────┐
   │  每个角色：审查员（全新对话）⇄ 修正 agent，最多 3 轮          │
   │  要改共用骨架的项目 → 导演统一改 → 相关角色重审               │
   │  全部通过 → 并排检查（比例、交互）                          │
   │                                                          │
   ├── 分段制作：最多 BUILDERS 个制作 agent 平行，每段 1–4 镜      │
   │     每做完一镜就写 <shot>.done.json → 立刻派一个镜头审查员（全新对话）│
   │     审查等角色关通过才开始 ←──────────────────────────────┘
   │     → 没过的镜头交回同一个制作 agent 修正 → 只重审没过的镜头，最多 3 轮
   │     → 需要改共用档：导演当场改（一次一个，只做加法），制作 agent 同一轮套用
   ▼
assemble（导演）：组装、混音、全片输出
   ▼
最后评审（全新对话）：只看跨段的接缝、连戏、节奏、字幕一致；先核对之前每一个「已修正」 ⇄ 导演修改（最多 2 轮）
```

设计重点：
- **缺陷在哪产生就在哪拦**：角色在做镜头前审、每段做完立刻审，不堆到最后。
- **审查员永远是全新对话**：没有参与制作，不会替自己的作品辩护；制作 agent 则保留自己的对话，修正时记得细节。
- **两级问题**：`blocker`（正常观看就看得出来）才会退回；`polish`（要放大才看得到）记下来交给后面顺手处理。
- **修正要有证据**：每个「已修正」都附同一秒、同一位置的前后截屏，下一轮审查先核对。
- **needs_user**：歌词、自家角色设计图这类只有用户能给的东西不算缺陷，系统暂停请用户提供或略过，不会一直重修。
- **调度**：全域 agent 名额（`MAX_AGENTS`）；审查与修正优先于新的制作，缺陷趁制作 agent 还记得细节时修掉。
- **引擎快照**：核准时把制作引擎 skill 拷贝到 `build/engine/<engine>/`，之后改 skill 不会影响进行中的项目。

## 3. 文件合约

完整格式在 `.claude/skills/video-clone/CONTRACT.md`，重点：

```
projects/<id>/
  job.json               服务器管理：阶段、session id、对话、事件纪录（最近 600 笔）、生产线状态
  logs/events.jsonl      完整事件纪录（不截断）
  brief.md / inputs/     用户的需求原文与上传的素材
  analysis/              report.json、STYLE.md、route.json、lyrics/subs.lrc|json
  plan.json              前制企划（网站的主要画面）
  build/                 引擎项目：production.json、角色定义、每镜一个档、engine 快照
  out/check/             cast/（设置图、审查、修正）、shots/（每段 done/review/fixes/shared、每镜截屏）、critique.json、fixes.json
  out/video.mp4          成片
```

## 4. Agent 转接层

`agents/index.ts` 把两种 CLI 统一成同一组事件：`session`、`text`、`thinking`、`tool`、`error`、`done`。

| | Claude Code | Codex |
|---|---|---|
| 指令 | `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools …` | `codex exec --json -c sandbox_mode=danger-full-access -c approval_policy=never (CODEX_SANDBOX) …` |
| 接续对话 | `--resume <session>` | `exec resume <thread>` |
| 指令传递 | stdin | stdin |

服务器记下每个角色的 session：导演一条（整支片共用，讨论有上下文）、每个制作 agent 各一条（跨修正轮保留）、审查员每次都是新的。

## 5. 网站

- `App.tsx`：首页（输入卡片、项目列表）、路由、语言菜单。
- `Project.tsx`：项目页，分页为成品／生产线／企划／参考片拆解；暂停卡、错误卡、必要素材与歌词对时、视频时间点留言。
- `Chat.tsx`：对话与「思考」：把 `job.chat` 与事件纪录合并，工作中的 agent 显示成即时卡片（白话步骤、计时、看过的影格缩略图），完成的回复收成「思考了 N 秒 · M 个步骤」；另有原始纪录分页。
- `i18n.ts`：界面语言（繁體中文为原文、English 对照表、简体中文由 OpenCC 转换）。
- 即时更新：`GET /api/projects/:id/events`（SSE）。

## 6. HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/agents` | 侦测已安装的 agent CLI |
| GET/POST | `/api/projects` | 列表／创建（multipart：reference 或 url、brief、agent、lang、inputs） |
| GET | `/api/projects/:id` | 项目快照（网站需要的所有数据） |
| POST | `/api/projects/:id/message` | 对导演说话（企划讨论、成片修改、暂停时的指示；附件放 `meta.attachments`） |
| POST | `/api/projects/:id/approve` | 核准企划（有未提供的必要素材会回 409） |
| POST | `/api/projects/:id/lyrics` | 贴歌词文本 → 自动对时 |
| POST | `/api/projects/:id/inputs` · `/waive` | 补上传素材（`?to=attachments` 为对话附件）· 略过某项必要素材 |
| POST | `/api/projects/:id/resume` · `/accept` · `/retry` · `/cancel` | 暂停后继续 · 接受目前结果 · 重试失败步骤 · 停止 |
| GET | `/api/projects/:id/events` | SSE 事件流 |
| GET | `/files/:id/*` | 项目内的文件（视频、截屏） |

## 7. 工具（`.claude/skills/video-clone/scripts/`）

| 工具 | 用途 |
|---|---|
| `analyze.py` | 下载（yt-dlp）与量测参考片：镜头、节奏、BPM、配色、每秒一格总览 |
| `compare.py` | 成片与参考片逐镜并排比较 |
| `hf_frames.py` | HyperFrames 项目截屏：一次调用多个时间点、PIL 裁切、依内容缓存、全机并行上限 |
| `fetch_assets.py` | 授权安全素材搜索与下载（Openverse、Pixabay、Freesound），自动写 ASSETS.md |
| `align_lyrics.py` | 用户提供的歌词文本 × 音档 → 每句时间（faster-whisper 只当量尺） |
| `yating_tts.py` | 雅婷台湾华语语音 |
| `timeline.py` | 分析一支片的生产时间：每个阶段、每个 agent、时间花在哪 |
