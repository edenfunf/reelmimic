# 專案檔案合約（CLI 與 App 共用）

每支影片一個資料夾 `projects/<id>/`。Agent（Claude Code 或 Codex）與 App 後端只透過這些檔案溝通，
所以兩種 agent 都能接，前端也只要讀檔案就能畫出畫面。**Agent 必須照這裡的路徑與欄位寫檔。**
伺服器在每個回合結束時會檢查這一步必須寫的 JSON 檔（企劃、production.json、審查、修正、評審）：格式不對會請你在同一個對話重寫一次，還是不對這一步就會停下。

```
projects/<id>/
  job.json                 App 管理（agent 不要改）：階段、agent 類型、session id、對話紀錄
  brief.md                 使用者的需求原文（App 寫入）
  inputs/                  使用者上傳的素材 / 音檔 / LRC（唯讀）
  analysis/
    report.json            analyze.py 產出（量測數據）
    sheet_1fps.jpg         每秒一格總覽
    sheet_scenes.jpg       每個鏡頭中間格
    STYLE.md               ← agent：風格拆解（給人看）
    peaks.json             ← agent：參考片的高潮（起雞皮疙瘩的 1–2 刻），peak_<n>.jpg 是它的連續影格
    route.json             ← agent：風格判定與選用的 skill
  plan.json                ← agent：前製企劃（前端的主要畫面）
  STORYBOARD.md            ← agent：同一份企劃的文字版
  assets/                  ← agent：抓到或做出的素材；ASSETS.md = 授權紀錄
  out/check/key_<n>_vs_ref.jpg ← agent：每個高潮的爆點那一格，成片品質，和參考片同一格並排（style_frames 最前面）
  out/check/style_*.jpg    ← agent：前製階段的「風格定調畫面」（2–4 張）
  out/check/*.jpg          製作中的審查影格
  out/video.mp4            ← 成品
```

## route.json

```json
{
  "medium": "3d-photoreal",
  "style": "premium-product-3d",
  "engine": "blender-product-film",
  "confidence": 0.8,
  "why": ["一句話理由", "..."],
  "alternatives": [{ "style": "music-kinetic", "why": "..." }],
  "new_style_proposed": false
}
```

## plan.json

```json
{
  "version": 1,
  "title": "片名",
  "logline": "一句話故事",
  "style": "painted-story-mv",
  "engine": "painted-animation",
  "format": { "width": 1920, "height": 1080, "fps": 24, "duration_s": 30 },
  "music": { "source": "user | library | none", "file": "inputs/song.mp3", "bpm": 136, "offset": 0,
             "section": { "start_s": 100.84, "end_s": 131.7 }, "license": "user-provided", "note": "" },
  "look": { "medium": "手繪水彩＋會抖的墨線", "palette": ["#2A2C52", "#FFD66B"], "typography": "", "texture": "紙紋",
            "color_arc": "冷暗房 → 刺眼晴天 → 暖金房間" },
  "borrowed_from_reference": ["一句歌詞一個鏡頭（8 拍）", "結尾呼應開場", "諧音梗視覺化"],
  "characters": [{ "id": "zhai", "name": "阿宅", "design": "灰紫麻糬、亂髮、大圓眼鏡、青綠連帽T", "arc": "怕陽光 → 走出門" }],
  "shots": [
    { "id": "S1", "start_beat": 0, "end_beat": 10, "start_s": 0, "end_s": 4.41,
      "summary": "暗房打電動，被陽光照到後拉上窗簾",
      "action": "…具體動作，依時間順序…",
      "camera_note": "中景，緩慢推近；結尾推向窗簾（給人看的一句話）",
      "transition_in": "從螢幕光圈打開", "transition_out": "推鏡到窗簾縫",
      "reads": ["0–1.5 拍：暗房與螢幕光", "3.5 拍：陽光打在臉上"],
      "ref_shot": 3, "ref_what": "參考 #3：黑場中慢速推近產品一角，光線由左掃到右",
      "camera": { "move": "dolly_in", "lens": 85, "from": { "fill": 0.6, "angle": -14 }, "to": { "fill": 0.85, "angle": -4 }, "dof": "medium", "pace": "slow" },
      "text_overlay": [{ "text": "標語", "at": [1.0, 3.5], "position": "左側留白" }],
      "assets": ["A1"], "sfx": [], "notes": "" }
  ],
  "assets": [
    { "id": "A1", "kind": "image | icon | texture | sfx | music | font | footage", "purpose": "牆上海報的底紋",
      "status": "user | to_fetch | fetched | drawn_in_code | to_generate",
      "query": "paper texture", "source": "openverse", "url": "", "file": "assets/a1.jpg",
      "license": "CC BY 4.0", "attribution": "作者 / 連結" }
  ],
  "peaks": [
    { "id": "P1", "ref_peak": "P1", "shots": ["S8", "S9"], "build_from_s": 21.5, "hold_s": [23.6, 24.0], "hit_s": 24.0, "hold_after_s": 1.5,
      "build": "張力怎麼往上堆", "hit": "爆發那一格（主體、大小、構圖、色彩、密度）", "after": "停住多久、怎麼收",
      "sound": "爆點前安靜 0.4 s → 撞擊落在 hit_s 的重拍", "techniques": ["白閃引信", "布幕揭開", "群眾填滿畫面"],
      "emotion": "觀眾在這一刻感受到什麼", "key_frame": "out/check/key_1.jpg", "key_frame_note": "自評：哪裡已經贏、哪裡還輸" }
  ],
  "style_frames": ["out/check/key_1_vs_ref.jpg", "out/check/style_1.jpg"],
  "open_questions": ["要不要加卡拉 OK 字幕？需要 LRC"],
  "changelog": ["v1：初版"]
}
```

規則：
- `shots` 的時間兩種都寫（拍與秒）；沒有音樂時 `start_beat/end_beat` 可省略。
- 每個鏡頭都要有 `ref_shot`、`ref_what`、`camera`（逐鏡對照參考片；camera 用 engine 能直接吃的規格）。
- `peaks` 裡的鏡頭在 shots 標 `"hero": true`；hero 鏡頭的 action 寫到格的層級（預備、爆發、停住）。

## analysis/peaks.json

```json
[ { "id": "P1", "from": 24.0, "hit": 26.0, "to": 29.0, "strip": "analysis/peak_1.jpg",
    "build": "…", "hold": "…", "hit_what": "…", "after": "…", "sound": "…",
    "techniques": ["…"], "why_it_works": "一句話" } ]
```
線索來自 report.json 的 `audio.peak_candidates` 與 `flashes`，但一定要看 clip_strip.py 的連續影格確認。
- `analysis/STYLE.md` 第一行寫媒材（2d-painted · 2d-vector · 3d-stylized · 3d-photoreal · live-action）。
- 審查結果寫 `out/check/review.md`（每鏡 6 項 1–5 分）與 `out/check/compare_*.jpg`（compare.py 產生）。
- 每次依使用者意見修改企劃：`version` +1、`changelog` 加一行說明改了什麼。
- `status: to_fetch` 的素材要在前製階段就抓好（變 `fetched` 並有 `file` 與 `license`），讓使用者核准前看得到。

## 生產線檔案（核准後）

```
build/production.json            導演：{ cast_sheet, characters, chunks: [{id, shots}], shot_files, how_to_preview, how_to_render, shared_readonly,
                                 prerender: { cwd, cmd 含 {start} {end} } ← 有影格快取的引擎才寫；每段通過審查後系統自動在背景渲染那段的正式影格 }
out/check/cast/sheet_<角色>.jpg   每個角色一張設定圖（正面/3/4/側面/表情/姿勢）；sheet.jpg = 全角色並排
build/assets/cast/<角色>.js      每個角色一個定義檔（多角色時各自由一組審查＋修正同時進行，不能共用一個檔）
out/check/cast/review_<角色>.json / fixes_<角色>.json  個別角色的審查與修正（要改共用骨架的項目 status: shared，由導演統一改）
out/check/cast/review.json       角色審查：{ pass, issues:[{character, what, issue, fix}], verified_fixes, needs_user }
out/check/cast/fixes.json        導演修角色：[{ issue, change, before, after, status }]
out/check/shots/<Cn>.done.json   製作 agent：{ shots:[{ id, sheet, crops, notes }] }
out/check/shots/<shot>_sheet.jpg 每鏡 stills/strip；<shot>_crop_*.png 角色全解析度裁切
out/check/shots/<Cn>.review.json 鏡頭審查：{ shots:[{ id, pass, issues:[{time, where, issue, fix}] }], verified_fixes, needs_user }
out/check/shots/<Cn>.fixes.json  製作 agent 修正：[{ shot, issue, change, before, after, status: fixed|cannot|shared }]
out/check/critique.json          最後評審：{ pass, peaks:[{id, ours, ref, strip, verdict: ours_better|equal|ref_better, why}], scores, score_notes,
                                 shots:[{id, score, why}], must_fix, needs_user, verified_fixes, nice_to_have, summary }
                                 任何高潮 ref_better 都不會通過（系統會自動補成必修）
out/check/motion/motion.json     motion_check.py：硬切點、長時間靜止、黑格、閃白、片尾硬切黑（每項附前後影格 strip）
out/check/fixes.json             導演修成片：[{ issue, shot, time, change, before, after, status }]
analysis/lyrics/subs.lrc|.json   使用者貼的歌詞，自動對時結果（每句時間與匹配度）
```

- `needs_user`：只有使用者能提供的東西（歌詞、自家角色設計圖、Logo…）。這類**不算缺陷、不觸發修改**，系統會暫停並請使用者提供或略過。
- 每一個「已修正」都要有 before/after 全解析度裁切；下一輪審查先核對這些，說修好但沒修好會原樣退回。
- plan.json 新增 `required_inputs: [{ id, kind, label, why }]`：企劃核准前必須提供或略過。

## Cast classification and production consistency

`plan.characters` is the cast, not a list of everything that moves. Abstract shapes, circles, particles, typography,
icons, diagrams and other motion-graphics objects belong in `plan.assets` (usually `status: "drawn_in_code"`).
An object is a character when it has a persistent identity and character performance, such as expressions, poses or
acting; an anthropomorphized shape can therefore be a legitimate character. Recurrence, animation or a "hero" name
alone is not enough.

`plan.characters` and `build/production.json.characters` must contain exactly the same unique IDs. Characterless
projects use `characters: []` in both files and do not require cast sheets. A nonempty cast requires
`out/check/cast/sheet.jpg` and each production character's `file` and existing `sheet` path.

When recovering an older inconsistent project, reconcile the metadata instead of repeating completed setup. Move
misclassified entries into assets with their original IDs, files and metadata, preserving existing asset fields,
shot references, animations and rendered work. Restore missing production entries and sheets for actual characters;
never drop a legitimate character to bypass review. Retrying validates existing setup before continuing its saved
shot progress.

## assets/ASSETS.md

每一個外部素材一行：`檔名 | 來源網站 | 原始網址 | 授權 | 作者/署名`。由 `scripts/fetch_assets.py get` 自動追加。
