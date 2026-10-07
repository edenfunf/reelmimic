import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentKind, AgentStatus, ProjectSummary, Rounds } from '../../shared/types.ts';
import { api } from './api.ts';
import { I, BrandMark, Orb, Seg, AutoText, ago, RoundsEditor, ErrorBoundary } from './ui.tsx';
import type { IconName, RoundValues } from './ui.tsx';
import { Project, Status } from './Project.tsx';
import { LANGS, lang as initialLang, setLang } from './i18n.ts';

// ---------- router & theme ----------
const useRoute = (): { page: 'project'; id: string } | { page: 'home'; id?: undefined } => {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => { setH(location.hash); scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  const m = h.match(/^#\/p\/([\w-]+)/);
  return m ? { page: 'project', id: m[1] } : { page: 'home' };
};
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} } };
function useTheme(): [string, () => void] {
  const sys = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [t, setT] = useState(() => store.get('theme') || sys());
  useEffect(() => { document.documentElement.dataset.theme = t; }, [t]);
  return [t, () => { const n = t === 'dark' ? 'light' : 'dark'; store.set('theme', n); setT(n); }];
}

export default function App() {
  const r = useRoute(), [theme, toggle] = useTheme();
  const [agents, setAgents] = useState<Partial<AgentStatus> | undefined>(undefined);
  useEffect(() => { api.agents().then(setAgents).catch(() => setAgents({})); }, []);
  return (
    <>
      <header className="nav">
        <a className="brand" href="#/"><BrandMark />ReelMimic</a>
        <span className="sp" />
        <div className="agents-cap" title="已連線的 AI 導演">
          <span><i className={`dot ${agents === undefined ? '' : agents?.claude ? 'on' : 'bad'}`} /><span className="lbl">Claude Code</span></span>
          <span><i className={`dot ${agents === undefined ? '' : agents?.codex ? 'on' : 'bad'}`} /><span className="lbl">Codex</span></span>
        </div>
        <LangMenu />
        <button className="icon-btn" onClick={toggle} aria-label="切換外觀"><I n={theme === 'dark' ? 'sun' : 'moon'} /></button>
      </header>
      <ErrorBoundary key={r.id || 'home'} page back={r.page === 'project'} log={r.id && api.file(r.id, 'logs/events.jsonl')}>
        {r.page === 'home' ? <Home agents={agents} /> : <Project key={r.id} id={r.id} />}
      </ErrorBoundary>
    </>
  );
}

// ---------- language menu (top right) ----------
function LangMenu() {
  const [cur, setCur] = useState(initialLang), [open, setOpen] = useState(false), ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false); addEventListener('mousedown', f); return () => removeEventListener('mousedown', f); }, []);
  const L = LANGS.find((l) => l.id === cur)!;
  return (
    <div className="lang" ref={ref} data-no-i18n>
      <button className="lang-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} title="Language / 介面語言"><I n="globe" /><span>{L.short}</span></button>
      {open && <div className="lang-menu" role="listbox">{LANGS.map((l) => (
        <button key={l.id} role="option" aria-selected={l.id === cur} className={l.id === cur ? 'on' : ''} onClick={() => { setLang(l.id); setCur(l.id); setOpen(false); }}>
          <span>{l.label}</span>{l.id === cur && <I n="check" s={2.4} />}</button>))}</div>}
    </div>
  );
}

// ---------- home ----------
const SUGGEST = ['做一支類似風格的 30 秒影片，主軸是愛情，要有好笑的反轉', '同樣的剪法，改成介紹我們的新 App', '保留節奏和轉場，主題換成親情，直式 9:16', '把我的小故事畫成 Q 版漫畫，第一人稱旁白'];
const HOW: [IconName, string, string][] = [['scan', '拆解風格', '剪法、節奏、轉場、畫面語言逐鏡量測'], ['wand', '選製作技能', '判斷畫風，交給對應的製作 skill'], ['film', '前製企劃', '分鏡、運鏡、素材、定調畫面，和你來回對焦'], ['check', '關卡審查', '角色、每一段都即時檢查，過關才往下做']];

function Home({ agents }: { agents?: Partial<AgentStatus> }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  useEffect(() => { api.projects().then((l) => setList(l.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')))).catch(() => setList([])); }, []);
  return (
    <main className="home">
      <section className="hero fade-in">
        <Orb size={64} />
        <h1>丟一支喜歡的影片，<br /><span className="grad">做出同樣風格的新作品。</span></h1>
        <p>AI 導演拆解它的剪法與畫面語言，和你一起把腳本、運鏡、素材想清楚，核准後才開始生成，每一段都檢查過才交件。</p>
      </section>
      <Composer agents={agents} />
      <div className="how">{HOW.map(([ico, t, d]) => <div key={t}><i><I n={ico} /></i><b>{t}</b><span>{d}</span></div>)}</div>
      {list && list.length > 0 && <section>
        <div className="section-title"><h2>專案</h2><span className="small faint">{list.length}</span></div>
        <div className="plist">{list.map((p, i) => (
          <a key={p.id} className="pcard fade-in" onMouseEnter={(e) => { const v = e.currentTarget.querySelector('video'); if (v) { v.currentTime = 3; v.play().catch(() => {}); } }} onMouseLeave={(e) => e.currentTarget.querySelector('video')?.pause()} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }} href={`#/p/${p.id}`}>
            <div className="th" style={{ backgroundImage: p.thumb ? `url("${api.file(p.id, p.thumb)}")` : undefined }}>{p.stage === 'done' && <video muted loop playsInline preload="none" src={api.file(p.id, 'out/video.mp4')} onError={(e) => e.currentTarget.remove()} />}<Status stage={p.stage} /></div>
            <div className="meta"><b>{p.title}</b><div className="small faint" style={{ marginTop: 2 }}>{p.agent === 'codex' ? 'Codex' : 'Claude Code'} · {ago(p.updatedAt)}{p.needs ? ` · ${p.needs} 項待你提供` : ''}</div></div>
          </a>))}</div>
      </section>}
    </main>
  );
}

const ytId = (u: string) => (u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || [])[1];
function Composer({ agents }: { agents?: Partial<AgentStatus> }) {
  const [file, setFile] = useState<File | null>(null), [url, setUrl] = useState(''), [linkMode, setLinkMode] = useState(false);
  const [brief, setBrief] = useState(''), [agent, setAgent] = useState<AgentKind>('claude'), [inputs, setInputs] = useState<File[]>([]);
  const [drag, setDrag] = useState(false), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [rounds, setRounds] = useState<RoundValues>({}), [roundsOpen, setRoundsOpen] = useState(false), [defaults, setDefaults] = useState<Rounds | null>(null);
  useEffect(() => { api.config().then((c) => setDefaults({ castRounds: c.castRounds, chunkRounds: c.chunkRounds, finalRounds: c.finalRounds })).catch(() => {}); }, []);
  const customRounds = Object.entries(rounds).filter(([, v]) => v != null);
  const pick = useRef<HTMLInputElement>(null), assets = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => { if (agents && !agents.claude && agents.codex) setAgent('codex'); }, [agents]);
  const validUrl = /^https?:\/\//.test(url.trim());
  const ok = (file || validUrl) && brief.trim() && !busy;
  const setVideo = (f: File | null | undefined) => { if (f && f.type.startsWith('video/')) { setFile(f); setUrl(''); setLinkMode(false); setErr(''); } else if (f) setErr('請選擇影片檔（mp4 / mov / webm）'); };
  const submit = async () => {
    if (!ok) return; setBusy(true); setErr('');
    const f = new FormData();
    if (file) f.append('reference', file); else f.append('url', url.trim());
    f.append('brief', brief); f.append('agent', agent); f.append('lang', document.documentElement.lang || 'zh-TW');
    inputs.forEach((x) => f.append('inputs', x));
    customRounds.forEach(([k, v]) => f.append(k, String(v)));
    try { const { id } = await api.create(f); location.hash = `#/p/${id}`; } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const yt = ytId(url);
  return (
    <>
      <div className={`composer fade-in ${drag ? 'drag' : ''}`} style={{ animationDelay: '80ms' }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false); }}
        onDrop={(e) => { e.preventDefault(); setDrag(false); setVideo(e.dataTransfer.files[0]); }}>
        {file ? (
          <div className="ref-slot">
            <div className="ref-thumb"><video src={`${preview}#t=0.5`} muted preload="metadata" /></div>
            <div className="ref-meta"><span className="eyebrow">參考影片</span><b>{file.name}</b><span className="small faint">{(file.size / 1e6).toFixed(1)} MB</span></div>
          </div>
        ) : linkMode ? (
          <>
            <div className="link-in"><I n="link" /><input autoFocus placeholder="貼上 YouTube 或影片連結" value={url} onChange={(e) => setUrl(e.target.value)} /><button className="icon-btn" style={{ width: 28, height: 28, fontSize: 14 }} onClick={() => { setLinkMode(false); setUrl(''); }} aria-label="取消"><I n="x" /></button></div>
            {validUrl && <div className="ref-slot fade-in"><div className="ref-thumb">{yt ? <img src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`} alt="" /> : <I n="globe" />}</div><div className="ref-meta"><span className="eyebrow">參考影片連結</span><b>{yt ? `YouTube · ${yt}` : url}</b><span className="small faint">建立專案時自動下載</span></div></div>}
          </>
        ) : (
          <div className="ref-empty" onClick={() => pick.current!.click()}>
            <div className="big-ico"><I n="film" /></div>
            <div className="grow"><b>拖入參考影片，或點擊選擇</b><span className="small">mp4 / mov / webm，手機螢幕錄影也可以（會自動裁掉介面）</span></div>
            <button className="btn sm" onClick={(e) => { e.stopPropagation(); setLinkMode(true); }}><I n="link" />貼連結</button>
          </div>
        )}
        <input ref={pick} type="file" accept="video/*" hidden onChange={(e) => setVideo(e.target.files![0])} />
        <AutoText minRows={3} placeholder="你想做什麼樣的影片？主題、長度、角色、想保留參考片的哪些地方…" value={brief} onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        <div className="comp-bar">
          {file && <button className="tool-chip" onClick={() => pick.current!.click()}><I n="retry" />換影片</button>}
          {file && <button className="tool-chip" onClick={() => setFile(null)}><I n="x" />移除</button>}
          <button className={`tool-chip ${inputs.length ? 'on' : ''}`} onClick={() => assets.current!.click()} title="配樂、歌詞、圖片、Logo、自家角色設計圖">
            <I n="clip" />素材{inputs.length > 0 && <span className="n">{inputs.length}</span>}</button>
          <input ref={assets} type="file" multiple hidden onChange={(e) => setInputs([...e.target.files!])} />
          {defaults && <button className={`tool-chip ${customRounds.length ? 'on' : ''}`} onClick={() => setRoundsOpen(!roundsOpen)} aria-expanded={roundsOpen} title="每一關最多審查、修改幾輪">
            <I n="sliders" />審查輪數{customRounds.length > 0 && <span className="n">{customRounds.length}</span>}</button>}
          <span className="grow" />
          <Seg value={agent} onChange={setAgent} options={[
            { value: 'claude', label: <><span className="long">Claude Code</span><span className="short">Claude</span></>, disabled: agents && !agents.claude, title: agents?.claude || '未偵測到' },
            { value: 'codex', label: 'Codex', disabled: agents && !agents.codex, title: agents?.codex || '未偵測到' }]} />
          <button className="send" disabled={!ok} onClick={submit} aria-label="開始">{busy ? <span className="spin-ring" /> : <I n="up" s={2.2} />}</button>
        </div>
        {inputs.length > 0 && <div className="small faint" style={{ padding: '8px 10px 2px' }}>素材：{inputs.map((f) => f.name).join('、')}</div>}
        {roundsOpen && defaults && <div className="comp-rounds fade-in"><RoundsEditor value={rounds} defaults={defaults} onChange={setRounds} /></div>}
      </div>
      {err ? <div className="small" style={{ color: 'var(--red)', textAlign: 'center', marginTop: 12 }}>{err}</div>
        : <div className="small faint" style={{ textAlign: 'center', marginTop: 12 }}>先拆解與企劃，你核准前不會開始生成 · Ctrl+Enter 送出</div>}
      <div className="suggest">{SUGGEST.map((x) => <button key={x} onClick={() => setBrief(x)}>{x}</button>)}</div>
    </>
  );
}
