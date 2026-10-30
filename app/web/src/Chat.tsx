import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Job, LogEvent, Stage } from '../../shared/types.ts';
import { api } from './api.ts';
import { I, Orb, Md, AutoText, Seg, useNow, dur, clock } from './ui.tsx';
import type { IconName } from './ui.tsx';
import type { MessageMeta, SnapshotView, Tag } from './types.ts';

// ---------- who is talking ----------
export const whoName = (w?: string) => {
  if (!w || w === '_') return '系統';
  if (w === 'director') return 'AI 導演';
  if (w === 'critic') return '獨立評審';
  if (w === 'cast-qa') return '角色審查';
  if (w === 'reviewer') return '審查員';
  if (w === 'assets') return '素材';
  let m = w.match(/^cast-qa-(.+)/); if (m) return `角色審查 ${m[1]}`;
  m = w.match(/^cast-(.+)/); if (m) return `角色修正 ${m[1]}`;
  m = w.match(/^builder-(.+)/); if (m) return `製作 ${m[1]}`;
  m = w.match(/^shot-qa-(.+)/); if (m) return `鏡頭審查 ${m[1]}`;
  return w;
};
type Kind = 'builder' | 'critic' | 'director';
const whoKind = (w: string | undefined, role: ChatMessage['role']): Kind => (role === 'builder' || /^builder|^cast-(?!qa)/.test(w || '') ? 'builder' : role === 'critic' || /qa|critic|reviewer/.test(w || '') ? 'critic' : 'director');
const PHASE_DO: Record<string, string> = { pre_cast: '設計角色', pre_assets: '抓素材', plan_frames: '整合素材、畫定調畫面', style: '判斷風格與製作技能', plan: '寫企劃核心（分鏡、旁白、素材清單）', replan: '修改企劃', setup: '建置角色與共用素材', cast_qa: '檢查角色設定圖', cast_fix: '修正角色', build_chunk: '製作鏡頭', shot_qa: '逐格檢查鏡頭', fix_chunk: '修正鏡頭', assemble: '組裝成片', critique: '審片', revise: '修改成片' };
export const STAGE_DO: Partial<Record<Stage, string>> = { analyzing: '拆解參考片', styling: '判斷風格與製作技能', planning: '寫前製企劃', replanning: '修改企劃', producing: '生產中', revising: '修改成片', critiquing: '審片' };

// ---------- merge chat + activity log: each AI message gets the steps that led to it; unfinished work becomes live cards ----------
// one agent's turn: the steps it took, open until the turn ends or it replies
export type Turn = { start: string; steps: LogEvent[]; phase?: string; who: string; ended?: string; ok?: boolean; last?: string };
export type Think = Turn & { end: string };
export function buildThread(job: Job) {
  const chat = job.chat || [], log = job.log || [];
  const items = [...chat.map((m) => ({ k: 'm' as const, ts: m.ts || '', m })), ...log.map((e) => ({ k: 'e' as const, ts: e.ts || '', e }))]
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.k === 'e' ? -1 : 1));
  const buf: Record<string, Turn> = {}, out: { m: ChatMessage; think?: Think | null }[] = [];
  for (const it of items) {
    if (it.k === 'e') {
      const e = it.e, w = e.who || '_';
      if (e.type === 'session' || e.type === 'done' || e.type === 'notify') continue;   // notifications aren't agent steps
      if (e.type === 'turn') {
        if (e.state === 'start') buf[w] = { start: e.ts, steps: [], phase: e.phase, who: w };
        else if (buf[w]) { buf[w].ended = e.ts; buf[w].ok = e.ok; }
        continue;
      }
      if (!buf[w] || buf[w].ended) buf[w] = { start: e.ts, steps: [], who: w };
      buf[w].steps.push(e); buf[w].last = e.ts;
    } else {
      const m = it.m;
      if (['agent', 'critic', 'builder'].includes(m.role)) {
        const w = m.who || '_', b = buf[w]; delete buf[w];
        const steps = (b?.steps || []).filter((s) => !(s.type === 'text' && s.text?.trim() === m.text?.trim()));
        out.push({ m, think: b && steps.length ? { ...b, steps, end: m.ts } : null });
      } else out.push({ m });
    }
  }
  const working = !!STAGE_DO[job.stage];
  // with turn markers only real agent turns are live; older logs fall back to "recent activity without a reply"
  const marked = log.some((e) => e.type === 'turn'), named = log.some((e) => e.who);
  const live = working ? Object.values(buf).filter((b) => !b.ended && !(named && b.who === '_') && (marked ? b.phase : b.steps.length && Date.now() - new Date(b.last || b.start).getTime() < 20 * 60e3))
    .sort((a, b) => (a.start < b.start ? -1 : 1)) : [];
  return { out, live };
}

// ---------- steps ----------
const TOOL: Record<string, [IconName, string]> = {
  Bash: ['term', '執行'], shell: ['term', '執行'], PowerShell: ['term', '執行'], Read: ['doc', '閱讀'], Write: ['pencil', '寫入'], Edit: ['pencil', '修改'],
  MultiEdit: ['pencil', '修改'], edit: ['pencil', '修改'], Glob: ['search', '尋找檔案'], Grep: ['search', '搜尋'], Skill: ['wand', '載入技能'],
  WebFetch: ['globe', '讀取網頁'], WebSearch: ['globe', '搜尋網路'], TodoWrite: ['check', '整理待辦'], Task: ['layers', '派出子任務'], Agent: ['layers', '派出子任務'],
};
const IMG = /\.(jpe?g|png|webp)$/i;
const CMD: [RegExp, string][] = [
  [/render\.mjs[^\n]*--frames/, '渲染全部影格'], [/render\.mjs[^\n]*(--sheet|--strip)/, '輸出審查影格'], [/render\.mjs[^\n]*(--encode|--clip)/, '編碼成影片'],
  [/hyperframes[^\n]*render/, '渲染影片'], [/hyperframes[^\n]*(lint|check)/, '檢查動畫檔'], [/compare\.py/, '和參考片並排比較'], [/analyze\.py/, '分析影片'],
  [/align_lyrics/, '歌詞對時'], [/fetch_assets/, '搜尋授權素材'], [/ffprobe/, '讀取影片資訊'], [/ffmpeg/, 'FFmpeg 處理影音'],
  [/shot\.mjs|puppeteer|screenshot/, '截圖檢查'], [/npm (i|install|ci)\b/, '安裝套件'], [/pip install/, '安裝套件'], [/yt_dlp|yt-dlp/, '下載影片'],
  [/\b(ls|dir|find|Get-ChildItem)\b/, '查看檔案'], [/\bpython\b/, '執行 Python'], [/\bnode\b/, '執行 Node'],
];
const cmdLabel = (c: string) => (CMD.find(([re]) => re.test(c)) || [null, '執行指令'])[1];
function relPath(id: string, d: unknown) {
  const s = String(d || '').replace(/\\/g, '/');
  const m = s.match(new RegExp(`projects/${id}/(.+)$`)); if (m) return { rel: m[1], inProject: true };
  const r = s.match(/\/((?:\.claude|app|docs|projects)\/.+)$/); return { rel: r ? r[1] : s, inProject: false };
}
type Step = { kind: 'frames'; ico: IconName; verb: string; det: string; n: number; thumbs: string[]; ts: string }
  | { kind: 'tool'; ico: IconName; verb: string; det: string; ts: string; n?: undefined; thumbs?: undefined }
  | { kind: 'thought'; text: string; ts: string } | { kind: 'err'; text: string; ts: string };
function toSteps(id: string, raw: LogEvent[]) {
  const out: Step[] = [];
  for (const e of raw) {
    if (e.type === 'tool') {
      const [ico, verb]: [IconName, string] = TOOL[e.name] || ['term', e.name];
      const p = relPath(id, e.detail);
      if (e.name === 'Read' && IMG.test(p.rel)) {
        const prev = out[out.length - 1];
        const thumb = p.inProject ? api.file(id, p.rel) : null;
        if (prev?.kind === 'frames') { prev.n++; if (thumb && prev.thumbs.length < 6) prev.thumbs.push(thumb); prev.det = p.rel; continue; }
        out.push({ kind: 'frames', ico: 'eye', verb: '查看影格', det: p.rel, n: 1, thumbs: thumb ? [thumb] : [], ts: e.ts });
        continue;
      }
      const isCmd = ['Bash', 'shell', 'PowerShell'].includes(e.name);
      out.push({ kind: 'tool', ico, verb: isCmd ? cmdLabel(String(e.detail || '')) : verb, det: isCmd ? String(e.detail || '') : p.rel, ts: e.ts });
    } else if (e.type === 'text' || e.type === 'thinking') out.push({ kind: 'thought', text: e.text, ts: e.ts });
    else if (e.type === 'error') out.push({ kind: 'err', text: e.text, ts: e.ts });
  }
  return out;
}
type Zoom = (src: string) => void;
function Steps({ id, raw, live, limit, onZoom }: { id: string; raw: LogEvent[]; live?: boolean; limit?: number; onZoom?: Zoom }) {
  const now = useNow(!!live);
  const all = useMemo(() => toSteps(id, raw), [id, raw.length, raw[raw.length - 1]?.ts]);
  const [more, setMore] = useState(false);
  const shown = limit && !more ? all.slice(-limit) : all;
  return (
    <div className="think-body">
      {limit && !more && all.length > limit && <button className="more-steps" onClick={() => setMore(true)}>顯示前面 {all.length - limit} 個步驟</button>}
      {shown.map((s, i) => {
        const isLive = live && i === shown.length - 1;
        if (s.kind === 'thought') return <div key={i} className={`step thought ${isLive ? 'live' : ''}`}><span className="txt">{s.text}</span></div>;
        if (s.kind === 'err') return <div key={i} className="step err"><span className="verb">錯誤</span><span className="det">{s.text}</span></div>;
        return (
          <div key={i} className={`step ${isLive ? 'live' : ''}`}>
            <span className="verb"><I n={s.ico} style={{ marginRight: 5, color: 'var(--label-3)' }} />{s.verb}{s.n && s.n > 1 ? ` ${s.n} 張` : ''}</span>{isLive && s.ts && <span className="step-t">{clock(now - new Date(s.ts).getTime())}</span>}
            <span className="det" title={s.det}>{s.det}</span>
            {s.thumbs && s.thumbs.length > 0 && <div className="thumbs">{s.thumbs.map((t) => <img key={t} src={t} loading="lazy" onClick={() => onZoom?.(t)} onError={(e) => (e.currentTarget.style.display = 'none')} />)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function Thinking({ id, t, onZoom }: { id: string; t: Think; onZoom?: Zoom }) {
  const [open, setOpen] = useState(false);
  const ms = new Date((t.end || t.ended || t.last)!).getTime() - new Date(t.start).getTime();
  const n = toSteps(id, t.steps).length;
  return (
    <div className="think">
      <button className="think-h" onClick={() => setOpen(!open)}>
        <I n="spark" className="spark" /><span>思考了 {dur(ms)}</span><span className="n">· {n} 個步驟</span><I n="chev" className={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && <Steps id={id} raw={t.steps} onZoom={onZoom} />}
    </div>
  );
}

function LiveCard({ id, b, stage, onZoom }: { id: string; b: Turn; stage: Stage; onZoom?: Zoom }) {
  const now = useNow(true);
  const [open, setOpen] = useState(true);
  const doing = PHASE_DO[b.phase ?? ''] || STAGE_DO[stage] || '工作中';
  return (
    <div className="livecard">
      <div className="lc-h">
        <Orb size={20} live />
        <button className="row" style={{ gap: 6 }} onClick={() => setOpen(!open)}>
          <b className="shimmer">{whoName(b.who)} · {doing}</b><I n="chev" className={`chev ${open ? 'open' : ''}`} style={{ color: 'var(--label-3)' }} />
        </button>
        <span className="elapsed">{clock(now - new Date(b.start).getTime())}</span>
      </div>
      {open && b.steps.length > 0 && <Steps id={id} raw={b.steps} live limit={4} onZoom={onZoom} />}
    </div>
  );
}

const Avatar = ({ kind }: { kind: Kind }) => kind === 'director' ? <Orb size={26} idle /> : <div className={`avatar-ai ${kind}`}><I n={kind === 'critic' ? 'mag' : 'film'} /></div>;

// ---------- the conversation panel ----------
export function Conversation({ id, s, tag, setTag, onZoom }: { id: string; s: SnapshotView; tag: Tag | null; setTag: (t: Tag | null) => void; onZoom?: Zoom }) {
  const job = s.job, [text, setText] = useState(''), [err, setErr] = useState(''), [sending, setSending] = useState(false);
  const [files, setFiles] = useState<{ f: File; url: string | null }[]>([]), [drag, setDrag] = useState(false), pick = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | File[] | null) => { const L = [...(list || [])].filter((f) => f.size < 200 * 1024 ** 2); if (L.length) setFiles((x) => [...x, ...L.map((f) => ({ f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null }))].slice(0, 10)); };
  const onPaste = (e: React.ClipboardEvent) => { const L = [...(e.clipboardData?.files || [])]; if (L.length) { e.preventDefault(); addFiles(L); } };
  const box = useRef<HTMLDivElement>(null), stick = useRef(true), [tab, setTab] = useState<'chat' | 'log'>('chat');
  const { out, live } = useMemo(() => buildThread(job), [job.chat?.length, job.log?.length, job.stage, job.log?.[job.log.length - 1]?.ts]);
  const canTalk = ['plan_review', 'done', 'error', 'needs_input', 'new', 'analyzing', 'styling', 'styled', 'planning', 'replanning'].includes(job.stage);
  const working = !!STAGE_DO[job.stage];
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [out.length, live.length, job.log?.length]);
  const onScroll = () => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
  const send = async () => {
    if ((!text.trim() && !files.length) || !canTalk) return; setErr(''); setSending(true);
    const meta: MessageMeta = tag ? { ...(tag.shot && { shot: tag.shot }), ...(tag.time != null && { time: tag.time }) } : {};
    const t = tag?.q ? `關於「${tag.q}」：${text}` : text || '（見附件）';
    try {
      if (files.length) { const fd = new FormData(); files.forEach((x) => fd.append('inputs', x.f)); meta.attachments = (await api.addInputs(id, fd, 'attachments')).saved; }
      await api.message(id, t, meta); setText(''); setTag(null); files.forEach((x) => x.url && URL.revokeObjectURL(x.url)); setFiles([]); stick.current = true;
    } catch (e) { setErr((e as Error).message); }
    setSending(false);
  };
  const hint = job.stage === 'plan_review' ? '對企劃提意見，例如：S3 的轉場想更誇張…' : job.stage === 'done' ? '對成片提意見，例如：12 秒那裡太快看不懂…' : job.stage === 'needs_input' ? '告訴導演怎麼處理，或補充說明…' : job.stage === 'error' ? '說明要怎麼處理這個問題…' : ['new', 'analyzing', 'styling', 'styled', 'planning', 'replanning'].includes(job.stage) ? '企劃還在寫，可以先補充想法，導演會一併放進企劃…' : 'AI 工作中，這一輪完成後就可以說話';
  return (
    <aside className="convo">
      <div className="convo-h">
        <Orb size={30} live={working} idle={!working} />
        <div className="grow"><b>AI 導演</b><div className="sub">{job.agent === 'codex' ? 'Codex' : 'Claude Code'}{working && <><span>·</span><span className="dot live" />{live.length > 1 ? `${live.length} 個 agent 同時工作中` : '工作中'}</>}</div></div>
        <Seg value={tab} onChange={setTab} options={[{ value: 'chat', label: '對話' }, { value: 'log', label: '紀錄' }]} />
      </div>
      {tab === 'log' ? <LogView id={id} job={job} /> : <>
      <div className="msgs" ref={box} onScroll={onScroll}>
        <div className="m-brief m"><div className="eyebrow">你的需求</div>{s.brief}</div>
        {out.map(({ m, think }, i) => {
          if (m.role === 'user') return <div key={i} className="m m-user">{(m.shot || m.time != null) && <div className="meta">{m.shot ? `針對 ${m.shot}` : `針對 ${Number(m.time).toFixed(1)} 秒`}</div>}
            {(m.attachments || []).length > 0 && <div className="m-att">{m.attachments?.map((a) => /\.(png|jpe?g|webp|gif)$/i.test(a)
              ? <img key={a} src={api.file(id, a)} onClick={() => onZoom?.(api.file(id, a))} />
              : <a key={a} className="att-file" href={api.file(id, a)} target="_blank" rel="noreferrer"><I n="doc" />{a.split('/').pop()!.replace(/^[a-z0-9]+_/, '')}</a>)}</div>}
            {m.text === '（見附件）' && (m.attachments || []).length ? null : m.text.replace(/^［[^］]+］/, '')}</div>;
          if (m.role === 'system') return <div key={i} className="m m-sys"><I n="spark" style={{ color: 'var(--accent-ink)' }} />{m.text}</div>;
          const kind = whoKind(m.who, m.role);
          return (
            <div key={i} className="m m-ai">
              <Avatar kind={kind} />
              <div style={{ minWidth: 0 }}>
                <div className="who">{whoName(m.who || (m.role === 'critic' ? 'critic' : 'director'))}{kind !== 'director' && <span className="role">{kind === 'critic' ? '獨立審查' : '製作'}</span>}</div>
                {think && <Thinking id={id} t={think} onZoom={onZoom} />}
                <Md src={m.text} />
              </div>
            </div>
          );
        })}
        {live.map((b) => <LiveCard key={b.who + b.start} id={id} b={b} stage={job.stage} onZoom={onZoom} />)}
        {working && !live.length && <div className="livecard"><div className="lc-h"><Orb size={20} live /><b className="shimmer">{STAGE_DO[job.stage]}…</b></div></div>}
      </div>
      <div className="compose">
        {tag && <div className="ctx-tag">{tag.shot ? `針對 ${tag.shot}` : tag.time != null ? `針對 ${tag.time.toFixed(1)} 秒` : `回答：${tag.q}`}<button onClick={() => setTag(null)}><I n="x" /></button></div>}
        {files.length > 0 && <div className="att-tray">{files.map((x, k) => (
          <div key={k} className="att-chip" title={x.f.name}>{x.url ? <img src={x.url} /> : <span className="att-ext"><I n="doc" />{x.f.name.split('.').pop()}</span>}
            <button aria-label="移除" onClick={() => setFiles((all) => all.filter((_, n) => n !== k))}><I n="x" s={2.4} /></button></div>))}</div>}
        <div className={`compose-box ${drag ? 'drag' : ''}`}
          onDragOver={(e) => { if (canTalk) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); if (canTalk) addFiles(e.dataTransfer.files); }}>
          <button className="icon-btn att-btn" disabled={!canTalk} onClick={() => pick.current!.click()} aria-label="附加檔案" title="附加圖片或檔案（也可以直接貼上或拖進來）"><I n="clip" /></button>
          <input ref={pick} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <AutoText placeholder={hint} value={text} disabled={!canTalk} onPaste={onPaste} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
          <button className="send" disabled={!canTalk || (!text.trim() && !files.length) || sending} onClick={send} aria-label="送出">{sending ? <span className="spin-ring" /> : <I n="up" s={2.2} />}</button>
        </div>
        {err ? <div className="hint" style={{ color: 'var(--red)' }}>{err}</div> : <div className="hint">Enter 送出 · Shift+Enter 換行 · 圖片可以直接貼上或拖進來</div>}
      </div>
      </>}
    </aside>
  );
}

// ---------- raw activity log ----------
const NOTIFY_EV: Record<string, string> = { plan_ready: '企劃好了', needs_input: '需要你處理', done: '影片完成', error: '出錯停下' };
const hms = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString('zh-TW', { hour12: false }); };
function LogView({ id, job }: { id: string; job: Job }) {
  const log = job.log || [], box = useRef<HTMLDivElement>(null), stick = useRef(true);
  const [who, setWho] = useState('all'), [q, setQ] = useState('');
  const whos = useMemo(() => [...new Set(log.map((e) => e.who || '_'))], [log.length]);
  const rows = log.filter((e) => e.type !== 'session' && (who === 'all' || (e.who || '_') === who) && (!q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase())));
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [rows.length]);
  const download = () => {
    const txt = log.map((x) => { const e = x as LogEvent & { name?: string; state?: string; text?: string; detail?: string; phase?: string; channel?: string; ok?: boolean }; return `${e.ts}\t${e.who || '-'}\t${e.type}\t${e.name || e.state || (e.channel && `${e.channel} ${e.ok ? 'ok' : 'failed'}`) || ''}\t${(e.text || e.detail || e.phase || '').replace(/\n/g, ' ')}`; }).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' })); a.download = `${id}-log.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const line = (e: LogEvent) => {
    if (e.type === 'turn') return <span className="lg-turn">{e.state === 'start' ? '▶ 開始' : e.ok ? '■ 完成' : '■ 失敗'} {e.phase}</span>;
    if (e.type === 'tool') return <><span className="lg-tool">{e.name}</span> {e.detail}</>;
    if (e.type === 'error') return <span className="lg-err">{e.text}</span>;
    if (e.type === 'thinking') return <span className="lg-think">{e.text}</span>;
    // label in its own span so the DOM translation pass sees the exact string
    if (e.type === 'notify') return <><span className={e.ok ? 'lg-tool' : 'lg-err'}>🔔 {e.channel} {e.ok ? '✓' : '✗'}</span> <span>{NOTIFY_EV[e.event] || e.event}</span>{e.detail && <span className="lg-err"> · {e.detail}</span>}</>;
    return <span>{'text' in e && e.text}</span>;
  };
  return (
    <div className="logview">
      <div className="lg-bar">
        <select value={who} onChange={(e) => setWho(e.target.value)}><option value="all">全部 agent</option>{whos.map((w) => <option key={w} value={w}>{whoName(w)}</option>)}</select>
        <input placeholder="搜尋紀錄" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn" title="下載紀錄" onClick={download}><I n="download" /></button>
      </div>
      <div className="lg-body" ref={box} onScroll={() => { const b = box.current!; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60; }}>
        {rows.length === 0 && <div className="small faint" style={{ padding: 16 }}>沒有紀錄</div>}
        {rows.map((e, i) => <div key={i} className={`lg-row ${e.type === 'notify' && !e.ok ? 'error' : e.type}`}><span className="lg-ts">{hms(e.ts)}</span><span className="lg-who">{whoName(e.who)}</span><span className="lg-msg">{line(e)}</span></div>)}
      </div>
      <div className="lg-foot small faint">顯示最近 {log.length} 筆 · 完整紀錄在 <a href={api.file(id, 'logs/events.jsonl')} target="_blank" rel="noreferrer">logs/events.jsonl</a></div>
    </div>
  );
}
