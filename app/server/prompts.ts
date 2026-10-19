// Phase prompts. Each agent turn does exactly one step and writes the files CONTRACT.md defines; the server advances only
// when those files exist. Same prompts for Claude Code and Codex (skills are referenced by path, no Skill tool needed).
import type { Lang } from '../shared/types.ts';
import type { BaseVars, Prompts } from './types.ts';

const SKILL = '.claude/skills/video-clone';

const RULES = `規則：使用者在 inputs/ 提供的自家角色可直接照著做；**使用者在需求或對話裡點名要用的角色（例如某個吉祥物、卡通人物）可以直接用**：
自己上網找它的造型（服裝、髮型、配件、配色）照著做，不要拒絕或換成「神似原創」；其他角色與畫面原創；不放他人品牌 Logo；
歌詞只能來自使用者提供的文字（inputs/lyrics.txt 或 .lrc；已對時的在 analysis/lyrics/subs.lrc），不要自己寫出、轉錄或引用歌詞；
外部素材可以自己上網找（圖片、音效、配樂、字型、參考資料）：先用 ${SKILL}/scripts/fetch_assets.py 的授權安全來源；不夠再用網路搜尋，
每一個都把來源網址、作者、授權寫進 assets/ASSETS.md，授權不明的標「授權未確認」並在回報裡告訴使用者。不下載商業歌曲、不抓他人品牌 Logo。
邊界：只改 repo 裡的檔案（不要改使用者的 shell 設定 ~/.bashrc、~/.bash_profile、環境變數或系統設定）；
只結束你自己開的程序（不要用 pkill/taskkill 加萬用字元比對去殺 Chrome、node 等，別的 agent 和專案也在用）。`;

// The reference as analysed: analyze.py crops a screen recording to proxy.mp4; source.mp4 is then the raw recording
// (a real run compared against black frames). clip_strip.py also switches source → proxy on its own.
const REF = 'analysis/proxy.mp4（沒有 proxy.mp4 才用 analysis/source.mp4；以 report.json 的 "analysed" 為準）';
// The user's own character drawing is the spec. A real run drew Clawd from the engine's built-in model instead, and no
// gate compared against the drawing: proportions drifted shot to shot, accessories sat on top of the head, arms vanished.
const DESIGN = `**使用者給的角色設計圖（inputs/ 裡的圖）就是規格**：輪廓比例（寬:高）、眼睛位置與大小、手腳的數量／位置／粗細、配色都照圖。
  不要拿引擎內建的同名角色或自己的印象去改；配件（帽子、耳機、墨鏡、髮型）要戴在對的部位（墨鏡在眼睛上、耳機在頭兩側），跟著身體一起轉，不能疊在頭頂蓋掉身體；
  倒過來、拉長、壓扁、特寫等特殊姿勢也一樣要認得出是同一隻。
  配件不能改變輪廓的判讀：大面積深色的頭帶、帽子會被看成頭髮或另一個部位，要細、要有高光或和身體對比明顯的顏色；特寫時再確認一次。`;
// The point of every video: a moment that gives goosebumps. Shared by the planner, builders, reviewers and the critic.
const WOW = `**這支片的目標是驚艷，讓人起雞皮疙瘩**，不是「沒有錯」。驚艷來自高潮設計，不是平均用力：
- 高潮 = 鋪陳（張力往上堆）→ 屏息（安靜、停住、收窄；長度和參考片的屏息接近（±30%），近乎空白的畫面不超過 1.2 秒）→ 爆發（落在重拍：構圖、色彩、動作、聲音同時翻轉）→ 停住（讓情緒落地 ≥ 1 秒，不要馬上切走）。
- 爆發那一下要「看得到」：主體大、清楚（爆點那一格和之後的停住段，主角至少佔畫面高 30%；要拉寬景秀規模就讓主角在前景或在畫面中心被放大，不要變成遠方的小點）、畫面密度和參考片的爆點一樣滿；閃白、光圈、轉場只能當引信，**不准用閃白或轉場蓋掉該被看到的那一刻**（擁抱、揭露、表情）。
- 力氣集中在 plan.peaks 的 hero 鏡頭：特製姿勢、誇張變形臉、衝擊格、smear、光芒/粒子、鏡頭震動、色彩翻轉、音效（蓄力、撞擊、爆點前的安靜）——參考片爆點用了什麼，我們至少一樣多。
- 判斷爆點一律用連續影格，不看單張：python ${SKILL}/scripts/clip_strip.py <我們的影片> --range a:b --vs ${REF} --vs-range c:d --out …（參考在上、我們在下，逐格對齊）。
- 驚艷也需要變化：同一個場景＋同一個機位不能超過全片的 40%；兩個高潮之間要換場景、換視角或換色彩世界；鋪陳段每 1–1.5 秒畫面要有新的東西（運鏡、構圖、新元素），不能一個構圖停 3 秒等爆點。`;

const ENGINE = (p: BaseVars) => `企劃核准後，製作引擎已凍結成快照 ${p.dir}/build/engine/<engine>/（SNAPSHOT.json）：製作一律用快照裡的 SKILL.md 與 scripts。
工具本體（.claude/skills/）是唯讀的；需要改引擎就複製到 build/ 裡改，並把「坑、修正、建議合回 skill」寫進 out/lessons.md。`;

// Measured on real runs: ~60% of agent time went to screenshots (one Chrome launch per crop, retries under load) and to
// "run it in the background, sleep 5 minutes, check". These rules remove that waste without skipping any check.
const SPEED = `效率規則（不能省略任何檢查，只是不浪費時間）：
- HyperFrames 專案截圖一律用 python ${SKILL}/scripts/hf_frames.py <build 資料夾> --at t1,t2,… [--crop x,y,w,h --tag 名稱] [--range 起:迄:間隔] --out <資料夾> [--sheet 檔名]：
  一次呼叫就把這一輪要看的所有時間點（所有鏡頭）一起算出來；裁切是從全解析度影格直接切，不要另外用 --zoom 重新渲染；畫面沒改的時間點會直接用快取。
- 需要等的指令（渲染、截圖）用 Bash 前景執行並把 timeout 設成 600000；**不要丟到背景再 sleep 猜時間**。
- **回合一結束，你開的所有程序都會被關掉**，背景任務完成時也不會有人通知你。所以可能超過 9 分鐘的渲染要切段，每段都前景跑完：
  可續跑的引擎（例如 render.mjs --frames）就重複執行同一個指令或用 --range 分段，直到影格數到齊，再 encode；
  絕不可以留著背景渲染就結束回合，必須寫的輸出檔（例如 out/video.mp4）在回合結束前一定要已經存在。
- 先把要看的時間點想好再一次截，不要一張一張截；改完一批問題再一次重截驗證。`;

const LANG_NAME: Record<Lang, string> = { 'zh-TW': '繁體中文', en: 'English', 'zh-CN': '简体中文' };

const HEADER = (p: BaseVars, role = '導演') => `你是「風格克隆影片工作室」的${role} agent，工作目錄是 repo 根目錄。
本專案資料夾：${p.dir}（以下路徑都相對於它，除非寫明 repo 根目錄）
先讀：${SKILL}/SKILL.md（流程與規則）與 ${SKILL}/CONTRACT.md（檔案格式，必須照寫）。
${process.env.PYTHON && process.env.PYTHON !== 'python' ? `這台電腦的 Python 指令是 \`${process.env.PYTHON}\`：下面（和 skill 文件）寫 python 的地方都用它執行。
` : ''}這一輪只做下面指定的步驟，做完就停，最後用 3–6 行${LANG_NAME[p.lang] || '繁體中文'}回報重點（不要貼整份檔案）。${p.lang && p.lang !== 'zh-TW' ? `
使用者的介面語言是 ${LANG_NAME[p.lang]}：回報與企劃裡給人看的文字（plan.json、STORYBOARD.md）都用${LANG_NAME[p.lang]}寫；影片裡的字幕與旁白語言照使用者的需求。` : ''}
${RULES}
${SPEED}`;

// The human-eye checklist every reviewer applies to FULL-RESOLUTION CROPS, not thumbnails.
const EYE = `用人眼逐處檢查（一定要看全解析度的放大截圖，縮圖看不出來）：
- 角色：每個身體部位都接在一起（頭—脖子—身體、肩—上臂—前臂—手、臀—腿—腳），沒有浮空的手、沒有硬黏在邊緣的手臂、沒有少脖子；
  關節處沒有接縫線或兩層描邊；比例、配色、髮型、服裝和角色設定圖一致；描線粗細全身一致；表情讀得懂；手拿的東西真的接觸到手。
- 設計圖：使用者有給角色設計圖（plan.characters[].design）就把它和畫面裡的角色並排比：比例、眼睛、手腳、配色、配件位置，走樣是 blocker。
  舉手、轉身、指人時輪廓不能出現凹口、缺角或斜切（特寫最明顯）。
- 穿插與遮擋：角色之間、角色和道具不互相穿透；前後關係正確。
- 畫面：主體夠大（有情緒、對話、表情戲的鏡頭，主角至少佔畫面高度 35%，看得清臉；只有刻意的遠景建立鏡頭例外）、沒有無用途的大片空白；
  字不壓主體；字幕要把整張圖縮到手機寬度（約 390px 寬）也讀得出來：字高至少畫面高度 4.5%、有描邊或半透明底；沒有色帶、髒污、破圖、閃格、跳格；轉場每個接縫都有。
- 動作：有預備動作與餘韻、不機械；同一鏡內造型不跳動（例如眼鏡突然變墨鏡）。**動作只能從連續影格判斷**：每個動作（拿、轉身、坐下、跳、表情變化、道具移動）
  都要看 12fps 的連續 strip，找：一格就換姿勢／表情（沒有中間格）、道具瞬移、該動的手不動、整個人僵硬平移或旋轉、超過 1 秒完全靜止的表演鏡頭。
- 不要用閃白、轉場或鏡頭切走去蓋掉做不到的動作；做不到就在共用角色定義新增姿勢或換一個做得到的演法。`;

const QA_OUT = (file: string, extra = '') => `寫 ${file}（JSON）：${extra}
  "needs_user": [ { "kind": "lyrics|audio|image|text|other", "issue": "缺什麼、為什麼導演自己做不到" } ]  ← 只有必須由使用者提供的東西才放這裡，這類不算缺陷、不要放進問題清單
每個問題都要寫：鏡頭、秒數或畫面位置、看到什麼（具體）、建議怎麼改（engine 參數或畫法）。不要放「做不到的事」當問題。
每個問題都要標 "severity"：
  - "blocker"：觀眾用正常速度、正常大小（手機或電腦全螢幕）看成片就會注意到的缺陷——斷肢、浮空、少脖子、接縫、穿模、動作讀錯意思、
    角色前後不一致、字看不清、主體太小、閃格跳格、畫面大片空白或壞圖。
  - "polish"：要放大好幾倍才看得到、只出現在設定圖排版、或本片用不到的姿勢／角度的小瑕疵。
**pass = 沒有任何 blocker**（polish 照寫，會交給後面的製作 agent 順手處理，不會擋住進度）。
第 2 輪以後：先核對上一輪的修正；新發現的問題只有 blocker 才能讓這一輪不通過，不要每一輪都用放大鏡找新的小毛病。`;

const CAST_CLASSIFICATION = `Cast versus assets: plan.characters contains only actual characters with a persistent identity and character performance (poses, expressions, acting or a character rig). Abstract circles, geometric shapes, particle clusters, typography, icons, diagrams, UI cards and decorative motion-graphics objects belong in plan.assets with status "drawn_in_code", even when animated, recurring or called "hero". An anthropomorphized shape that genuinely acts as a character still belongs in characters. Animation alone does not make an asset a character. Use characters: [] for characterless motion graphics; preserve asset IDs, files and shot references.`;

// Reuse the director's setup role/session, but never send the scaffold/build instructions on recovery.
const reconcileCast = (issues: string[]) => `
## Step: reconcile cast metadata (resume completed setup)
${CAST_CLASSIFICATION}
Validation problems:
${issues.map((issue) => `- ${issue}`).join('\n')}
Read plan.json, build/production.json and the existing object definitions before deciding which entries are characters.
This is a targeted recovery, NOT a new setup. Keep chunks, shot files, shared assets, renders, animation code, timing and all completed work unchanged.
For misclassified motion-graphics objects, move the complete plan.characters entry into plan.assets using the same ID and file; merge without overwriting existing asset fields. Keep all shot references and animations intact. Set both characters arrays to [] only if there truly is no cast.
For legitimate characters, retain the approved cast and restore the matching production.characters entries (id, file, sheet). Generate only missing individual cast sheets and out/check/cast/sheet.jpg, reusing existing definitions and render commands. Never remove a real character to make validation pass.
Make the two character ID sets agree and save build/production.json; update plan.json only where classification needs correction. Do not restart setup, rebuild shots or assemble the video.`;

export const prompts: Prompts = {
  // ---------- pre-production ----------
  style: (p) => `${HEADER(p)}

## 步驟：風格拆解與選 skill
使用者需求（brief.md）：
${p.brief}

1. analyze.py 已跑完：讀 analysis/report.json，打開 analysis/sheet_1fps.jpg 與 sheet_scenes.jpg 實際看。
2. 寫 analysis/STYLE.md：第一行寫媒材；把 shot_details 整理成鏡頭清單表；配色與色彩弧線、角色造型語言、剪接、轉場、敘事結構、字幕用法；
   最後列「這支好看的 3–5 個關鍵」。
2b. **找參考片的高潮（起雞皮疙瘩的那 1–2 刻）**：report.json 的 audio.peak_candidates（音樂蓄力後爆發的時間點）與 flashes（閃白格）只是線索；
   對每個候選用 clip_strip.py 對參考片（${REF}）抽前 2 秒到後 2 秒的 12fps 連續影格（不加 --vs）存成 analysis/peak_<n>.jpg，打開看，確認真正的爆點。
   寫 analysis/peaks.json：[ { "id": "P1", "from": 24.0, "hit": 26.0, "to": 29.0, "strip": "analysis/peak_1.jpg",
     "build": "爆發前怎麼堆張力（畫面、運鏡、音樂）", "hold": "爆發前有沒有停住或安靜、多久", "hit_what": "爆發那一格發生什麼（構圖、色彩、主體大小、畫面密度）",
     "after": "爆發後停多久、怎麼收", "sound": "音樂與音效在做什麼", "techniques": ["白閃引信", "布幕揭開", "群眾填滿畫面", "…"],
     "why_it_works": "一句話：為什麼這一刻打得到人" } ]。沒有音樂的參考片也要找出最強的 1 刻（笑點爆發、揭露、反轉）。
   STYLE.md 加一節「高潮」摘要 peaks.json。
3. 讀 ${SKILL}/styles/*.md（跳過 _TEMPLATE.md 與 _disabled/；目前只做 2D）。參考片是 3D 時選最接近的 2D 風格並在 why 明說。
   依辨識特徵打分選風格與 engine，寫 analysis/route.json（含 medium）。都不符合時選最接近的 engine，new_style_proposed: true，
   並把建議的風格檔寫在 analysis/proposed_style_<name>.md（skills 目錄唯讀）。使用者指定風格或工具時以使用者為準。`,

  plan: (p) => `${HEADER(p)}

## 步驟：前製企劃
使用者需求（brief.md）：
${p.brief}
使用者提供的檔案（inputs/）：${p.inputs.length ? p.inputs.join('、') : '沒有'}

1. 讀 STYLE.md、route.json、engine 的 SKILL.md、風格檔的「製作預設」「已知的坑」。
2. 配樂：inputs/ 有音檔 → analyze.py 分析，選段寫進 plan.music（file 指向實際音檔、section.start_s/end_s）。
3. **必要素材（required_inputs）**：列出只有使用者能提供、少了就做不出企劃效果的東西，例如：
   - 參考片有歌詞字幕 → { "id": "lyrics", "kind": "lyrics", "label": "歌詞文字", "why": "卡拉 OK 字幕；貼上純文字即可，系統會自動對時" }
   - 使用者要用自家角色、Logo、產品照 → kind image，label 寫清楚。
   plan.json 寫 required_inputs 陣列（沒有就空陣列）。使用者沒提供前，核准按鈕會被擋住，使用者可以提供或選擇略過。
${WOW}
3b. **先設計高潮，再排其他鏡頭**：讀 analysis/peaks.json，寫 plan.peaks（每個參考高潮對應一個，片長短可以只做 1 個）：
   { "id": "P1", "ref_peak": "P1", "shots": ["S8","S9"], "build_from_s": 21.5, "hold_s": [23.6, 24.0], "hit_s": 24.0, "hold_after_s": 1.5,
     "build": "…", "hit": "爆發那一格的畫面（主體、大小、構圖、色彩、密度）", "after": "…", "sound": "蓄力/安靜/撞擊/音樂落點",
     "techniques": ["參考用的手法，一個都不少", "+ 我們多加的"], "emotion": "觀眾在這一刻應該感受到什麼", "key_frame": "out/check/key_1.jpg" }
   爆點要落在音樂的重拍或段落起點（hit_s 對拍）。peaks 裡的鏡頭在 shots 標 "hero": true，它們的 action 要寫到格的層級（預備、爆發、停住）。
   其他鏡頭的任務是把觀眾帶到高潮：開場 3 秒內要有鉤子，結尾要收回高潮的情緒（呼應）。
   **情緒弧線**：不只能量往上，要有一個小故事（想要什麼 → 遇到阻礙或等待 → 高潮時得到），讓爆點有意義。
   **變化**：在 STORYBOARD.md 列出每鏡的場景與機位，算出同一場景＋機位佔片長的比例（≤ 40%），高潮之間換場景或視角。
4. 寫 plan.json（CONTRACT.md 格式）與 STORYBOARD.md：logline、look、borrowed_from_reference、角色／產品、每鏡時間、動作、轉場、reads、
   素材與音效；逐鏡對照：ref_shot、ref_what、camera（engine 規格、pace 跟參考一致）。平均鏡頭長度、字卡比例、暗調比例與參考接近（±30%）。
${CAST_CLASSIFICATION}
5. 角色：plan.characters 每個角色寫清楚造型（輪廓、比例、配色、髮型、服裝、特徵）與 id；使用者有給設計圖的角色寫 "design": "inputs/<圖>"，
   並量出設計圖的比例寫進描述（例如：身體寬:高 = 1.9:1、眼睛在上 1/3、手從身體中段水平伸出、4 隻短腳）。
   ${DESIGN}
   引擎用 vector_rig 這類「每個角色一個定義檔」的做法時，填 "file": "build/assets/cast/<id>.js"，並先在 build/ 建好引擎骨架、
   把 rig 複製到 build/assets/（角色檔要能在那裡跑）。**不要自己寫角色定義檔**：接下來每個角色會有一個 agent 同時做。
6. 素材：plan.assets 每一項寫 purpose、kind、query（搜尋關鍵字）與 status：要從外部取得的標 to_fetch、程式畫的標 drawn_in_code、使用者提供的標 user。
   **不要自己下載**：接下來有一個素材 agent 同時去抓。旁白片要先生成旁白草稿、用真實長度排每鏡時間（這一步你自己做）。
7. 風格定調畫面：這一輪不用做；在 plan.style_frames 先寫好要畫的畫面，**最前面是每個高潮的關鍵畫面對照圖 out/check/key_<n>_vs_ref.jpg**，
   後面 2–3 張 out/check/style_<n>.jpg（對應哪一鏡、要表現什麼）。角色與素材好了之後你會接著畫。
8. open_questions 只放真的需要使用者決定的事（最多 4 個），缺素材的事寫在 required_inputs、不要只寫在問題裡。`,

  // ---------- pre-production helpers that run in parallel after the plan core ----------
  pre_cast: (p) => `${HEADER(p, '角色設計')}

## 步驟：做角色「${p.character.name || p.character.id}」的定義檔（前製；其他角色和素材有別的 agent 同時在做）
企劃裡的描述：${JSON.stringify(p.character)}
1. 讀 plan.json（look、這個角色會出現的鏡頭與動作）、STYLE.md、${SKILL}/assets/vector_rig/README.md（或引擎 SKILL.md 的角色做法）。
2. 只寫 ${p.character.file}：造型、配色、比例、本片會用到的表情與姿勢（寫成具名的姿勢，鏡頭之後直接呼叫）。不要改 rig 本體或其他角色的檔。
   ${p.character.design ? `**這個角色有使用者的設計圖 ${p.character.design}**：先打開它量比例，照它畫。${DESIGN}
   比例寫成常數鎖在定義檔裡（所有姿勢、配件都從同一組比例與臉部錨點算），配件綁在臉／頭的錨點上。` : ''}
3. 輸出一張快速檢查圖 out/check/cast/pre_${p.character.id}.jpg（正面、3/4、側面、4 個以上表情、本片最重要的 3 個姿勢${p.character.design ? '；最左邊放使用者的設計圖，同高並排' : ''}），整張打開看一次，
   明顯的問題（斷肢、浮空、比例錯）當場修掉。**這是前製草稿，不用逐格放大檢查**：核准後的角色關會有獨立審查員做完整的人眼檢查，你之後也會負責修。
4. 回報：做了哪些姿勢／表情、還沒做的（製作階段會補）。`,

  pre_assets: (p) => `${HEADER(p, '素材')}

## 步驟：抓素材（前製；角色有別的 agent 同時在做）
把 plan.json 裡 status 是 to_fetch 的素材全部取得：先用 ${SKILL}/scripts/fetch_assets.py，不夠就上網找。存到 assets/，每一個都把來源、作者、授權寫進 assets/ASSETS.md。
聲音素材抓完聽長度、裁掉前後空白；圖片確認解析度夠用。**不要改 plan.json**，結果寫 assets/fetched.json：
[ { "id": "A1", "file": "assets/…", "source": "…", "url": "…", "license": "…", "attribution": "…", "status": "fetched|failed", "note": "…" } ]
找不到合適的就 status: failed 並寫原因與建議（例如改成程式畫）。`,

  plan_frames: (p) => `${HEADER(p)}
${ENGINE(p)}

## 步驟：整合前製結果、畫風格定調畫面
${CAST_CLASSIFICATION}
角色 agent 與素材 agent 已經做完（結果：${JSON.stringify(p.results)}）。
1. 把 assets/fetched.json 合併進 plan.json 的 assets（file、source、license、attribution、status）；抓不到的改用替代方案並更新該項。
2. 看每個角色的 out/check/cast/pre_*.jpg；明顯不符合企劃或拼接感的地方直接改角色檔（角色 agent 沒做的角色，你自己做）。
3. **高潮關鍵畫面（最重要）**：每個 plan.peaks 在 build/ 用真正的角色、素材、光影、特效，把爆發那一格做到**成片品質**存成 key_frame（全解析度），
   再做 out/check/key_<n>_vs_ref.jpg：左邊參考片 hit 那一格（ffmpeg 從 ${REF} 抽）、右邊我們的，同高並排。
   打開並排圖誠實比較：主體大小、畫面密度、光影、色彩衝擊、情緒。**我們的明顯比較弱就繼續改**（加密度、加光、放大主體、改構圖），不要交出比參考片弱的關鍵畫面。
   在 plan.peaks[].key_frame_note 寫一句自評（哪裡已經贏、哪裡還輸）。使用者核准企劃時會先看這幾張。
4. 照 plan.style_frames 其餘項目渲染 2–3 張 out/check/style_*.jpg（用真正的角色與素材），和對應參考鏡頭並排看，到水準才交出。
5. 更新 plan.json（style_frames：key_*_vs_ref.jpg 放最前面；assets）與 STORYBOARD.md；鏡頭內容除非必要不要改。
${WOW}
${EYE}`,

  replan: (p) => `${HEADER(p)}

## 步驟：依使用者意見修改企劃
${CAST_CLASSIFICATION}
使用者的意見：
${p.message}

修改 plan.json 與 STORYBOARD.md（version +1，changelog），必要時補抓素材、重畫受影響的定調畫面（改到高潮就重做 key_<n>_vs_ref.jpg）。不要開始生成。逐條回報怎麼處理；做不到的直說並給替代方案。
改動如果犧牲了參考片的核心（例如雙人故事改成獨角戲、拿掉高潮），在回報裡明講這個取捨。`,

  // ---------- production: setup → cast gate → shot line → assemble ----------
  setup: (p) => p.reconcile ? `${HEADER(p)}\n${reconcileCast(p.reconcile)}` : `${HEADER(p)}
${ENGINE(p)}

## 步驟：製作準備（你是導演；接下來會有 ${p.config.builders} 個製作 agent 平行做鏡頭、每段做完立刻有獨立審查員檢查）
${CAST_CLASSIFICATION}
Before making cast sheets, ensure plan.characters and production.characters contain exactly the same character IDs. If an older plan misclassified an abstract object, move its full entry into plan.assets, preserving existing asset metadata, IDs, files, shot references and animations; do not silently omit it from production or remove it from the video. Legitimate characters require both the lineup sheet and their individual sheets.
0. 前製已經做好的東西直接沿用、不要重做：build/ 的骨架、角色定義檔（plan.characters[].file）、assets/ 的素材、旁白草稿。
1. 在 build/ 建好（或補齊）製作專案骨架：共用的東西先做好並鎖定（配色、字型、節拍表、共用道具、字幕層、背景），
   全片規格一開始就定好、寫進共用檔（最後評審最常退回的就是這些）：
   - 字幕層：字高 ≥ 畫面高度 5%、粗描邊（1080p 下 ≥ 8 px）加下陰影或半透明底條，壓在白色/淺色物件上也讀得出來；縮到 390 px 寬要能一眼讀出。
   - 片尾：不要在最後幾格硬切全黑；要黑就用 ≥ 0.4 秒淡出，字幕跟著淡出。
   - 質感收尾層（全片共用、蓋在最上面）：照參考片的質感加紙紋／顆粒、暗角、調色（色彩弧線每段一組），爆點加光暈（bloom）；
     參考片有紙紋或手繪抖動就**不准拿掉**（那是它的質感，不是雜訊）。
   - hero 鏡頭（plan.peaks）的特製素材先準備好：特製姿勢、變形臉、衝擊格、粒子、光芒，寫進共用角色定義或共用特效檔，讓製作 agent 直接呼叫。
   - 混音：旁白約 -16 LUFS；配樂在旁白下約低 10–14 dB，但在沒有旁白的空檔（字卡、停頓笑點）要聽得到（約 -24 ～ -28 dBFS RMS），不要用過強的 sidechain 把音樂壓到消失；做完量一次空檔的音量。
   - 高潮音效：plan.peaks 的 sound（爆點前的安靜或抽空、蓄力上升音、落在 hit_s 的撞擊／音樂重拍）在共用混音裡先放好。
   每個鏡頭各自一個檔案（painted-animation：src/scenes/<shot>.js；hyperframes：compositions/<shot>.html），總檔先把全部鏡頭的引用都掛好，
   讓製作 agent 只需要改自己的鏡頭檔，不會互相衝突。
2. **角色**：用 engine 的角色系統做出每個角色（2D 向量風格一律用 ${SKILL}/assets/vector_rig/ 的骨架＋一體輪廓角色，不准用分開的形狀拼角色；
   painted 風格用角色骨架 cast_rig）。**每個角色一個定義檔**（例如 build/assets/cast/<角色id>.js），骨架／rig 本體另外一個共用檔；
   鏡頭只能呼叫角色定義、不准在鏡頭裡另外畫角色的身體部位。（每個角色會由不同 agent 同時審查與修正，所以不能把所有角色寫在同一個檔案裡。）
3. **角色設定圖**：每個角色一張 out/check/cast/sheet_<角色id>.jpg（全解析度）：正面、3/4、側面、5 個以上表情、
   6 個以上本片會用到的動作姿勢（舉手、揮手、拿東西、坐、跑、驚嚇…）。再加一張所有角色並排的 out/check/cast/sheet.jpg（比例、互動姿勢）。
   每張都要有可以重新輸出的指令（寫進 production.json 的 characters[].render）。自己先打開看過。
   plan.characters 是空的（純字卡、動態圖像這類沒有角色的片）就跳過 2、3：不做設定圖，production.json 的 "characters" 寫 []，不要自己加角色。
4. 寫 build/production.json：
   { "cast_sheet": "out/check/cast/sheet.jpg",
     "characters": [ { "id": "dou", "name": "豆豆", "file": "build/assets/cast/dou.js", "sheet": "out/check/cast/sheet_dou.jpg", "render": "重新輸出這張設定圖的指令" } ],
     "rig_files": ["build/assets/rig.js"],
     "chunks": [ { "id": "C1", "shots": ["S1","S2","S3"] }, ... ],   ← 依敘事段落把鏡頭分成 ${p.config.builders} 段左右（鏡頭少就少分幾段），每段 1–4 鏡；連續動作、跨鏡接縫多的鏡頭放同一段
     "shot_files": { "S1": "build/src/scenes/S1.js", ... },
     "prerender": { "cwd": "build", "cmd": "node render.mjs --frames --range={start}:{end} --workers=2" },   ← 有快取的逐格引擎（render.mjs --frames）才寫；系統會在每段通過審查後自動在背景先渲染那段的正式影格，組裝時只剩改過的鏡頭要重渲
     "how_to_preview": "製作 agent 怎麼渲染自己鏡頭的 stills 與 strip（指令；HyperFrames 專案用 hf_frames.py 包一層，鏡頭內時間換算成全片時間，一次輸出 sheet／strip／裁切）", "how_to_render": "…", "shared_readonly": ["…"] }`,

  cast_qa: (p) => `${HEADER(p, '角色審查員（獨立，沒參與製作）')}

## 步驟：角色關（第 ${p.round} 輪）— 角色通過之前，不會開始做任何鏡頭
${p.character ? `**這一輪你只審角色「${p.character.name || p.character.id}」**：看 ${p.character.sheet}（其他角色有別的審查員）。修正紀錄在 out/check/cast/fixes_${p.character.id}.json。結果寫到 out/check/cast/review_${p.character.id}.json（格式同下）。\n` : ''}${p.lineup ? '**每個角色都已經各自通過了，這一輪只看並排圖 out/check/cast/sheet.jpg**：角色之間的比例、畫風一致、互動姿勢（牽手、並肩…）有沒有穿模或接不起來。個別角色的細節不用再挑。\n' : ''}
1. 讀 plan.json 的 characters 與 brief；打開 out/check/cast/ 的所有設定圖，**每個角色、每個表情、每個姿勢都放大看**
   （用 Python PIL 裁切全解析度區塊存到 out/check/cast/qa_*.png 再打開）。
2. 第 2 輪以後：先讀 out/check/cast/fixes.json，逐項核對上一輪的問題是否真的修好（看修改後的截圖，不是看說明）。
${EYE}
另外判斷：造型是否符合企劃描述、是否夠有個性且在參考片的風格範圍內、會不會跟知名既有角色撞臉。
   **有使用者設計圖的角色**：把設計圖和設定圖裡每個姿勢並排（PIL 拼成 out/check/cast/qa_<id>_vs_design.jpg）逐格比；
   比例漂移（變高變窄）、手腳數量或位置不對、配件蓋住身體或戴錯部位，都是 blocker。
3. ${QA_OUT('out/check/cast/review.json', '{ "pass": true|false, "issues": [ { "character": "…", "what": "姿勢/表情/部位", "issue": "…", "fix": "…" } ], "verified_fixes": [ { "issue": "…", "fixed": true|false } ], "needs_user": [] }')}
   會讓觀眾覺得「拼湊、廉價、不一致」的都是 blocker。`,

  cast_fix: (p) => `${HEADER(p)}
${ENGINE(p)}

## 步驟：修角色（角色審查第 ${p.round} 輪沒過）
${p.character ? `**你只負責角色「${p.character.name || p.character.id}」**：只能改 ${p.character.file}，改完用 production.json 裡這個角色的 render 指令重新輸出 ${p.character.sheet}。
其他角色有別的 agent 同時在修，**不准改共用骨架／rig 檔（${(p.rigFiles || []).join('、') || 'rig'}）或其他角色的檔案**；問題非改共用骨架不可時，那一項寫 "status": "shared" 和建議改法，導演會統一處理。
修正紀錄寫到 out/check/cast/fixes_${p.character.id}.json（格式同下）。\n` : ''}${p.shared ? '**這一輪只處理各角色 agent 回報需要改共用骨架的項目**（status: shared），改完重新輸出所有 sheet_*.jpg 與 sheet.jpg。\n' : ''}
問題清單：
${JSON.stringify(p.issues, null, 1)}
${p.message ? `\n使用者看過設定圖後的指示（優先照做）：${p.message}\n` : ''}逐項修改共用的角色定義（不是只修某張圖），重新輸出 out/check/cast/sheet*.jpg。
寫 out/check/cast/fixes.json：[ { "issue": "…", "change": "改了什麼", "before": "out/check/cast/fix_<n>_before.png", "after": "…_after.png" } ]，
每一項都要有修改前後的全解析度裁切圖（同一個部位、同一個姿勢），自己打開確認真的改好了。做不到的寫 "status": "cannot" 和原因。`,

  build_chunk: (p) => `${HEADER(p, '製作')}
${ENGINE(p)}

## 步驟：製作鏡頭段 ${p.chunk.id}：${p.chunk.shots.join('、')}
先讀 build/production.json（共用檔、鏡頭檔位置、預覽指令）、plan.json 這幾鏡的規格、out/check/cast/ 的角色設定圖。
- 角色審查留下的 polish 項目（out/check/cast/review*.json 裡 severity 是 polish 的）如果出現在你的鏡頭裡，順手在鏡頭檔處理掉（例如那一鏡把手型換掉），共用檔不要改。
- 其他段落已經通過審查的話（out/check/shots/*.review.json 裡 pass 的鏡頭），先打開它們的 *_sheet.jpg 看一次：線寬、配色、角色大小、字幕樣式、鏡頭節奏跟它們一致，整支片才像同一個人做的。
- 同時有好幾個製作 agent 在渲染：預覽只渲染需要的幾格（stills/strip），不要反覆整段渲染，也不要開大量平行 worker。
- 只改自己的鏡頭檔；共用檔（角色、配色、總檔）唯讀，發現共用檔有問題寫進 out/check/shots/${p.chunk.id}.done.json 的 notes，不要改。
- 角色一律呼叫共用角色定義，造型、比例、配色和設定圖一致；不准在鏡頭裡自己畫手臂、手、身體。
- **hero 鏡頭**（plan.shots 裡 "hero": true，屬於 plan.peaks）：照 plan.peaks 的 build/hit/after 做到格的層級；可以用特製姿勢、誇張變形、衝擊格、smear、
  光芒、粒子、鏡頭震動（需要新的角色姿勢或變形臉就在 notes 寫 "status": "shared" 請導演加進共用角色定義，不要在鏡頭裡疊畫手臂或身體）。
  做完用 clip_strip.py 把這段和參考高潮（analysis/peaks.json 的 from–to）並排成 out/check/shots/<shot>_peak_vs_ref.jpg，打開比：我們的爆點不如參考片震撼就繼續加，不要交。
${WOW}
- 每一鏡做完就渲染檢查（不要全部做完才看）：stills（開頭/中間/結尾）與**每個動作 12fps 的連續 strip**，存成 out/check/shots/<shot>_sheet.jpg，
  並把每個角色裁切成全解析度 out/check/shots/<shot>_crop_*.png，自己打開看。
${EYE}
- **每一鏡做完、自己檢查過，就立刻寫 out/check/shots/<shot>.done.json**：{ "id": "S1", "sheet": "…", "crops": ["…"], "notes": "…" }，
  然後接著做下一鏡。寫出這個檔的那一刻，獨立審查員就會開始審這一鏡（你不用等）；之後不要再改已交出的鏡頭，除非是修正輪。
- 全部做完寫 out/check/shots/${p.chunk.id}.done.json：{ "shots": [ { "id": "S1", "sheet": "…", "crops": ["…"], "notes": "…" } ] }`,

  shot_qa: (p) => `${HEADER(p, '鏡頭審查員（獨立，沒參與製作）')}

## 步驟：審查鏡頭 ${(p.shots || p.chunk.shots).join('、')}（屬於段落 ${p.chunk.id}，第 ${p.round} 輪）
1. 讀 plan.json 這幾鏡的規格（動作、運鏡、ref_shot）、out/check/cast/ 角色設定圖、out/check/shots/ 裡這幾鏡的 <shot>.done.json（或 ${p.chunk.id}.done.json）。
   同一段的其他鏡頭可能還在製作，只審指定的鏡頭；如果前一鏡已經做好，也檢查「前一鏡最後一格 → 這一鏡第一格」的接縫。
2. **先用製作 agent 已經輸出的圖**（<shot>_sheet.jpg、strip、裁切、<shot>_peak_vs_ref.jpg）：它們比鏡頭檔新就直接看，不要重截（截圖是最花時間的事）。
   只有鏡頭檔比那些圖新、圖不夠看、或要放大某一處時，才用預覽指令（build/production.json 的 how_to_preview；HyperFrames 用 hf_frames）補截，一次把要補的時間點全部截完。
   連續影格一律 12fps（render.mjs --strip 預設就是 12fps），不要用 24fps。
   參考片對應鏡頭在 analysis/（sheet_scenes.jpg；需要時用 ffmpeg 從 ${REF} 抽格）。
3. 第 2 輪以後：先讀 out/check/shots/${p.chunk.id}.fixes.json，逐項用修改後的截圖核對是否真的修好；沒修好的直接列回問題。
${EYE}
另外：動作與運鏡是否照企劃、和參考鏡頭的手法一致；和角色設定圖比對造型一致性。
   **動作**：每個動作都要看 12fps 連續影格（製作 agent 的 strip 不夠就自己用預覽指令的 strip 模式或 hf_frames --range 截）。一格換姿勢、道具瞬移、
   該動不動、僵硬整塊旋轉、表演鏡頭超過 1 秒完全靜止，都是 blocker。
   **hero 鏡頭**（plan.peaks）：打開 <shot>_peak_vs_ref.jpg（沒有就自己用 clip_strip.py 做），參考在上、我們在下逐格比。
   爆點比參考片弱（主體小、畫面空、沒有停住、被閃白蓋掉、沒有預備或衝擊）是 blocker，寫清楚差在哪、要加什麼。
4. ${QA_OUT(p.out || `out/check/shots/${p.chunk.id}.review.json`, '{ "shots": [ { "id": "S1", "pass": true|false, "issues": [ { "time": 1.2, "where": "畫面位置", "issue": "…", "fix": "…" } ] } ], "verified_fixes": [ { "issue": "…", "fixed": true|false } ], "needs_user": [] }')}
   嚴格：專業動畫導演會退回的就不過。`,

  fix_chunk: (p) => `${HEADER(p, '製作')}
${ENGINE(p)}

## 步驟：修鏡頭段 ${p.chunk.id}（審查第 ${p.round} 輪沒過）
沒過的鏡頭與問題：
${JSON.stringify(p.bad, null, 1)}
${p.message ? `\n使用者的指示（優先照做）：${p.message}\n` : ''}先看 out/check/shots/${p.chunk.id}.shared.json（如果有）：導演已經改好的共用功能，照它的 api 套用到鏡頭裡。
逐項修改（只改自己的鏡頭檔），重新渲染受影響的 stills/strip 與角色裁切。
寫 out/check/shots/${p.chunk.id}.fixes.json：[ { "shot": "S2", "issue": "…", "change": "改了什麼", "before": "…_before.png", "after": "…_after.png" } ]，
before/after 是同一秒、同一位置的全解析度裁切，自己打開確認改好了。共用檔的問題不要自己改，寫 "status": "shared" 說明要導演改什麼。`,

  shared_fix: (p) => `${HEADER(p)}
${ENGINE(p)}

## 步驟：修共用檔（鏡頭段 ${p.chunk.id} 的製作 agent 回報，這些問題只能改共用檔才修得好）
${JSON.stringify(p.items, null, 1)}
其他段落正在平行製作，所以：
- 只做「加法」或向下相容的修改（例如在 rig 新增手型 'palm'，不要改掉現有手型的樣子）；改動會影響已通過的鏡頭時，寫在回報裡。
- 改完用 production.json 的預覽方式重新輸出受影響的角色設定圖，並渲染 ${p.chunk.id} 相關鏡頭的前後對照裁切，自己打開確認。
- 寫 out/check/shots/${p.chunk.id}.shared.json：[ { "issue": "…", "change": "改了哪個共用檔的什麼", "api": "鏡頭要怎麼呼叫（例如 handR: 'palm'）", "after": "…png" } ]。
不要改 ${p.chunk.id} 自己的鏡頭檔；鏡頭要怎麼用新功能寫在 api 欄位，由該段的製作 agent 套用。
例外：問題在**其他段落、已經通過審查**的鏡頭檔（例如跨段接縫的前一鏡最後幾格），那個檔目前沒人在改，你直接改它，改完用 hf_frames 重截那一鏡受影響的時間點確認，並寫進 shared.json。`,

  assemble: (p) => `${HEADER(p)}
${ENGINE(p)}

## 步驟：組裝成片（所有鏡頭段都已通過審查）
1. 讀 build/production.json 與各段 out/check/shots/*.fixes.json 裡 "status": "shared" 的項目，先修共用檔的問題。
2. 接起全部鏡頭：轉場、配樂、音效、字幕（歌詞字幕只能用 analysis/lyrics/subs.lrc 或 inputs 的 LRC；沒有就不上歌詞字幕）。
3. 正式渲染 out/video.mp4（render.mjs --frames 有快取：通過審查的段落多半已經在背景渲染好，只會重渲改過的鏡頭；不要刪 out/frames）；確認有音軌（ffprobe；沒有就把混音 mux 進去）。跑 python ${SKILL}/scripts/compare.py ${p.dir}；檢查每個接縫（前後 0.5 秒 strip）。
4. 跑 python ${SKILL}/scripts/motion_check.py out/video.mp4 --out out/check/motion：片中黑格、片尾硬切黑、意外的長時間靜止都要修掉再交。
5. 每個 plan.peaks 用 clip_strip.py 做 out/check/peak_<n>_vs_ref.jpg（我們的 build_from_s–hit_s+hold_after_s 對參考 peaks.json 的 from–to），打開比；明顯輸參考片就先修。
6. 回報：長度、解析度、每鏡一句話、還不完美或暫代的部分。`,

  // ---------- final panel ----------
  critique: (p) => `你是這支影片的**獨立評審**（資深美術總監），不是製作者；你沒參與製作，沒有任何理由護短。
工作目錄是 repo 根目錄；專案資料夾：${p.dir}。先讀 ${SKILL}/SKILL.md 的品質門檻與 engine 的 SKILL.md。
使用者需求：${p.brief}
${RULES}

你只能讀、量、看，並寫 out/check/critique.json 與 critique.md；不要修改其他檔案。每個鏡頭在製作時已經過鏡頭審查（他們只抓瑕疵）。
**你的工作是判斷這支片能不能讓人起雞皮疙瘩、有沒有到參考片的水準**，不是確認「沒有錯」。
${WOW}

1. 參考片：analysis/report.json、peaks.json、sheet 圖。
2. **高潮對決（最先做、最重要）**：plan.peaks 每一個，用 clip_strip.py 做 out/check/critic/peak_<n>_vs_ref.jpg
   （我們：build_from_s 到 hit_s+hold_after_s；參考：peaks.json 的 from–to），打開逐格比：鋪陳、屏息、爆點那一格、停住、畫面密度、主體大小、聲音落點
   （用 ffmpeg 的 astats/ebur128 量我們爆點前後的音量變化，對照參考）。判定 ours_better / equal / ref_better 並寫具體理由。
   **ref_better 就不能通過**：在 must_fix 寫出要加什麼才會贏（具體到手法、格數、大小）。
   **就算判 ours_better，你在 why 裡寫到的弱點（主角太小、屏息太長、爆點後沒東西看、配件讀錯）也要各列一條 must_fix**——高潮是這支片的全部價值，不放在 nice_to_have。
   hero 鏡頭裡一格就換姿勢（沒有中間格）、主角在爆點或停住段小於畫面高 30%，都是 must_fix。
3. 成片：ffmpeg 每 0.5 秒抽一格做總覽到 out/check/critic/，全部打開；每個接縫抽前後 0.5 秒的 strip；
   每個動作用 clip_strip.py 抽 12fps 連續影格看（跳格、瞬移、該動不動、僵硬）；可疑處抽全解析度放大。
   跑 python ${SKILL}/scripts/motion_check.py out/video.mp4 --out out/check/critic/motion，打開它產生的每張 strip。
4. 跑 compare.py，看 compare_all.jpg；逐鏡打分（CLAUDE.md 要求每鏡 ≥ 4）。
4b. 角色設計圖（plan.characters[].design）：每鏡抽一格角色清楚的畫面，和設計圖拼成一張並排圖逐一比對（比例、眼睛、手腳、配件位置）。
4c. 變化：從 0.5 秒總覽算出同一場景＋機位佔片長的比例（> 40% 是 must_fix）；高潮前的鋪陳有沒有一個構圖停太久。
5. **第 1 輪就把觀眾看得出來的問題全部列進 must_fix**，不要留到後面的輪次。
   第 2 輪以後：先讀 out/check/fixes.json，**逐項核對上一輪的必修是否真的修好**（看它附的 before/after，再自己在成片同一秒抽格確認；動作類的修正一定要看 12fps 連續影格，不是單張）；
   說修好但沒修好的，原樣列回 must_fix 並註明「上一輪已列，仍未修好」。**被修改過的鏡頭整鏡用 12fps 重看一次**，修改引進的新問題列 must_fix。
   第 2 輪以後新的 must_fix 只能是：沒修好的、修改造成的新問題、或真正的 blocker（觀眾一眼看得出來）；其他放 nice_to_have，不要每輪加碼。
   **nice_to_have 只能放觀眾用正常速度看不出來的東西。** 角色輪廓破損（凹口、缺角、斜切、手腳和身體接不起來）、沒有描邊的碎片、
   配件讀錯——只要在一般大小的成片裡看得到，就是 must_fix，不論是哪一輪發現的。
${EYE}
6. 寫 out/check/critique.json：
   { "pass": false,
     "peaks": [ { "id": "P1", "ours": [21.5, 25.5], "ref": [24.0, 29.0], "ref_file": "analysis/proxy.mp4", "strip": "out/check/critic/peak_1_vs_ref.jpg", "verdict": "ours_better|equal|ref_better", "why": "具體" } ],
     "scores": { "高潮震撼":1-5, "開場鉤子":1-5, "畫面質感":1-5, "角色忠實":1-5, "角色表演":1-5, "變化":1-5, "動作流暢":1-5, "運鏡":1-5, "構圖密度":1-5, "瑕疵":1-5, "字幕標題":1-5, "節奏連戲":1-5, "聲音":1-5 },
     "score_notes": { "高潮震撼": "給這個分數的證據（秒數＋看到什麼）", "…": "…" },
     "shots": [ { "id": "S1", "score": 1-5, "why": "一句話" } ],
     "must_fix": [ { "shot": "S6", "time": 12.3, "issue": "具體問題", "fix": "具體改法" } ],
     "needs_user": [ { "kind": "lyrics|audio|image|text|other", "issue": "缺什麼（例如：沒有歌詞文字，無法上卡拉OK字幕）" } ],
     "verified_fixes": [ { "issue": "…", "fixed": true|false } ],
     "nice_to_have": [], "summary": "一句話" }
   **分數以參考片為尺**：5 = 比參考片好；4 = 和參考片同水準（放在一起看不出哪支比較陽春）；3 = 看得出比參考片陽春；2 = 明顯差一截；1 = 壞掉。
   每一項都要在 score_notes 寫證據；不准整排給同一個分數交差——4 分表示你願意把它和參考片並排給人看。
   規則：must_fix 只放導演能修的；缺使用者素材一律放 needs_user、不要放 must_fix（也不要因此扣分）；
   任何一項 < 4、任何一鏡 < 4、任何高潮 ref_better，都必須有對應 must_fix；沒有 must_fix 時 pass 才能是 true。
最後用 3–5 行繁體中文回報結論。`,

  revise: (p) => `${HEADER(p)}
${ENGINE(p)}

## 步驟：修改成片${p.round === 'user' ? '（使用者回饋）' : `（評審第 ${p.round} 輪必修）`}
${p.message}

逐項修改（只動相關鏡頭；共用檔的改動要檢查所有用到的鏡頭），重新輸出 out/video.mp4，同步更新 plan.json（version +1、changelog）。
- 角色的動作一律改 pose 參數（手臂角度、手型、表情）或共用角色定義；**不准在鏡頭裡另外疊畫手臂、手、身體**（會產生肩膀接縫、描邊伸進衣服）。
  需要角色做 rig 做不到的動作，就在共用角色定義新增姿勢或手型，再重截設定圖確認。
- 改完用 hf_frames 截改動處前後 0.5 秒的全解析度畫面，照人眼清單自己看過再交；動作類的修正附 12fps 連續影格（clip_strip.py），不是單張。
- 修到高潮（plan.peaks）的，重做 clip_strip.py 對參考的並排圖，確認我們的爆點不輸參考片。
- 改完重跑 motion_check.py out/video.mp4 --out out/check/motion，確認沒有新的黑格、硬切黑。
- 重新輸出成片時用引擎的快取（render.mjs --frames 只會重渲改過的鏡頭），不要整片刪掉重渲。
- 動到角色（翻轉、配件、姿勢）時，用 12fps 看整鏡，確認配件跟著身體轉、沒有新問題。
${EYE}
**每一項都要附證據**，寫 out/check/fixes.json：
[ { "issue": "…", "shot": "S6", "time": 12.3, "change": "改了什麼", "before": "out/check/fixes/<n>_before.png", "after": "…_after.png", "status": "fixed|cannot" } ]
before 從修改前的成片同一秒抽格、after 從新成片同一秒抽格（全解析度裁切到問題位置），自己打開確認真的改好；做不到的寫 cannot 和原因。
下一輪評審會逐項核對，說修好但沒修好會被原樣退回。`,
};
