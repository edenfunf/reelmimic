// Interface language: 繁體中文 (source text, default) · English · 简体中文.
// The UI is written in Traditional Chinese. Instead of wrapping ~200 strings in t(), a DOM pass translates what React
// renders: English through the table below (exact strings + templates for text with numbers), Simplified Chinese through
// OpenCC (Taiwan → Mainland phrasing), which also converts the AI's own messages. Text the user types is never touched.

import type { Lang } from '../../shared/types.ts';
import type { ConverterFunction } from 'opencc-js/t2cn';

export const LANGS: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'zh-TW', label: '繁體中文', short: '繁' },
  { id: 'zh-CN', label: '简体中文', short: '简' },
];
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };
export let lang: Lang = LANGS.some((l) => l.id === store.get('lang')) ? store.get('lang') as Lang : 'en';   // default for first-time visitors; the menu (top right) remembers a choice

// ---------- English ----------
const EN: Record<string, string> = {
  // shell & home
  '已連線的 AI 導演': 'Connected AI directors', '切換外觀': 'Toggle appearance', '介面語言': 'Language',
  '丟一支喜歡的影片，': 'Drop in a video you love,', '做出同樣風格的新作品。': 'get a new one in the same style.',
  'AI 導演拆解它的剪法與畫面語言，和你一起把腳本、運鏡、素材想清楚，核准後才開始生成，每一段都檢查過才交件。':
    'An AI director breaks down its editing and visual language, works out the script, camera and assets with you, starts rendering only after you approve, and checks every segment before delivering.',
  '拖入參考影片，或點擊選擇': 'Drop a reference video here, or click to choose',
  'mp4 / mov / webm，手機螢幕錄影也可以（會自動裁掉介面）': 'mp4 / mov / webm — phone screen recordings work too (the UI is cropped automatically)',
  '貼連結': 'Paste link', '貼上 YouTube 或影片連結': 'Paste a YouTube or video link', '取消': 'Cancel',
  '參考影片': 'Reference video', '參考影片連結': 'Reference link', '建立專案時自動下載': 'Downloaded when the project is created',
  '你想做什麼樣的影片？主題、長度、角色、想保留參考片的哪些地方…': 'What do you want to make? Topic, length, characters, what to keep from the reference…',
  '換影片': 'Change video', '移除': 'Remove', '素材': 'Assets', '配樂、歌詞、圖片、Logo、自家角色設計圖': 'Music, lyrics, images, logos, your own character designs',
  '開始': 'Start', '未偵測到': 'Not found', '請選擇影片檔（mp4 / mov / webm）': 'Please choose a video file (mp4 / mov / webm)',
  '先拆解與企劃，你核准前不會開始生成 · Ctrl+Enter 送出': 'Analysis and planning come first — nothing renders until you approve · Ctrl+Enter to send',
  '做一支類似風格的 30 秒影片，主軸是愛情，要有好笑的反轉': 'A 30-second video in this style about love, with a funny twist',
  '同樣的剪法，改成介紹我們的新 App': 'Same editing, but introducing our new app',
  '保留節奏和轉場，主題換成親情，直式 9:16': 'Keep the rhythm and transitions, make it about family, vertical 9:16',
  '把我的小故事畫成 Q 版漫畫，第一人稱旁白': 'Draw my little story as a chibi comic with first-person narration',
  '拆解風格': 'Break down the style', '剪法、節奏、轉場、畫面語言逐鏡量測': 'Cuts, pacing, transitions and visual language measured shot by shot',
  '選製作技能': 'Pick a production skill', '判斷畫風，交給對應的製作 skill': 'Identify the look and hand it to the matching skill',
  '前製企劃': 'Pre-production', '分鏡、運鏡、素材、定調畫面，和你來回對焦': 'Storyboard, camera, assets and style frames, refined with you',
  '關卡審查': 'Gated review', '角色、每一段都即時檢查，過關才往下做': 'Characters and every segment are checked as they are made',
  '專案': 'Projects', '剛剛': 'just now',
  // status
  '排隊中': 'Queued', '拆解中': 'Analyzing', '判斷風格': 'Styling', '風格完成': 'Styled', '企劃中': 'Planning', '等你確認企劃': 'Awaiting your approval',
  '修改企劃': 'Revising plan', '生產中': 'Producing', '等你提供': 'Needs your input', '評審中': 'Reviewing', '修改中': 'Revising', '完成': 'Done', '需要處理': 'Needs attention',
  // progress & tabs
  '參考片': 'Reference', '風格拆解': 'Style', '生產': 'Production', '成品': 'Final', '生產線': 'Production line', '企劃': 'Plan', '參考片拆解': 'Reference analysis',
  '待確認': 'Needs approval', '停止': 'Stop', '過程即時顯示在右側對話': 'Live progress is shown in the conversation on the right',
  '拆解參考片': 'Analyzing the reference', '判斷風格與製作技能': 'Choosing the style and production skill', '寫前製企劃': 'Writing the plan', '寫企劃': 'Writing the plan',
  '修改成片': 'Revising the film', '審片': 'Reviewing the film',
  '導演建置角色與共用素材': 'Director is setting up characters and shared assets', '角色關：審查角色設定圖': 'Cast gate: reviewing character sheets',
  '分段製作，每段做完立刻審查': 'Building segments, each reviewed as soon as it is done', '組裝成片': 'Assembling the film', '最後評審：接縫、連戲、節奏': 'Final review: seams, continuity, pacing',
  '還沒有內容': 'Nothing here yet', '拆解開始後，結果會出現在這裡。': 'Results appear here once analysis starts.',
  // analysis
  'Step 1': 'Step 1', '展開': 'Expand', '收起': 'Collapse', '判定風格': 'Detected style', '製作技能': 'Production skill', '鏡頭數': 'Shots',
  '平均鏡頭長度': 'Average shot', '已自動裁出畫面': 'Picture auto-cropped', '無聲': 'No audio', '靜音': 'Silent', '每秒一格': 'One frame per second', '每個鏡頭': 'One frame per shot',
  '完整風格拆解 STYLE.md': 'Full style breakdown (STYLE.md)',
  // plan
  '畫面': 'Look', '色彩弧線：': 'Color arc: ', '從參考片學到的手法': 'Techniques borrowed from the reference', '定調畫面': 'Style frames', '角色': 'Characters',
  '分鏡與運鏡': 'Storyboard & camera', '顯示全部': 'Show all', '動作': 'Action', '運鏡': 'Camera', '對照參考': 'Reference shot', '轉場': 'Transition',
  '觀眾讀到': 'Viewer reads', '字幕／字卡': 'Captions / cards', '授權紀錄': 'License log', '需要你決定': 'Your call', '回答': 'Answer', '修改紀錄：': 'Changelog: ',
  '你提供的': 'Provided by you', '待抓取': 'To fetch', '網路取得': 'Fetched online', '程式繪製': 'Drawn in code', '待生成': 'To generate', '原創': 'Original', '授權未填': 'No license info',
  '需要你提供的素材': 'Inputs only you can provide', '全部提供或略過之後才能核准，生產中不會再卡在這裡。': 'Provide or skip each one before approving — production will not stall on them later.',
  '已提供': 'Provided', '已略過': 'Skipped', '上傳': 'Upload', '略過': 'Skip', '上傳檔案': 'Upload files', '上傳中': 'Uploading',
  '歌詞': 'Lyrics', '音檔': 'Audio', '圖片': 'Image', '文字': 'Text', '檔案': 'File', '歌詞字幕': 'Lyric subtitles',
  '對時完成': 'Timing done', '歌詞已存，配樂確定後會自動對時': 'Lyrics saved — they will be timed once the music is set', '對時失敗，請看右側紀錄': 'Timing failed — see the log on the right',
  '重新對時': 'Re-time', '自動對時': 'Auto-time', '對時中，約 1 分鐘': 'Timing… about a minute', '用前後插值': 'interpolated',
  '企劃看起來 OK 嗎？': 'Does the plan look good?', '核准並開始生成': 'Approve and start',
  '有意見就在右邊說，AI 改完再給你看；核准後才開始生成。': 'Comment on the right and the AI will revise it; rendering starts only after you approve.',
  '對 ': 'Comment on ',
  // production line
  '建置': 'Setup', '角色關': 'Cast gate', '分段製作': 'Segments', '組裝': 'Assembly', '最後評審': 'Final review', '角色設定圖': 'Character sheets',
  '已通過': 'Passed', '審查中': 'Reviewing', '導演修正中': 'Director fixing', '未通過': 'Not passed', '分段': 'Segments',
  '製作中': 'Building', '修正中': 'Fixing', '通過': 'Passed', '錯誤': 'Error', '導演改共用檔': 'Director fixing shared files', '做好了，等角色關': 'Built — waiting for cast gate', '等導演改骨架': 'Waiting for rig fix',
  // needs / error cards
  '暫停中：需要你決定': 'Paused: your decision needed', '照審查全部修': 'Fix everything the reviewers flagged', '角色可以了，開始做鏡頭': 'Characters are fine — start the shots',
  '可以了，直接組裝': 'Good enough — assemble', '或在右邊直接跟導演說': 'or tell the director on the right', '在右邊告訴導演要怎麼處理，或直接繼續。': 'Tell the director what to do on the right, or just continue.',
  '已處理，繼續生產': 'Done — continue production', '繼續生產': 'Continue production',
  '審查員還看到下面這些問題。你可以讓導演照著全部修，或覺得已經夠好就直接開始做鏡頭。': 'The reviewers still see the issues below. Have the director fix them all, or start the shots if it is good enough.',
  '從這裡繼續': 'Continue from here', '再試一次': 'Try again', '技術細節': 'Technical details',
  '檔案保留在停下來的地方，可以從這裡繼續。': 'Files are kept where it stopped; you can continue from here.',
  '做到一半的檔案都還在，繼續會從目前的檔案接著做。': 'Work in progress is kept; continuing picks up from the current files.',
  'AI 這一輪出錯了。可以再跑一次，或在右邊說明要怎麼處理。': 'This AI turn failed. Run it again, or explain on the right how to handle it.',
  '這裡的畫面顯示不出來': 'This part of the page could not be shown', '重新載入': 'Reload', '完整紀錄': 'Full log',
  '伺服器上的工作和檔案都不受影響。可以重新載入；回報問題時請附上技術細節。': 'Work on the server and your files are not affected. Try reloading, and include the technical details if you report it.',
  // result
  '影片': 'Video', '下載 MP4': 'Download MP4', '看到哪裡想改，直接在這裡打（影片會自動停在這一格）': 'Type a change right here — the video pauses on this frame',
  '記下': 'Add note', '回到這個時間點': 'Back to this moment', '目前時間': 'Current time', '全部清除': 'Clear all', '跳到這裡': 'Jump here', '刪除': 'Delete',
  '導演會一次改完這些地方，改完再由獨立評審檢查一輪。': 'The director fixes all of these at once; an independent reviewer checks again afterwards.',
  'AI 還在工作，記下的修改會保留，這一輪完成後再送出。': 'The AI is still working — your notes are kept; send them when this turn finishes.',
  '獨立評審': 'Independent critic', '或在上方影片時間軸自己標要改的地方': 'or mark spots on the timeline above yourself', '全片': 'Whole film',
  '開場': 'Opening', '畫面質感': 'Look & texture', '構圖': 'Composition', '瑕疵': 'Defects', '字幕標題': 'Captions & titles', '節奏連戲': 'Pacing & continuity', '光線材質': 'Light & material', '標題': 'Titles', '節奏': 'Pacing',
  // conversation
  'AI 導演': 'AI director', '對話': 'Chat', '紀錄': 'Log', '你的需求': 'Your brief', '工作中': 'Working', '獨立審查': 'Independent review', '系統': 'System', '審查員': 'Reviewer',
  '角色審查': 'Cast review', '思考了': 'Thought for', '個步驟': 'steps', '顯示前面': 'Show earlier', '（見附件）': '(see attachments)',
  '對企劃提意見，例如：S3 的轉場想更誇張…': 'Comment on the plan, e.g. make the S3 transition bigger…',
  '對成片提意見，例如：12 秒那裡太快看不懂…': 'Comment on the film, e.g. too fast to follow at 12 s…',
  '告訴導演怎麼處理，或補充說明…': 'Tell the director what to do, or add details…', '說明要怎麼處理這個問題…': 'Explain how to handle this…',
  '企劃還在寫，可以先補充想法，導演會一併放進企劃…': 'The plan is still being written — add ideas now and the director will fold them in…', '網站已更新，點這裡重新整理': 'ReelMimic was updated — click to refresh', '請上傳參考影片或貼上影片連結': 'Upload a reference video or paste a link', 'agent 正在工作中，請等這一輪完成': 'The agent is working — wait for this turn to finish', '請貼上歌詞文字': 'Paste the lyrics text', '需求文字編碼錯誤（請用 UTF-8 送出）': 'The text encoding is wrong (send it as UTF-8)', 'AI 帳號的用量到上限了': 'Your AI account hit its usage limit', '等額度恢復，或換另一個 AI 導演，再從這裡繼續；做到一半的檔案都還在。': 'Wait until it resets, or switch to the other AI director, then continue from here. Work in progress is kept.', '審查輪數': 'Review rounds', '每一關最多審查、修改幾輪': 'How many review/fix rounds each step may take', '每段鏡頭': 'Each part', '每個角色最多審幾輪': 'Max rounds per character', '每段最多審幾輪': 'Max rounds per part', '自動修改最多幾輪': 'Max automatic revision rounds', '· 預設': '· default', '已自動儲存': 'Saved', '做到一半也可以改，從下一次檢查開始生效。': 'You can change this mid-production; it applies from the next check.', '到了上限還沒通過，會暫停請你決定，不會一直來回修改。輪數多，品質有機會更好，但時間和 AI 用量也會增加。': 'When a limit is reached, the job pauses and asks you instead of looping. More rounds can mean better quality, but also more time and AI usage.', '減少': 'Decrease', '增加': 'Increase', '這些只有你能給。提供或略過之後才能核准企劃，生產中不會再卡在這裡。': 'Only you can provide these. Add or skip them to approve the plan; production won’t stop for them later.', '都處理好了。': 'All set.', '復原': 'Undo', '更換': 'Replace', '上傳音檔': 'Upload audio', '上傳圖片': 'Upload image', '上傳文字': 'Upload text', '上傳 .txt / .lrc': 'Upload .txt / .lrc', '已上傳': 'Uploaded', '去提供': 'Go provide', '歌詞已存，收到配樂後會自動對時': 'Lyrics saved; they will be timed as soon as the music arrives', '恢復預設': 'Reset to defaults', '貼上歌詞': 'Paste lyrics', 'AI 工作中，這一輪完成後就可以說話': 'The AI is working — you can talk once this turn finishes',
  'Enter 送出 · Shift+Enter 換行 · 圖片可以直接貼上或拖進來': 'Enter to send · Shift+Enter for a new line · paste or drop images',
  '附加檔案': 'Attach files', '附加圖片或檔案（也可以直接貼上或拖進來）': 'Attach images or files (you can also paste or drop them)', '送出': 'Send',
  '全部 agent': 'All agents', '搜尋紀錄': 'Search log', '下載紀錄': 'Download log', '沒有紀錄': 'No log entries', '完整紀錄在': 'full log in',
  '查看影格': 'Viewing frames', '閱讀': 'Reading', '寫入': 'Writing', '修改': 'Editing', '尋找檔案': 'Finding files', '搜尋': 'Searching',
  '載入技能': 'Loading skill', '讀取網頁': 'Reading web page', '搜尋網路': 'Web search', '整理待辦': 'Updating todos', '派出子任務': 'Starting subtask',
  '執行指令': 'Running command', '執行': 'Running', '渲染全部影格': 'Rendering all frames', '輸出審查影格': 'Rendering review frames', '編碼成影片': 'Encoding video',
  '渲染影片': 'Rendering video', '檢查動畫檔': 'Checking composition', '和參考片並排比較': 'Comparing with the reference', '分析影片': 'Analyzing video',
  '歌詞對時': 'Timing lyrics', '搜尋授權素材': 'Searching licensed assets', '讀取影片資訊': 'Reading video info', 'FFmpeg 處理影音': 'FFmpeg processing',
  '截圖檢查': 'Taking screenshots', '安裝套件': 'Installing packages', '下載影片': 'Downloading video', '查看檔案': 'Listing files', '執行 Python': 'Running Python', '執行 Node': 'Running Node',
  '設計角色': 'Designing a character', '抓素材': 'Fetching assets', '整合素材、畫定調畫面': 'Merging assets, painting style frames', '寫企劃核心（分鏡、旁白、素材清單）': 'Writing the plan core (storyboard, narration, asset list)',
  '建置角色與共用素材': 'Setting up characters and shared assets', '檢查角色設定圖': 'Checking character sheets', '修正角色': 'Fixing a character', '製作鏡頭': 'Building shots',
  '逐格檢查鏡頭': 'Checking shots frame by frame', '修正鏡頭': 'Fixing shots',
  '這一輪因為伺服器重新啟動而中斷。': 'This turn was cut off by a server restart.',
  '▶ 開始': '▶ start', '■ 完成': '■ done', '■ 失敗': '■ failed',
};
// text with numbers / names in it
const EN_RE: [RegExp, string][] = [
  [/^(\d+) 秒$/, '$1 s'], [/^(\d+) 分 (\d+) 秒$/, '$1 min $2 s'], [/^(\d+) 小時 (\d+) 分$/, '$1 h $2 min'],
  [/^(\d+) 分鐘前$/, '$1 min ago'], [/^(\d+) 小時前$/, '$1 h ago'], [/^(\d+) 天前$/, '$1 d ago'],
  [/^(\d+) 項必修$/, '$1 must-fix'], [/^· (\d+) 項待你提供$/, '· $1 need your input'], [/^(\d+) 張$/, '$1 frames'], [/^張$/, 'frames'],
  [/^(\d+) 個 agent 同時工作中$/, '$1 agents working'], [/^· (\d+) 個 agent 同時工作$/, '· $1 agents working'],
  [/^· 第 (\d+) 輪$/, '· round $1'], [/^第 (\d+) 輪$/, 'round $1'], [/^第$/, 'round'], [/^輪審查$/, 'review'], [/^輪$/, ''],
  [/^平均鏡頭 · ([\d.]+) 拍$/, 'avg shot · $1 beats'], [/^鏡$/, 'shots'], [/^項$/, 'items'], [/^筆 · 完整紀錄在$/, 'entries · full log in'], [/^顯示最近$/, 'Showing the latest'],
  [/^顯示全部 (\d+) 項$/, 'Show all $1'], [/^句 · 平均匹配$/, 'lines · avg match'], [/^段通過 · 每段做完立刻由獨立審查員檢查$/, 'segments passed · each reviewed as soon as it is built'],
  [/^每鏡審查影格 ·$/, 'Review frames per shot ·'], [/^照評審的$/, 'Fix the critic’s'], [/^項全部修$/, 'items'], [/^還有 (\d+) 項，在「生產線」分頁$/, '$1 more in the Production line tab'],
  [/^製作 (.+)$/, 'Builder $1'], [/^鏡頭審查 (.+)$/, 'Shot review $1'], [/^角色審查 (.+)$/, 'Cast review $1'], [/^角色修正 (.+)$/, 'Cast fix $1'],
  [/^針對 (\S+) 秒$/, 'At $1 s'], [/^針對 (.+)$/, 'On $1'], [/^回答：(.+)$/, 'Answer: $1'], [/^對 (\S+) 提意見$/, 'Comment on $1'],
  [/^送出 (\d+) 則修改$/, 'Send $1 notes'], [/^要修改的地方 · (\d+)$/, 'Changes · $1'], [/^還差 (\d+) 項素材$/, '$1 inputs missing'],
  [/^請先提供或略過：(.+)$/, 'Provide or skip first: $1'], [/^你停止了「(.+)」$/, 'You stopped “$1”'], [/^「(.+)」被伺服器重啟打斷$/, '“$1” was cut off by a server restart'],
  [/^「(.+)」沒有完成$/, '“$1” did not finish'], [/^角色關審了 (\d+) 輪還沒通過$/, 'Cast gate still failing after $1 rounds'], [/^(\d+) 段鏡頭審了幾輪還沒通過$/, '$1 segments still failing after several rounds'],
  [/^沒過的段落：(.+)。詳細審查意見在「生產線」分頁。$/, 'Failing segments: $1. Details in the Production line tab.'],
  [/^AI 這一輪結束了，但沒有產出應有的檔案（(.+)）。通常再跑一次就會好；也可以在右邊說明要怎麼處理。$/, 'The AI finished its turn but did not produce $1. Running it again usually works; or explain on the right how to handle it.'],
  [/^前製企劃 · v$/, 'Pre-production · v'], [/^(\d+) 句 · 平均匹配 (\d+)%$/, '$1 lines · avg match $2%'],
  [/^還有需要你提供或略過的素材：(.+)$/, 'Still needs your input or a skip: $1'],
  [/^· 預設 (\d+)$/, '· default $1'], [/^· 第 (\d+) \/ (\d+) 輪$/, '· round $1 / $2'],
  [/^需要你提供 (\d+) 項素材$/, 'Needs $1 input(s) from you'],
  [/^速度 (.+)$/, 'pace $1'], [/^主體 (.+)$/, 'subject $1'], [/^進：(.+)$/, 'in: $1'], [/^出：(.+)$/, 'out: $1'], [/^評審：(.+)$/, 'Critic: $1'],
];

// ---------- Simplified Chinese ----------
// the Traditional→Simplified dictionary (~0.3 MB) is loaded only when someone picks 简体中文
let toCN: ConverterFunction | null = null, loadingCN: Promise<void> | null = null;
const loadCN = () => loadingCN || (loadingCN = import('opencc-js/t2cn').then((m) => { toCN = m.Converter({ from: 'tw', to: 'cn' }); }));
const cn = (s: string) => (toCN ? toCN(s) : s);

function translate(text: string) {
  if (lang === 'zh-TW' || !/[㐀-鿿]/.test(text)) return text;
  if (lang === 'zh-CN') return cn(text);
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!, core = m[2];
  if (EN[core] != null) return m[1] + EN[core] + m[3];
  for (const [re, rep] of EN_RE) if (re.test(core)) return m[1] + core.replace(re, rep) + m[3];
  return text;   // AI-written content and anything unlisted stays as written
}

// ---------- DOM pass ----------
const ATTRS = ['placeholder', 'title', 'aria-label'];
const SKIP = 'textarea, input, code, pre, script, style, [data-no-i18n]';
type TrText = Text & { __tr?: string; __orig?: string };
type TrEl = Element & { __o?: Record<string, string>; __t?: Record<string, string> };
function fixText(n: TrText) {
  if (!n.data || !n.parentElement || n.parentElement.closest(SKIP)) return;
  if (n.__tr !== n.data) n.__orig = n.data;          // React (or anything) wrote new source text
  const out = translate(n.__orig!);
  if (n.data !== out) n.data = out;
  n.__tr = out;
}
function fixAttrs(el: TrEl) {
  if (el.closest && el.closest('[data-no-i18n]')) return;
  el.__o = el.__o || {}; el.__t = el.__t || {};
  for (const a of ATTRS) {
    const v = el.getAttribute(a); if (v == null) continue;
    if (el.__t[a] !== v) el.__o[a] = v;
    const out = translate(el.__o[a]);
    if (v !== out) el.setAttribute(a, out);
    el.__t[a] = out;
  }
}
function walk(node: Node) {
  if (node.nodeType === 3) return fixText(node as TrText);
  if (node.nodeType !== 1) return;
  const root = node as Element;
  if (root.hasAttribute && ATTRS.some((a) => root.hasAttribute(a))) fixAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n: Node | null; (n = w.nextNode());) n.nodeType === 3 ? fixText(n as TrText) : ATTRS.some((a) => (n as Element).hasAttribute(a)) && fixAttrs(n as Element);
}
let obs: MutationObserver;
export async function startI18n() {
  document.documentElement.lang = lang;
  if (lang === 'zh-CN') await loadCN();
  walk(document.body);
  obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') fixText(m.target as TrText);
      else if (m.type === 'attributes') fixAttrs(m.target as Element);
      else m.addedNodes.forEach(walk);
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
const listeners = new Set<(id: Lang) => void>();
export const onLang = (fn: (id: Lang) => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export async function setLang(id: Lang) {
  if (id === 'zh-CN') await loadCN();
  lang = id; store.set('lang', id); document.documentElement.lang = id;
  walk(document.body); listeners.forEach((fn) => fn(id));
}
