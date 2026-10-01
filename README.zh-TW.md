<div align="center">

<img src="docs/assets/logo.svg" width="76" alt="ReelMimic">

# ReelMimic

**丟一支你喜歡的影片，做一支一樣風格的新影片。**

[![License: MIT](https://img.shields.io/badge/license-MIT-7A6BFF)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-E86BD2)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-supported-FF9D5C)](https://github.com/openai/codex)
![Node 22.18+](https://img.shields.io/badge/node-22.18%2B-5B57F0)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-5B57F0)

[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md)

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/assets/demo-sugar.gif" alt="Sugar Rush"></td>
    <td align="center" width="33%"><img src="docs/assets/demo-sunshine-boy.gif" alt="陽光宅男"></td>
    <td align="center" width="33%"><img src="docs/assets/demo-cat-bath.gif" alt="橘寶洗澡記"></td>
  </tr>
  <tr>
    <td align="center"><b>Sugar Rush</b><br><sub>MV · 手繪水彩 · 58 秒</sub></td>
    <td align="center"><b>陽光宅男</b><br><sub>MV · 手繪水彩 · 63 秒</sub></td>
    <td align="center"><b>橘寶洗澡記</b><br><sub>旁白漫畫 · 30 秒</sub></td>
  </tr>
</table>

<sub>都是用 ReelMimic 做的：各給一支參考影片加一句需求。預覽沒有聲音，也裁掉了歌詞字幕。</sub>

</div>

## 這是什麼

看到一支很喜歡的影片，想做一支同樣風格、但內容完全是自己的？

把影片丟進 ReelMimic 就好。檔案、手機錄影或 YouTube 連結都可以，再告訴它你想做什麼。

它會先把參考片拆開來看，像是剪輯節奏、鏡頭長度、轉場、構圖、配色和運鏡，再整理成一份企劃給你確認。你可以直接在旁邊聊天、改設定、補素材，覺得可以了再開始做。

真正開始製作後，工作會拆給多個 AI 分工。不同段落可以同時進行，每一鏡做完也會交給另一個 AI 檢查，有問題就退回去改，不是生成一次就直接交差。

ReelMimic 學的是參考片的做法，不是把原本的畫面、角色或素材搬過來。

整套流程都跑在你自己的電腦上，用你自己的 Claude Code 或 Codex。

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/home-zh-TW-dark.png">
  <img src="docs/assets/home-zh-TW-light.png" alt="ReelMimic 首頁" width="860">
</picture>
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/flow-zh-TW-dark.png">
  <img src="docs/assets/flow-zh-TW-light.png" alt="ReelMimic 流程" width="860">
</picture>
</p>

## 可以做到什麼

- **拆解參考片**：鏡頭數量、鏡頭長度、BPM、轉場、配色、構圖和運鏡都會整理出來。
- **先給你看企劃**：分鏡、角色、素材、定調畫面都在裡面。想改就在旁邊聊，改到滿意再按核准。
- **多個 AI 分工**：最多 6 個同時做不同段落。每做完一鏡就換一個新的 AI 來審，不會自己審自己。
- **說修好要拿圖來看**：每個修正都附修改前後的截圖，審查的人對過才算數。
- **看得到它在幹嘛**：每個 AI 正在想什麼、跑了什麼、看了哪幾格，畫面上都有，也能打開完整 log。
- **直接在影片上留言**：成片出來後，拉到哪一秒就在那一秒打字，寫完一起送出。
- **加新風格不用寫程式**：一種風格就是一個 Markdown 檔。
- **三種語言**：繁中、英文、簡中，右上角切換。

## 先說清楚

- **目前只做 2D，有七種畫法：** 向量／動態圖像（以 [HyperFrames](https://github.com/heygen-com/hyperframes) 為基礎）、手繪水彩（以 [painted-animation](https://github.com/tuzhechen2005/painted-animation) 為基礎）、蠟筆繪本、像素風、剪紙定格、白板手繪、動漫賽璐璐。後面五種比較新，實際做片的次數比前兩種少。參考片對不到已知風格時，會用最接近的畫法做，並寫一份新風格的建議。
- **需要一點時間。** 30–60 秒的影片，企劃核准後通常要 1–3.5 小時，看長度和畫風。手繪水彩和蠟筆最慢，因為每一格都是用筆刷畫出來的。
- **用的是你的 AI 額度。** 所有工作都透過你的 Claude Code 或 Codex 帳號跑，會算進那個帳號的用量。額度用完時會暫停，之後可以從停下來的地方繼續。
- **主要在 Windows 上測過。** macOS 和 Linux 應該可以用，但測得比較少，有問題歡迎開 issue。
- **不做真人。** 它做的是動畫，不會生成真實人物的實拍畫面。

## 接下來

- 每種畫法更多內建角色與風格
- 在網站上一鍵把新發現的風格存起來，下次遇到同類參考片就直接對到
- 讓手繪水彩渲染更快

## 開始用

先裝好這些：Node.js 22.18 以上、Python 3.10 以上、FFmpeg、Chrome，還有 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex) 其中一個（要先登入）。

```bash
git clone https://github.com/edenfunf/reelmimic.git && cd reelmimic
./install.sh      # Windows 直接點兩下 install.bat
./start.sh        # Windows 直接點兩下 start.bat
```

打開 <http://localhost:4318> 就能用了。安裝腳本會順便檢查環境，少了什麼會跟你說；之後想再檢查一次，跑 `cd app && npm run doctor`。
Claude Code 會自己讀到 repo 裡的 skills，Codex 會讀 `AGENTS.md`，不用另外設定。

### 做第一支影片

1. 在首頁丟參考影片或貼連結，寫你想做什麼，選要用 Claude Code 還是 Codex。
2. 等它拆解完、寫好企劃。有意見就在右邊聊天框講，也可以貼截圖。
3. 企劃裡如果有要你給的東西（像歌詞），給它或跳過，然後按「核准並開始生成」。
4. 「生產線」分頁可以看到每個角色、每一段做到哪、審查截圖長怎樣。
5. 做好之後覺得哪裡不對，就直接在那一秒留言。

## 設定

金鑰跟一些路徑放在 `~/.reelmimic/secrets.json`。這個檔在 repo 外面，不會被 commit，格式可以照 [`secrets.example.json`](secrets.example.json)。

| 鍵 | 用來做什麼 |
|---|---|
| `YATING_KEY` | 雅婷的台灣華語語音，拿來配旁白 |
| `PIXABAY_KEY`、`FREESOUND_KEY` | 可以找到更多能合法使用的圖片、音樂、音效（沒有也行，會用 Openverse） |
| `FFMPEG_DIR`、`CHROME_PATH`、`CODEX_BIN`、`PYTHON` | 這些工具不在 PATH 上的話，在這裡指定位置 |
| `CODEX_SANDBOX` | Codex 的沙盒模式（預設 `danger-full-access`，和 Claude Code 允許 Bash 時一樣；`workspace-write` 會讓 Chrome 渲染跑不起來） |
| `BUILDERS`、`MAX_AGENTS` | 一支片同時幾個 AI 在做（預設 6）、所有專案加起來最多幾個（預設 12） |
| `PORT` | 網站用的埠號（預設 4318） |
| `DISCORD_WEBHOOK_URL`、`WEBHOOK_URL` | 企劃好了、需要你處理、影片完成（Discord 會附上影片）或出錯時傳訊息給你。`WEBHOOK_URL` 會收到 JSON：`{ event, id, title, stage, message, url }` |
| `REELMIMIC_URL` | 訊息裡連結的網址開頭（預設 `http://localhost:4318`） |

## 文件

- [架構](docs/zh-TW/ARCHITECTURE.md)：整個流程怎麼跑、檔案怎麼放、怎麼接 AI
- [擴充](docs/zh-TW/EXTENDING.md)：怎麼加風格、加製作引擎、接別的 AI
- [參與開發](docs/zh-TW/CONTRIBUTING.md)

## 使用原則

- 參考片只學手法，像節奏、構圖、轉場、笑點怎麼安排；畫面、角色、Logo、素材都不會拿來用。
- 角色預設是原創的。你有自己的角色設計圖，就照你的做。
- 網路上找來的素材會記下來源、作者跟授權，授權不清楚的會特別標出來。
- 歌詞只用你給的文字，不會自己去下載商業歌曲。
- 做出來的影片要怎麼用，請自己確認有沒有權利。

## 授權

程式碼用 [MIT](LICENSE) 授權。裡面附的第三方 skill 和素材照它們原本的授權，細節在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
