# ReelMimic — 參考影片風格克隆工作區

使用者給一支參考影片（檔案 / 螢幕錄影 / YouTube 連結）＋一句需求 → 產出同風格的新影片。

## 入口
- **一律先載入 `/video-clone`**（`.claude/skills/video-clone/SKILL.md`），照它的流程走：拆解 → 選風格 → 交給製作 skill → 分鏡 → 製作 → 逐格審查 → 輸出 → 依回饋修改。
- 風格對應表在 `.claude/skills/video-clone/styles/`，一種風格一個檔；新增風格就加一個檔（範本 `_TEMPLATE.md`）。

<!-- harness:shared — 這段是唯一來源，AGENTS.md 有同一份。改完跑 `node .claude/harness/sync-rules.mts --write`；CI 會檢查兩份一致，以及每條規則由誰執行（docs/HARNESS.md） -->
## 規則
- `2d-only` 媒材：目前只做 2D（3D 賽道暫停，blender-product-film 保留但不選用）。3D 參考片用 2D 重現並明講；不生成真人實拍影像或真實人物。
- `assets` 角色：使用者自己擁有的角色（提供設計圖）可直接用；或是我們根據此使用者所述自行去抓取的腳色可以直接使用；素材可以自己上網找（記來源與授權，不明的要標示）；歌詞只用使用者提供的文字或 LRC；參考片只學手法不抄素材；使用者自己的產品照片可以用來重建產品。
- `compare-gate` 企劃逐鏡對照參考片（ref_shot + camera），完成後用 compare.py 並排比較、每鏡評分 ≥ 4 才交件。
- `look-after-render` 每次渲染後抽影格用 Read 看，有問題修完再出片。
- `secrets` API 金鑰只放 `~/.reelmimic/secrets.json`，由使用者自己填；不要寫入它，也不要把內容印出來（要確認有沒有設定就用 `test -f`）。
- `projects-private` `projects/` 是使用者的參考片、素材與成片，不進版本控制（不要 `git add -f`）。
- `one-server` 不要在真的 `projects/` 上再開第二個 server（啟動時會把跑到一半的工作標成 interrupted）；要套用 server 修改就跑 `bash app/restart.sh`，測試把 `REELMIMIC_PROJECTS` 指到別的資料夾。

## 工具
- 需要的程式與安裝方式見 README（`npm run doctor` 會逐項檢查）：Node 22.18+、Python 3.10+（requirements.txt）、FFmpeg、Chrome、Claude Code 或 Codex CLI。
- 找不到 FFmpeg 時看環境變數 `FFMPEG_DIR`；Chrome 看 `CHROME_PATH`；Blender 看 `BLENDER`；API 金鑰在 `~/.reelmimic/secrets.json`（伺服器啟動時載入）。
- yt-dlp：`python -m yt_dlp`；截圖一律用 `.claude/skills/video-clone/scripts/hf_frames.py`（HyperFrames 專案）或引擎自己的 render 指令。
- 背景渲染完的片：`node .claude/harness/look.mts <影片>` 產生縮圖總覽並掃黑畫面／定格。

## 資料夾
- `app/` — ReelMimic 網站（server + React 前端）
- `projects/<代號>/` — 每支影片一個專案（`analysis/`、`plan.json`、`build/`、`out/video.mp4`）；不進版本控制
- `.claude/skills/` — skills：`video-clone` 是核心（流程、合約、風格表、工具），其他是製作引擎
- `.claude/harness/` — Claude Code hooks 與規則檢查（說明見 `docs/HARNESS.md`）
- `docs/` — 架構與擴充說明
<!-- /harness:shared -->
