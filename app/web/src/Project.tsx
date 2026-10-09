import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { InputKind, Job, Pipeline as PipelineState, RequiredInput, RoundKey, Rounds, Stage } from '../../shared/types.ts';
import { api } from './api.ts';
import { I, Orb, Md, Ring, AutoText, useNow, clock, fmt, RoundsEditor, ErrorBoundary } from './ui.tsx';
import type { IconName, RoundValues } from './ui.tsx';
import { Conversation, buildThread, STAGE_DO } from './Chat.tsx';
import type { Critique as CritiqueData, MustFix, PlanAsset, Shot as ShotData, SnapshotView, Tag } from './types.ts';

export const STATUS: Record<Stage, [string, string]> = {
  new: ['排隊中', ''], analyzing: ['拆解中', 'live'], styling: ['判斷風格', 'live'], styled: ['風格完成', ''], planning: ['企劃中', 'live'],
  plan_review: ['等你確認企劃', 'warn'], replanning: ['修改企劃', 'live'], producing: ['生產中', 'live'], needs_input: ['等你提供', 'warn'],
  critiquing: ['評審中', 'live'], revising: ['修改中', 'live'], done: ['完成', 'ok'], error: ['需要處理', 'bad'],
};
export const Status = ({ stage }: { stage: Stage }) => { const [t, c] = STATUS[stage] || [stage, '']; return <span className={`cap ${c}`}>{c === 'live' ? <span className="dot live" /> : c === 'ok' ? <I n="check" s={2.4} /> : c === 'warn' ? <I n="pause" s={2.4} /> : c === 'bad' ? <I n="alert" s={2.2} /> : null}{t}</span>; };

const STEPS: { label: string; st: Stage[] }[] = [
  { label: '參考片', st: ['new', 'analyzing'] },
  { label: '風格拆解', st: ['styling', 'styled'] },
  { label: '前製企劃', st: ['planning', 'plan_review', 'replanning'] },
  { label: '生產', st: ['producing', 'needs_input'] },
  { label: '成品', st: ['done', 'revising', 'critiquing'] },
];
const stepIdx = (job: Job) => { const s = job.stage === 'error' ? job.failed : job.stage; return Math.max(0, STEPS.findIndex((x) => x.st.includes(s as Stage))); };
const PRE_PROD: Stage[] = ['planning', 'replanning', 'plan_review'];   // required inputs sit at the top of the page in these stages
const PIPE_DO: Record<string, string> = { setup: '導演建置角色與共用素材', cast: '角色關：審查角色設定圖', shots: '分段製作，每段做完立刻審查', assemble: '組裝成片', final: '最後評審：接縫、連戲、節奏' };

type FileUrl = (p: string) => string;
type Zoom = (src: string) => void;
export function Project({ id }: { id: string }) {
  const [s, setS] = useState<SnapshotView | null>(null), [v, setV] = useState(0), [tag, setTag] = useState<Tag | null>(null), [zoom, setZoom] = useState<string | null>(null), [tab, setTab] = useState<string | null>(null);
  const lastStage = useRef<Stage | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined, alive = true;
    const load = () => api.project(id).then((d) => { if (alive) { setS(d as SnapshotView); setV((x) => x + 1); } }).catch(() => {});
    load();
    // also reload when the stream (re)opens: whatever changed while it was down (a restart marking the job interrupted) arrives no other way
    const soon = () => { clearTimeout(t); t = setTimeout(load, 350); };
    const off = api.events(id, soon, soon);
    return () => { alive = false; off(); clearTimeout(t); };
  }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && setZoom(null); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  useEffect(() => { if (s && lastStage.current && lastStage.current !== s.job.stage) setTab(null); if (s) lastStage.current = s.job.stage; }, [s?.job.stage]);
  if (!s) return <main className="page"><div className="skeleton" style={{ height: 44, width: 320, marginBottom: 24 }} /><div className="proj"><div className="skeleton" style={{ height: 420 }} /><div className="skeleton" style={{ height: 560 }} /></div></main>;
  const { job } = s, idx = stepIdx(job), working = !!STAGE_DO[job.stage];
  const file = (p: string) => api.file(id, p, v);
  const onZoom = (src: string) => setZoom(src);
  const P: PipelineState = job.pipeline || {}, chunks = Object.values(P.chunks || {});
  const preProd = PRE_PROD.includes(job.stage) || (job.stage === 'error' && PRE_PROD.includes(job.failed as Stage));
  const tabs = [
    s.video && { k: 'result', label: '成品', ico: 'play', badge: s.critique && !s.critique.pass ? [`${(s.critique.must_fix || []).length} 項必修`, 'warn'] : null },
    P.phase && { k: 'pipe', label: '生產線', ico: 'layers', badge: chunks.length ? [`${chunks.filter((c) => c.state === 'passed').length}/${chunks.length}`, ''] : null },
    s.plan && { k: 'plan', label: '企劃', ico: 'doc', badge: job.stage === 'plan_review' ? ['待確認', 'warn'] : null },
    s.report && { k: 'ref', label: '參考片拆解', ico: 'scan' },
  ].filter((t): t is { k: string; label: string; ico: IconName; badge?: [string, string] | null } => !!t);
  const auto = ['producing', 'needs_input'].includes(job.stage) && P.phase && P.phase !== 'final' ? 'pipe' : s.video ? 'result' : P.phase ? 'pipe' : s.plan ? 'plan' : 'ref';
  const cur = tabs.some((t) => t.k === tab) ? tab : tabs.some((t) => t.k === auto) ? auto : tabs[0]?.k;
  return (
    <main className="page">
      <a className="back" href="#/"><I n="back" s={2.2} />專案</a>
      <div className="p-head">
        <div className="grow"><h1>{s.plan?.title || job.title}</h1>{s.plan?.title && <div className="brief-line">{s.plan.logline || s.brief}</div>}</div>
        <div className="p-head-r">{s.rounds && <RoundsButton id={id} r={s.rounds} />}<Status stage={job.stage} /></div>
      </div>
      <div className="progress">
        {STEPS.map((x, i) => {
          const done = i < idx || job.stage === 'done', cur = i === idx && job.stage !== 'done';
          return <div key={x.label} className={`${done ? 'done' : ''} ${cur ? 'cur' : ''} ${cur && !working ? 'idle' : ''}`}><div className="bar"><i /></div><label>{done ? <I n="check" s={2.4} style={{ color: 'var(--green)' }} /> : cur && working ? <span className="spin-ring" style={{ width: 10, height: 10, color: 'var(--accent)' }} /> : null}<span>{x.label}</span></label></div>;
        })}
      </div>
      <div className="proj">
        <ErrorBoundary><div>
          {working && <LiveBanner id={id} job={job} />}
          {job.stage === 'error' && <ErrorCard id={id} job={job} />}
          {(job.stage === 'needs_input' || ((job.needs || []).length > 0 && !working)) && <Needs id={id} s={s} file={file} onZoom={onZoom} />}
          {preProd && (s.requiredInputs || []).length > 0 && <RequiredInputs id={id} s={s} editable top />}
          {tabs.length > 1 && <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.k} role="tab" aria-selected={cur === t.k} className={cur === t.k ? 'on' : ''} onClick={() => setTab(t.k)}><I n={t.ico} />{t.label}{t.badge && <span className={`tb ${t.badge[1]}`}>{t.badge[0]}</span>}</button>)}</div>}
          <div key={cur} className="fade-in">
            {cur === 'result' && <Result s={s} file={file} onZoom={onZoom} />}
            {cur === 'pipe' && <Pipeline s={s} file={file} onZoom={onZoom} />}
            {cur === 'pipe' && !job.pipeline?.phase && s.checks.length > 0 && <div className="card"><div className="card-h"><h2>審查影格</h2></div><div className="gallery">{s.checks.slice(0, 12).map((c) => <img key={c} className="shot-img" src={file(c)} onClick={() => onZoom(file(c))} />)}</div></div>}
            {cur === 'plan' && <Plan s={s} file={file} job={job} onTag={setTag} onZoom={onZoom} />}
            {cur === 'ref' && <Analysis s={s} file={file} onZoom={onZoom} />}
            {!tabs.length && !working && <div className="card empty"><Orb size={44} idle /><div><b>還沒有內容</b><div className="small muted">拆解開始後，結果會出現在這裡。</div></div></div>}
          </div>
        </div></ErrorBoundary>
        <ErrorBoundary log={api.file(id, 'logs/events.jsonl')}><Conversation id={id} s={s} tag={tag} setTag={setTag} onZoom={onZoom} /></ErrorBoundary>
      </div>
      {zoom && <div className="lightbox" onClick={() => setZoom(null)}><img src={zoom} /></div>}
    </main>
  );
}

function LiveBanner({ id, job }: { id: string; job: Job }) {
  const now = useNow(true);
  const { live } = useMemo(() => buildThread(job), [job.log?.length, job.stage]);
  const since = live.length ? Math.min(...live.map((b) => new Date(b.start).getTime())) : new Date(job.updatedAt!).getTime();
  const detail = job.stage === 'producing' || job.stage === 'critiquing' || job.stage === 'revising' ? PIPE_DO[job.pipeline?.phase ?? ''] : null;
  return (
    <div className="livebar fade-in">
      <Orb size={36} live />
      <div className="grow"><b className="shimmer">{STAGE_DO[job.stage]}…</b><div className="small muted">{detail || '過程即時顯示在右側對話'}{live.length > 1 ? ` · ${live.length} 個 agent 同時工作` : ''}</div></div>
      <span className="elapsed">{clock(now - since)}</span>
      <button className="btn sm danger" onClick={() => api.cancel(id)}><I n="stop" />停止</button>
    </div>
  );
}

// ---------- analysis ----------
function Analysis({ s, file, onZoom }: { s: SnapshotView; file: FileUrl; onZoom: Zoom }) {
  const r = s.report!, a = r.audio || {}, p = r.pacing || {};
  const [open, setOpen] = useState(true);
  return (
    <section className="card">
      <div className="card-h"><div><div className="eyebrow">Step 1</div><h2>參考片拆解</h2></div><span className="sp" />{s.plan && <button className="btn sm plain" onClick={() => setOpen(!open)}>{open ? '收起' : '展開'}<I n="chev" className={`chev ${open ? 'open' : ''}`} /></button>}</div>
      {s.route && <div className="route" style={{ marginTop: 0 }}>
        <Ring value={s.route.confidence || 0} />
        <div className="grow"><div className="eyebrow">判定風格</div><div className="name">{s.route.style}</div><div className="small muted">製作技能 <b style={{ color: 'var(--accent-ink)' }}>{s.route.engine}</b>{s.route.medium && ` · ${s.route.medium}`}</div>
          {open && <ul>{(s.route.why || []).map((w, i) => <li key={i}>{w}</li>)}</ul>}</div>
      </div>}
      {open && <>
        <div className="widgets" style={{ marginTop: 14 }}>
          <W v={`${r.video.duration.toFixed(1)}s`} k={`${r.video.width}×${r.video.height} · ${r.video.fps}fps`} />
          {r.crop && <W v={`${r.crop.w}×${r.crop.h}`} k="已自動裁出畫面" warn />}
          <W v={p.count ?? '–'} k="鏡頭數" />
          <W v={p.mean_shot_s ? `${p.mean_shot_s}s` : '–'} k={p.mean_shot_beats ? `平均鏡頭 · ${p.mean_shot_beats} 拍` : '平均鏡頭長度'} />
          <W v={a.bpm ?? (a.present === false ? '無聲' : a.silent ? '靜音' : '–')} k="BPM" warn={a.silent} />
        </div>
        <div className="sheets" style={{ marginTop: 14 }}>
          <div><div className="sub-h" style={{ marginTop: 0 }}>每秒一格</div><img className="shot-img" src={file('analysis/sheet_1fps.jpg')} onClick={() => onZoom(file('analysis/sheet_1fps.jpg'))} /></div>
          <div><div className="sub-h" style={{ marginTop: 0 }}>每個鏡頭</div><img className="shot-img" src={file('analysis/sheet_scenes.jpg')} onError={(e) => (e.currentTarget.parentElement!.style.display = 'none')} onClick={() => onZoom(file('analysis/sheet_scenes.jpg'))} /></div>
        </div>
        {s.styleMd && <details style={{ marginTop: 14 }}><summary className="small muted" style={{ cursor: 'pointer' }}>完整風格拆解 STYLE.md</summary><div style={{ marginTop: 10 }}><Md src={s.styleMd} /></div></details>}
      </>}
    </section>
  );
}
const W = ({ v, k, warn }: { v: ReactNode; k: ReactNode; warn?: boolean }) => <div className={`widget ${warn ? 'warn' : ''}`}><div className="v">{v}</div><div className="k">{k}</div></div>;

// ---------- plan ----------
const SOFT = ['#C9C4FF', '#FFC8E6', '#FFD6B5', '#BDEBD9', '#BFE3FF', '#FFE7A3', '#E3CCFF', '#C8F0C0'];
const MOVES: Record<string, string> = { static: '固定', dolly_in: '推近', dolly_out: '拉遠', orbit: '環繞', crane_up: '升鏡', crane_down: '降鏡', macro_slide: '微距平移', push_reveal: '推進揭露', rack_focus: '移焦', pan: '橫搖', tilt: '直搖', zoom_in: '變焦推近', zoom_out: '變焦拉遠', shake: '晃動' };
function camText(x: ShotData) {
  const c = x.camera;
  if (!c || typeof c === 'string') return c || x.camera_note;
  const f = (k: 'from' | 'to') => (c[k] && c[k].fill != null ? Math.round(c[k].fill! * 100) + '%' : null);
  const parts = [MOVES[c.move] || c.move, c.lens && `${c.lens}mm`, f('from') && `主體 ${f('from')}${f('to') && f('to') !== f('from') ? '→' + f('to') : ''}`, c.pace && `速度 ${c.pace}`].filter(Boolean);
  return (x.camera_note ? x.camera_note + '　' : '') + (parts.length ? `〔${parts.join(' · ')}〕` : '');
}
function Plan({ s, file, job, onTag, onZoom }: { s: SnapshotView; file: FileUrl; job: Job; onTag: (t: Tag) => void; onZoom: Zoom }) {
  const P = s.plan!, [sel, setSel] = useState<string | null>(null), [allAssets, setAllAssets] = useState(false);
  const shots = P.shots || [];
  const total = P.format?.duration_s || Math.max(...shots.map((x) => x.end_s || 0), 1);
  const review = job.stage === 'plan_review';
  const palette = P.look?.palette || [];
  return (
    <div>
      <section className="card">
        <div className="card-h"><div><div className="eyebrow">前製企劃 · v{P.version || 1}</div><h2>{P.title || '企劃'}</h2></div></div>
        <p className="logline">{P.logline}</p>
        <div className="metas">
          {P.style && <span className="cap">{P.style}</span>}{P.engine && <span className="cap">{P.engine}</span>}
          {P.format && <span className="cap">{P.format.width}×{P.format.height}</span>}<span className="cap">{total}s · {shots.length} 鏡</span>
        </div>
        <div className="look">
          <div><div className="sub-h" style={{ marginTop: 0 }}>畫面</div>{palette.length > 0 && <div className="swatches">{palette.map((c) => <span key={c} title={c} style={{ background: c }} />)}</div>}
            <p>{P.look?.medium}{P.look?.color_arc && <><br />色彩弧線：{P.look.color_arc}</>}</p></div>
          <div><div className="sub-h" style={{ marginTop: 0 }}>從參考片學到的手法</div><div className="tags">{(P.borrowed_from_reference || []).map((b, i) => <span key={i} className="tag">{b}</span>)}</div></div>
        </div>
        {P.music && P.music.source !== 'none' && <div className="list" style={{ marginTop: 18 }}><div className="li"><div className="li-ico accent"><I n="music" /></div><div className="grow"><div className="t">{P.music.file || P.music.source}</div><div className="d">{[P.music.bpm && `${Math.round(P.music.bpm)} BPM`, P.music.section && `${P.music.section.start_s}s – ${P.music.section.end_s}s`, P.music.license].filter(Boolean).join(' · ')}</div></div></div></div>}
      </section>

      {(P.style_frames || []).length > 0 && <section className="card"><div className="card-h"><h2>定調畫面</h2><span className="sp" /><span className="small faint">{P.style_frames!.length} 張</span></div>
        <div className="scroller">{P.style_frames!.map((f) => <img key={f} className="shot-img" src={file(f)} onClick={() => onZoom(file(f))} />)}</div></section>}

      {(P.characters || []).length > 0 && <section className="card"><div className="card-h"><h2>角色</h2></div>
        <div className="cast">{P.characters!.map((c, i) => <div key={c.id || c.name}><div className="avatar" style={{ background: palette[(i + 1) % Math.max(1, palette.length)] || SOFT[i % 8], color: 'rgba(0,0,0,.6)' }}>{(c.name || '?').slice(0, 1)}</div><div className="grow"><b>{c.name}</b><div className="small muted" style={{ marginTop: 2 }}>{c.design}</div>{c.arc && <div className="small faint" style={{ marginTop: 4 }}>{c.arc}</div>}</div></div>)}</div></section>}

      <section className="card">
        <div className="card-h"><h2>分鏡與運鏡</h2><span className="sp" />{sel && <button className="btn sm plain" onClick={() => setSel(null)}>顯示全部</button>}</div>
        <div className="tl">{shots.map((x, i) => <button key={x.id} className={sel === x.id ? 'sel' : ''} style={{ flex: Math.max(0.4, (x.end_s || 0) - (x.start_s || 0)), background: SOFT[i % 8] }} onClick={() => setSel(sel === x.id ? null : x.id)} title={x.summary}>{x.id}</button>)}</div>
        <div className="tl-axis"><span>0s</span><span>{(total / 2).toFixed(0)}s</span><span>{total}s</span></div>
        <div className="list">{shots.map((x, i) => <Shot key={x.id} x={x} i={i} open={sel === x.id} onToggle={() => setSel(sel === x.id ? null : x.id)} review={review} onTag={onTag} />)}</div>
      </section>

      {(P.assets || []).length > 0 && <section className="card"><div className="card-h"><h2>素材</h2><span className="sp" /><span className="small faint">{P.assets!.length} 項</span></div>
        <div className="assets">{(allAssets ? P.assets! : P.assets!.slice(0, 8)).map((a) => <Asset key={a.id} a={a} file={file} />)}</div>
        {P.assets!.length > 8 && <button className="btn sm plain" style={{ marginTop: 10, marginLeft: -10 }} onClick={() => setAllAssets(!allAssets)}>{allAssets ? '收起' : `顯示全部 ${P.assets!.length} 項`}</button>}
        {s.assetsMd && <details style={{ marginTop: 12 }}><summary className="small muted" style={{ cursor: 'pointer' }}>授權紀錄</summary><div style={{ marginTop: 8 }}><Md src={s.assetsMd} /></div></details>}</section>}

      {!PRE_PROD.includes(job.stage) && ((s.requiredInputs || []).length > 0 || s.lyrics) && <RequiredInputs id={job.id} s={s} editable={false} />}
      {PRE_PROD.includes(job.stage) && !(s.requiredInputs || []).length && s.lyrics && <RequiredInputs id={job.id} s={s} editable={review} />}

      {(P.open_questions || []).length > 0 && <section className="card"><div className="card-h"><h2>需要你決定</h2></div>
        <div className="list">{P.open_questions!.map((q, i) => <div key={i} className="li"><div className="li-ico accent"><I n="bubble" /></div><div className="grow">{q}</div>{review && <button className="btn sm plain" onClick={() => onTag({ q })}>回答</button>}</div>)}</div></section>}

      {(P.changelog || []).length > 1 && <div className="small faint" style={{ margin: '14px 4px 0' }}>修改紀錄：{P.changelog!.join(' → ')}</div>}
      {review && <Approve id={job.id} open={(s.requiredInputs || []).filter((r) => r.status === 'missing')} />}
    </div>
  );
}
function Shot({ x, i, open, onToggle, review, onTag }: { x: ShotData; i: number; open: boolean; onToggle: () => void; review: boolean; onTag: (t: Tag) => void }) {
  return (
    <>
      <div className="li click shot-li" onClick={onToggle}>
        <div className="sid" style={{ color: 'var(--label)' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 3, background: SOFT[i % 8], marginRight: 6 }} />{x.id}<small>{fmt(x.start_s)}–{fmt(x.end_s)}</small></div>
        <div className="grow"><div className="t" style={{ fontWeight: 500 }}>{x.summary}</div>{!open && (x.camera || x.camera_note) && <div className="d" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{camText(x)}</div>}</div>
        <I n="chev" className={`chev ${open ? 'open' : ''}`} />
      </div>
      {open && <div className="shot-body">
        <div className="kv">
          {x.action && <><span>動作</span><span>{x.action}</span></>}
          {(x.camera || x.camera_note) && <><span>運鏡</span><span>{camText(x)}</span></>}
          {x.ref_shot != null && <><span>對照參考</span><span>#{x.ref_shot}{x.ref_what ? ` · ${x.ref_what}` : ''}</span></>}
          {(x.transition_in || x.transition_out) && <><span>轉場</span><span>{x.transition_in && `進：${x.transition_in}`}{x.transition_in && x.transition_out && '　'}{x.transition_out && `出：${x.transition_out}`}</span></>}
          {(x.reads || []).length > 0 && <><span>觀眾讀到</span><span>{x.reads!.join('；')}</span></>}
          {(x.text_overlay || []).length > 0 && <><span>字幕／字卡</span><span>{x.text_overlay!.map((t) => t.text).join('；')}</span></>}
          {(x.assets || []).length > 0 && <><span>素材</span><span>{x.assets!.join('、')}</span></>}
        </div>
        {review && <button className="btn sm plain" style={{ marginTop: 10, marginLeft: -10 }} onClick={() => onTag({ shot: x.id })}><I n="bubble" />對 {x.id} 提意見</button>}
      </div>}
    </>
  );
}
const ASTATUS: Record<string, string> = { user: '你提供的', to_fetch: '待抓取', fetched: '網路取得', drawn_in_code: '程式繪製', to_generate: '待生成' };
function Asset({ a, file }: { a: PlanAsset; file: FileUrl }) {
  const src = a.file ? file(a.file) : undefined, isImg = src && /\.(jpe?g|png|webp|gif|svg)$/i.test(a.file!), isAud = src && /\.(mp3|m4a|wav|ogg)$/i.test(a.file!);
  return (
    <div className="asset">
      <div className="pv" style={isImg ? { backgroundImage: `url("${src}")` } : undefined}>{isAud ? <audio controls src={src} /> : !isImg && <I n={a.kind === 'music' || a.kind === 'sfx' ? 'music' : a.kind === 'font' ? 'doc' : 'image'} />}</div>
      <div className="b"><b>{a.id} · {a.purpose}</b><span className="faint">{ASTATUS[a.status ?? ''] || a.status}{a.source && ` · ${a.source}`}</span>
        <span className={`cap ${a.license ? 'ok' : a.status === 'drawn_in_code' ? '' : 'warn'}`} style={{ justifySelf: 'start', height: 20, fontSize: 11 }}>{a.license || (a.status === 'drawn_in_code' ? '原創' : '授權未填')}</span></div>
    </div>
  );
}

// ---------- required inputs & lyrics ----------
// Things only the user can give (a song, lyrics, their own character art…). Shown at the top of the page while the plan is
// being written or reviewed, so they are found before "approve" is blocked by them.
const KIND: Record<InputKind, string> = { lyrics: '歌詞', audio: '音檔', image: '圖片', text: '文字', other: '檔案' };
const ACCEPT: Partial<Record<InputKind, string>> = { audio: 'audio/*,video/*,.mp3,.m4a,.wav,.aac,.flac,.ogg', image: 'image/*', lyrics: '.txt,.lrc,text/plain', text: '.txt,.md,text/plain' };
function RequiredInputs({ id, s, editable, top }: { id: string; s: SnapshotView; editable: boolean; top?: boolean }) {
  const req = s.requiredInputs || [], missing = req.filter((r) => r.status === 'missing');
  const hasLyrics = req.some((r) => r.kind === 'lyrics') || s.lyrics;
  const [err, setErr] = useState(''), [busy, setBusy] = useState('');
  const act = (k: string, fn: () => Promise<unknown>) => async () => { setErr(''); setBusy(k); try { await fn(); } catch (e) { setErr((e as Error).message); } setBusy(''); };
  return (
    <section id="required-inputs" className={`card req ${top && missing.length ? 'req-top' : ''}`}>
      <div className="card-h"><div>
        <h2>{missing.length ? `需要你提供 ${missing.length} 項素材` : '需要你提供的素材'}</h2>
        <div className="small muted" style={{ marginTop: 2 }}>{missing.length ? '這些只有你能給。提供或略過之後才能核准企劃，生產中不會再卡在這裡。' : '都處理好了。'}</div>
      </div></div>
      {req.length > 0 && <div className="list">{req.map((r) => (
        <div key={r.id} className={`li req-li ${r.status}`}>
          <div className={`li-ico ${r.status === 'provided' ? 'ok' : r.status === 'missing' ? 'warn' : ''}`}><I n={r.status === 'provided' ? 'check' : r.status === 'waived' ? 'x' : r.kind === 'lyrics' || r.kind === 'audio' ? 'music' : r.kind === 'image' ? 'image' : 'clip'} s={2} /></div>
          <div className="grow">
            <div className="t">{r.label || r.id}</div>
            <div className="d">{KIND[r.kind] || r.kind}{r.why ? ` · ${r.why}` : ''}</div>
            {r.files?.length > 0 && <div className="small faint req-files" data-no-i18n>{r.files.map((f) => f.split('/').pop()).join('、')}</div>}
          </div>
          <div className="req-act">
            {r.status === 'provided' && <span className="cap ok"><I n="check" s={2.4} />已提供</span>}
            {r.status === 'waived' && <><span className="cap">已略過</span>{editable && <button className="btn sm plain" disabled={!!busy} onClick={act('u' + r.id, () => api.unwaive(id, r.id))}>復原</button>}</>}
            {editable && r.status !== 'waived' && r.kind !== 'lyrics' && <Upload id={id} forInput={r.id} accept={ACCEPT[r.kind]} multiple={r.kind === 'image' || r.kind === 'other'} label={r.status === 'provided' ? '更換' : `上傳${KIND[r.kind] || '檔案'}`} primary={r.status === 'missing'} />}
            {editable && r.status === 'missing' && r.kind === 'lyrics' && <button className="btn sm primary" onClick={() => { const t = document.getElementById('lyrics-text'); t?.scrollIntoView({ behavior: 'smooth', block: 'center' }); t?.focus({ preventScroll: true }); }}><I n="pencil" />貼上歌詞</button>}
            {editable && r.status !== 'waived' && r.kind === 'lyrics' && <Upload id={id} forInput={r.id} accept={ACCEPT.lyrics} label="上傳 .txt / .lrc" />}
            {editable && r.status === 'missing' && <button className="btn sm plain" disabled={!!busy} onClick={act('w' + r.id, () => api.waive(id, r.id))}>略過</button>}
          </div>
        </div>))}</div>}
      {err && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>}
      {hasLyrics && <Lyrics id={id} s={s} editable={editable || s.job.stage === 'needs_input'} />}
    </section>
  );
}
export function Upload({ id, label = '上傳檔案', forInput, accept, multiple = true, primary }: { id: string; label?: string; forInput?: string; accept?: string; multiple?: boolean; primary?: boolean }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ names?: string; err?: string }>({}), ref = useRef<HTMLInputElement>(null);
  const up = async (files: FileList) => {
    if (!files.length) return; setBusy(true); setMsg({});
    const f = new FormData(); [...files].forEach((x) => f.append('inputs', x));
    try { const r = await api.addInputs(id, f, null, forInput); setMsg({ names: (r.saved || []).map((p) => p.split('/').pop()).join('、') }); }
    catch (e) { setMsg({ err: (e as Error).message }); } finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  return (
    <span className="upload">
      <label className={`btn sm ${primary ? 'primary' : ''}`}>{busy ? <span className="spin-ring" /> : <I n="clip" />}{busy ? '上傳中' : label}
        <input ref={ref} type="file" multiple={multiple} accept={accept} hidden onChange={(e) => up(e.target.files!)} /></label>
      {msg.names && <span className="tiny faint up-msg"><span>已上傳</span> <span data-no-i18n>{msg.names}</span></span>}
      {msg.err && <span className="tiny up-msg" style={{ color: 'var(--red)' }}>{msg.err}</span>}
    </span>
  );
}
function Lyrics({ id, s, editable }: { id: string; s: SnapshotView; editable: boolean }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
  const L = s.lyrics?.lines || [];
  const mean = L.length ? L.reduce((a, l) => a + (l.match || 0), 0) / L.length : 0;
  const go = async () => { setBusy(true); setMsg(''); try { const r = await api.lyrics(id, text); setMsg(r.aligned ? '對時完成' : r.ok ? '歌詞已存，收到配樂後會自動對時' : '對時失敗，請看右側紀錄'); if (r.ok) setText(''); } catch (e) { setMsg((e as Error).message); } setBusy(false); };
  return (
    <div style={{ marginTop: 18 }}>
      <div className="row" style={{ marginBottom: 8 }}><div className="sub-h" style={{ margin: 0 }}>歌詞字幕</div><span className="sp grow" />{L.length > 0 && <span className="cap ok"><I n="check" s={2.4} />{L.length} 句 · 平均匹配 {Math.round(mean * 100)}%</span>}</div>
      {editable && <>
        <textarea id="lyrics-text" className="field-area" placeholder={'貼上歌詞文字，一行一句。\n系統會用你提供的音檔自動對出每一句的時間，不需要自己做 LRC。'} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ marginTop: 10 }}><button className="btn sm primary" disabled={busy || !text.trim()} onClick={go}>{busy ? <><span className="spin-ring" />對時中，約 1 分鐘</> : <><I n="wand" />{L.length ? '重新對時' : '自動對時'}</>}</button><span className="small muted">{msg}</span></div>
      </>}
      {L.length > 0 && <div className="list" style={{ marginTop: 12, padding: '2px 4px' }}><table className="lyr"><tbody>{L.map((l, i) => <tr key={i} className={l.match < 0.6 ? 'low' : ''}><td className="tc">{fmt(l.start)} – {fmt(l.end)}</td><td>{l.text}</td><td style={{ whiteSpace: 'nowrap', textAlign: 'right' }} className="small faint"><span className="meter"><i style={{ width: `${Math.round((l.match || 0) * 100)}%` }} /></span>{l.match < 0.6 ? '用前後插值' : `${Math.round(l.match * 100)}%`}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
function Approve({ id, open }: { id: string; open: RequiredInput[] }) {
  const [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async () => { setErr(''); setBusy(true); try { await api.approve(id); } catch (e) { setErr((e as Error).message); } setBusy(false); };
  return (
    <div className="approve-bar">
      <div className="grow"><b>{open.length ? `還差 ${open.length} 項素材` : '企劃看起來 OK 嗎？'}</b>
        <div className="small muted">{err || (open.length ? `請先提供或略過：${open.map((r) => r.label || r.id).join('、')}` : '有意見就在右邊說，AI 改完再給你看；核准後才開始生成。')}</div></div>
      {open.length > 0 && <button className="btn" onClick={() => document.getElementById('required-inputs')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><I n="up" />去提供</button>}
      <button className="btn primary lg" disabled={open.length > 0 || busy} onClick={go}>{busy ? <span className="spin-ring" /> : <I n="play" />}核准並開始生成</button>
    </div>
  );
}

// ---------- error: say what happened in plain words, offer the next move ----------
const STEP_NAME: Record<string, string> = { analyzing: '拆解參考片', styling: '判斷風格', planning: '寫企劃', replanning: '修改企劃', producing: '生產', revising: '修改成片', critiquing: '評審' };
function ErrorCard({ id, job }: { id: string; job: Job }) {
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  // the server writes errors in the project's language: match both
  const e = job.error || '', cancelled = /取消|^Cancelled/.test(e), restarted = /重新啟動|server restarted/i.test(e), limited = /用量到上限|usage limit/i.test(e);
  const missing = e.match(/(?:缺少輸出：|Missing output: )(.+)/)?.[1];
  const title = cancelled ? `你停止了「${STEP_NAME[job.failed ?? ''] || job.failed}」` : restarted ? `「${STEP_NAME[job.failed ?? ''] || job.failed}」被伺服器重啟打斷` : limited ? 'AI 帳號的用量到上限了' : `「${STEP_NAME[job.failed ?? ''] || job.failed}」沒有完成`;
  const why = cancelled ? '檔案保留在停下來的地方，可以從這裡繼續。' : restarted ? '做到一半的檔案都還在，繼續會從目前的檔案接著做。' : limited ? '等額度恢復，或換另一個 AI 導演，再從這裡繼續；做到一半的檔案都還在。' : missing ? `AI 這一輪結束了，但沒有產出應有的檔案（${missing}）。通常再跑一次就會好；也可以在右邊說明要怎麼處理。` : 'AI 這一輪出錯了。可以再跑一次，或在右邊說明要怎麼處理。';
  const go = async () => { setBusy(true); try { await api.retry(id); } finally { setBusy(false); } };
  return (
    <div className={`banner ${cancelled || restarted ? 'warn' : 'bad'} fade-in`}>
      <div className="b-ico"><I n={cancelled ? 'pause' : 'alert'} s={2.2} /></div>
      <div className="grow">
        <h3>{title}</h3>
        <div className="small muted">{why}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm primary" disabled={busy} onClick={go}>{busy ? <span className="spin-ring" /> : <I n="play" />}{cancelled || restarted || limited ? '從這裡繼續' : '再試一次'}</button>
          {!cancelled && !restarted && e && <button className="btn sm plain" onClick={() => setOpen(!open)}>技術細節<I n="chev" className={`chev ${open ? 'open' : ''}`} /></button>}
        </div>
        {open && <pre>{e}</pre>}
      </div>
    </div>
  );
}

// ---------- paused: show exactly what to decide, with the evidence and one-click answers ----------
function Needs({ id, s, file, onZoom }: { id: string; s: SnapshotView; file: FileUrl; onZoom: Zoom }) {
  const job = s.job, needs = job.needs || [], p: PipelineState = job.pipeline || {}, [err, setErr] = useState(''), [busy, setBusy] = useState('');
  const lyricsNeeded = needs.some((n) => n.kind === 'lyrics' || /歌詞|lyric|LRC/i.test(n.issue || ''));
  const castStuck = !needs.length && p.cast?.state === 'failed' && !p.cast?.pass;
  const failedChunks = Object.entries(p.chunks || {}).filter(([, v]) => ['failed', 'error'].includes(v.state));
  const shotsStuck = !needs.length && p.phase === 'shots' && failedChunks.length > 0;
  const rv = s.cast?.review;
  const act = (k: string, fn: () => Promise<unknown>) => async () => { setErr(''); setBusy(k); try { await fn(); } catch (e) { setErr((e as Error).message); } setBusy(''); };
  const fixAll = act('fix', () => api.message(id, castStuck ? '照審查意見全部修，修完重新過角色關' : '照審查意見把沒通過的鏡頭全部修好'));
  const Btn = ({ k, onClick, children, primary }: { k: string; onClick: () => void; children: ReactNode; primary?: boolean }) => <button className={`btn sm ${primary ? 'primary' : ''}`} disabled={!!busy} onClick={onClick}>{busy === k ? <span className="spin-ring" /> : null}{children}</button>;
  let title = '暫停中：需要你決定', body: ReactNode, actions: ReactNode;
  if (castStuck) {
    title = `角色關審了 ${p.cast!.round} 輪還沒通過`;
    body = <>
      <div className="small muted">審查員還看到下面這些問題。你可以讓導演照著全部修，或覺得已經夠好就直接開始做鏡頭。</div>
      {(s.cast?.sheets || []).length > 0 && <div className="needs-thumbs">{s.cast.sheets.slice(0, 4).map((f) => <img key={f} src={file(f)} onClick={() => onZoom(file(f))} />)}</div>}
      {(rv?.issues || []).length > 0 && <ul className="issues" onClick={(e) => (e.target as Element).closest('li')?.classList.toggle('open')}>{rv!.issues!.slice(0, 6).map((x, i) => <li key={i}><span className="tagc">{x.character || '角色'}</span><span>{x.what && <b>{x.what}：</b>}{x.issue}</span></li>)}{rv!.issues!.length > 6 && <li className="small faint">還有 {rv!.issues!.length - 6} 項，在「生產線」分頁</li>}</ul>}
    </>;
    actions = <><Btn k="fix" primary onClick={fixAll}><I n="wand" />照審查全部修</Btn><Btn k="ok" onClick={act('ok', () => api.accept(id))}><I n="check" s={2.4} />角色可以了，開始做鏡頭</Btn></>;
  } else if (shotsStuck) {
    title = `${failedChunks.length} 段鏡頭審了幾輪還沒通過`;
    body = <><div className="small muted">沒過的段落：{failedChunks.map(([k, v]) => `${k}（${(v.shots || []).join('、')}）`).join('，')}。詳細審查意見在「生產線」分頁。</div></>;
    actions = <><Btn k="fix" primary onClick={fixAll}><I n="wand" />照審查全部修</Btn><Btn k="ok" onClick={act('ok', () => api.accept(id))}><I n="check" s={2.4} />可以了，直接組裝</Btn></>;
  } else {
    body = needs.length > 0 ? <ul className="issues" onClick={(e) => (e.target as Element).closest('li')?.classList.toggle('open')}>{needs.map((n, i) => <li key={i}><span className="tagc">{n.from}</span><span>{n.issue}{typeof n.why === 'string' && n.why && <span className="faint"> · {n.why}</span>}</span></li>)}</ul>
      : <div className="small muted">在右邊告訴導演要怎麼處理，或直接繼續。</div>;
    actions = <><Upload id={id} /><Btn k="go" primary onClick={act('go', () => api.resume(id))}><I n="play" />{needs.length ? '已處理，繼續生產' : '繼續生產'}</Btn></>;
  }
  return (
    <div className="banner warn fade-in">
      <div className="b-ico"><I n="pause" s={2.4} /></div>
      <div className="grow">
        <h3>{title}</h3>
        {body}
        {lyricsNeeded && <Lyrics id={id} s={s} editable />}
        <div className="row" style={{ marginTop: 14 }}>{actions}<span className="small faint">或在右邊直接跟導演說</span>{err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}</div>
      </div>
    </div>
  );
}

// ---------- review/fix round limits (header button + panel) ----------
function RoundsButton({ id, r }: { id: string; r: SnapshotView['rounds'] }) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [err, setErr] = useState(''), ref = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState(r.values);
  useEffect(() => { if (!saving) setLocal(r.values); }, [r.values.castRounds, r.values.chunkRounds, r.values.finalRounds]);
  useEffect(() => { if (!open) return; const k = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; addEventListener('pointerdown', k); return () => removeEventListener('pointerdown', k); }, [open]);
  const custom = (Object.keys(r.defaults) as RoundKey[]).filter((k) => r.values[k] !== r.defaults[k]).length;
  const change = async (next: RoundValues) => {
    const diff = Object.fromEntries((Object.keys(next) as RoundKey[]).filter((k) => next[k] !== local[k]).map((k) => [k, next[k] == null ? '' : next[k]]));
    setLocal({ ...local, ...Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v ?? r.defaults[k as RoundKey]])) });
    setSaving(true); setErr('');
    try { await api.settings(id, diff); } catch (e) { setErr((e as Error).message); setLocal(r.values); } finally { setSaving(false); }
  };
  return (
    <div className="rd-wrap" ref={ref}>
      <button className={`tool-chip ${custom ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="每一關最多審查、修改幾輪"><I n="sliders" />審查輪數{custom > 0 && <span className="n">{custom}</span>}</button>
      {open && <div className="rd-pop">
        <div className="row" style={{ marginBottom: 4 }}><b style={{ fontSize: 15 }}>審查輪數</b><span className="grow" />{saving ? <span className="spin-ring" style={{ width: 12, height: 12 }} /> : <span className="tiny faint">已自動儲存</span>}</div>
        <div className="tiny muted" style={{ marginBottom: 6 }}>做到一半也可以改，從下一次檢查開始生效。</div>
        <RoundsEditor value={Object.fromEntries(Object.entries(local).map(([k, v]) => [k, v === r.defaults[k as RoundKey] ? null : v]))} defaults={r.defaults} min={r.min} max={r.max} onChange={change} />
        {err && <div className="small" style={{ color: 'var(--red)', marginTop: 6 }}>{err}</div>}
      </div>}
    </div>
  );
}

// ---------- production line ----------
const CHUNK: Record<string, [string, string]> = { queued: ['排隊中', ''], building: ['製作中', 'live'], reviewing: ['審查中', 'live'], fixing: ['修正中', 'warn'], passed: ['通過', 'ok'], failed: ['未通過', 'bad'], error: ['錯誤', 'bad'], needs_user: ['等你提供', 'warn'], shared_fix: ['導演改共用檔', 'live'], waiting_cast: ['做好了，等角色關', ''], built: ['做好了，等角色關', ''] };
const PHASES: [NonNullable<PipelineState['phase']>, string, IconName][] = [['setup', '建置', 'layers'], ['cast', '角色關', 'user'], ['shots', '分段製作', 'film'], ['assemble', '組裝', 'play'], ['final', '最後評審', 'mag']];
function Pipeline({ s, file, onZoom }: { s: SnapshotView; file: FileUrl; onZoom: Zoom }) {
  const p: PipelineState = s.job.pipeline || {}, rv = s.cast?.review, chunks = Object.entries(p.chunks || {}), R: Partial<Rounds> = s.rounds?.values || {};
  const cur = PHASES.findIndex(([k]) => k === p.phase), allDone = s.job.stage === 'done';
  const passed = chunks.filter(([, v]) => v.state === 'passed').length;
  return (
    <section className="card">
      <div className="card-h"><div><div className="eyebrow">生產線</div><h2>{PIPE_DO[p.phase ?? ''] || '生產中'}</h2></div></div>
      <div className="phases">{PHASES.map(([k, label, ico], i) => {
        const st = i < cur || allDone ? 'done' : i === cur ? 'cur' : '';
        return <React.Fragment key={k}>{i > 0 && <span className={`phase-line ${i <= cur || allDone ? 'done' : ''}`} />}<span className={`phase ${st}`}><span className="pi">{st === 'done' ? <I n="check" s={2.6} /> : <I n={ico} />}</span>{label}{k === 'cast' && p.cast && p.cast.round > 1 ? ` · ${p.cast.round}` : ''}{k === 'final' && p.final?.round ? ` · 第 ${p.final.round} 輪` : ''}</span></React.Fragment>;
      })}</div>

      {(s.cast?.sheets || []).length > 0 && <>
        <div className="row" style={{ marginTop: 22, marginBottom: 10 }}><div className="sub-h" style={{ margin: 0 }}>角色設定圖</div><span className="grow" />
          {p.cast?.state && <span className={`cap ${p.cast.pass ? 'ok' : p.cast.state === 'failed' ? 'bad' : p.cast.state === 'fixing' ? 'warn' : 'live'}`}>{p.cast.pass ? <><I n="check" s={2.4} />已通過</> : ({ reviewing: '審查中', fixing: '導演修正中', failed: '未通過' } as Record<string, string>)[p.cast.state] || p.cast.state}{p.cast.round > 1 ? ` · 第 ${p.cast.round} / ${R.castRounds} 輪` : ''}</span>}</div>
        <div className="scroller">{(s.cast.sheets.filter((f) => /sheet/i.test(f.split('/').pop()!)).length ? s.cast.sheets.filter((f) => /sheet/i.test(f.split('/').pop()!)) : s.cast.sheets).map((f) => <img key={f} className="shot-img" src={file(f)} onClick={() => onZoom(file(f))} />)}</div>
        {p.cast?.chars && <div className="chunks" style={{ marginTop: 12 }}>{Object.entries(p.cast.chars).map(([k, c]) => { const [t, cl] = CHUNK[c.state] || (c.state === 'waiting_shared' ? ['等導演改骨架', 'warn'] : [c.state, '']); return <div key={k} className={`chunk ${c.state}`}><div className="ch-h"><b style={{ fontSize: 15 }}>{(s.production?.characters || []).find((x) => x.id === k)?.name || k}</b><span className="grow" /><span className={`cap ${cl}`} style={{ height: 22, fontSize: 11.5 }}>{cl === 'live' && <span className="dot live" />}{t}</span></div>{c.round > 1 && <div className="tiny faint">第 {c.round} / {R.castRounds} 輪</div>}</div>; })}</div>}
        {rv && !rv.pass && (rv.issues || []).length > 0 && <ul className="issues" onClick={(e) => (e.target as Element).closest('li')?.classList.toggle('open')}>{rv.issues!.map((x, i) => <li key={i}><span className="tagc">{x.character || '角色'}</span><span>{x.what && <b>{x.what}：</b>}{x.issue}{x.fix && <span className="faint"> → {x.fix}</span>}</span></li>)}</ul>}
      </>}

      {chunks.length > 0 && <>
        <div className="row" style={{ marginTop: 22, marginBottom: 10 }}><div className="sub-h" style={{ margin: 0 }}>分段</div><span className="grow" /><span className="small faint">{passed} / {chunks.length} 段通過 · 每段做完立刻由獨立審查員檢查</span></div>
        <div className="chunks">{chunks.map(([k, v]) => { const [t, c] = CHUNK[v.state] || [v.state, '']; return (
          <div key={k} className={`chunk ${v.state}`}>
            <div className="ch-h"><b>{k}</b><span className="grow" /><span className={`cap ${c}`} style={{ height: 22, fontSize: 11.5 }}>{c === 'live' && <span className="dot live" />}{t}</span></div>
            <div className="small muted">{(v.shots || []).join(' · ')}</div>
            {v.round > 1 && <div className="tiny faint">第 {v.round} / {R.chunkRounds} 輪審查</div>}
          </div>); })}</div>
      </>}

      {(s.shots || []).length > 0 && <details open={p.phase === 'shots'} style={{ marginTop: 18 }}><summary className="small muted" style={{ cursor: 'pointer' }}>每鏡審查影格 · {s.shots.length}</summary>
        <div className="gallery" style={{ marginTop: 10 }}>{s.shots.map((f) => <img key={f} className="shot-img" src={file(f)} title={f.split('/').pop()} onClick={() => onZoom(file(f))} />)}</div></details>}
    </section>
  );
}

// ---------- result: review the video like an editor — pause anywhere, type the note right there, send them all at once ----------
const tc = (x: number) => { const m = Math.floor(x / 60), s = x - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };
type Note = { id: number; t: number; text: string; thumb: string | null };
function Result({ s, file, onZoom }: { s: SnapshotView; file: FileUrl; onZoom: Zoom }) {
  const id = s.job.id, key = `notes:${id}`, v = useRef<HTMLVideoElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const [t, setT] = useState(0), [d, setD] = useState(0), [text, setText] = useState(''), [pin, setPin] = useState<number | null>(null);
  const [notes, setNotes] = useState<Note[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? 'null') || []; } catch { return []; } });
  const [sending, setSending] = useState(false), [err, setErr] = useState('');
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(notes)); } catch {} }, [notes]);
  const canSend = ['done', 'needs_input', 'error'].includes(s.job.stage);
  const seek = (x: number) => { if (v.current) { v.current.currentTime = x; v.current.pause(); } };
  const grab = () => { try { const c = document.createElement('canvas'); c.width = 192; c.height = 108; c.getContext('2d')!.drawImage(v.current!, 0, 0, 192, 108); return c.toDataURL('image/jpeg', 0.72); } catch { return null; } };
  const typing = (val: string) => { setText(val); if (pin == null && val.trim()) { v.current?.pause(); setPin(v.current?.currentTime || 0); } if (!val.trim()) setPin(null); };
  const add = () => {
    if (!text.trim()) return;
    const at = pin ?? v.current?.currentTime ?? 0;
    setNotes((n) => [...n, { id: Date.now(), t: at, text: text.trim(), thumb: grab() }].sort((a, b) => a.t - b.t));
    setText(''); setPin(null);
  };
  const send = async () => {
    if (!notes.length || !canSend) return; setSending(true); setErr('');
    const body = `請依以下時間點修改（共 ${notes.length} 項）：\n` + notes.map((n, i) => `${i + 1}. [${tc(n.t)}] ${n.text}`).join('\n');
    try { await api.message(id, body, { notes: notes.map(({ t, text }) => ({ t: +t.toFixed(2), text })) }); setNotes([]); } catch (e) { setErr((e as Error).message); }
    setSending(false);
  };
  const must = (s.critique?.must_fix || []).filter((m): m is MustFix & { time: number } => !!m && typeof m.time === 'number');
  const near = (x: number) => Math.abs(x - t) < 0.35;
  return (
    <section className="card">
      <div className="card-h"><div><div className="eyebrow">成品</div><h2>影片</h2></div><span className="sp" /><a className="btn sm" href={file(s.video!)} download><I n="download" />下載 MP4</a></div>
      <div className="player"><video ref={v} src={file(s.video!)} poster={s.plan?.style_frames?.[0] ? file(s.plan.style_frames[0]) : undefined} preload="metadata" controls playsInline onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setD(e.currentTarget.duration)} onSeeked={(e) => setT(e.currentTarget.currentTime)} /></div>

      <div className="scrub" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * d); }}>
        <div className="scrub-fill" style={{ width: d ? `${(t / d) * 100}%` : 0 }} />
        {d > 0 && must.map((m, i) => <i key={'c' + i} className="mk critic" style={{ left: `${(m.time / d) * 100}%` }} title={`評審：${m.issue}`} onClick={(e) => { e.stopPropagation(); seek(m.time); }} />)}
        {d > 0 && notes.map((n) => <i key={n.id} className={`mk ${near(n.t) ? 'on' : ''}`} style={{ left: `${(n.t / d) * 100}%` }} title={n.text} onClick={(e) => { e.stopPropagation(); seek(n.t); }} />)}
        {d > 0 && pin != null && <i className="mk pin" style={{ left: `${(pin / d) * 100}%` }} />}
      </div>

      <div className={`note-in ${pin != null ? 'pinned' : ''}`} onClick={() => input.current?.focus()}>
        <button className="tc-chip" title={pin != null ? '回到這個時間點' : '目前時間'} onClick={(e) => { e.stopPropagation(); if (pin != null) seek(pin); }}>{pin != null && <I n="pause" s={2.6} />}{tc(pin ?? t)}</button>
        <AutoText ref={input} placeholder="看到哪裡想改，直接在這裡打（影片會自動停在這一格）" value={text} onChange={(e) => typing(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } if (e.key === 'Escape') { setText(''); setPin(null); } }} />
        <button className="btn sm primary" disabled={!text.trim()} onClick={(e) => { e.stopPropagation(); add(); }}><I n="plus" s={2.4} />記下</button>
      </div>

      {notes.length > 0 && <div className="notes fade-in">
        <div className="row" style={{ margin: '4px 2px 10px' }}><div className="sub-h" style={{ margin: 0 }}>要修改的地方 · {notes.length}</div><span className="grow" /><button className="btn sm plain" onClick={() => setNotes([])}>全部清除</button></div>
        <div className="list">{notes.map((n) => (
          <div key={n.id} className={`li note ${near(n.t) ? 'on' : ''}`}>
            <button className="note-thumb" onClick={() => seek(n.t)} title="跳到這裡">{n.thumb ? <img src={n.thumb} alt="" /> : <I n="play" />}<span>{tc(n.t)}</span></button>
            <textarea className="note-text" rows={1} value={n.text} onChange={(e) => setNotes((all) => all.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))} />
            <button className="icon-btn" aria-label="刪除" onClick={() => setNotes((all) => all.filter((x) => x.id !== n.id))}><I n="x" /></button>
          </div>))}</div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small muted grow">{err || (canSend ? '導演會一次改完這些地方，改完再由獨立評審檢查一輪。' : 'AI 還在工作，記下的修改會保留，這一輪完成後再送出。')}</span>
          <button className="btn primary" disabled={!canSend || sending || notes.some((n) => !n.text.trim())} onClick={send}>{sending ? <span className="spin-ring" /> : <I n="up" s={2.4} />}送出 {notes.length} 則修改</button>
        </div>
      </div>}
      {s.critique && <Critique c={s.critique} onSeek={seek} id={id} stage={s.job.stage} file={file} onZoom={onZoom} />}
    </section>
  );
}
const VERDICT = { ours_better: ['贏過參考片', 'ok'], equal: ['和參考片同級', 'ok'], ref_better: ['輸給參考片', 'bad'] } as const;
function Critique({ c, onSeek, id, stage, file, onZoom }: { c: CritiqueData; onSeek?: (t: number) => void; id: string; stage: Stage; file: FileUrl; onZoom: Zoom }) {
  const sc = Object.entries(c.scores || {}), must = (c.must_fix || []).filter((m): m is MustFix => !!m), [busy, setBusy] = useState(false);
  const fix = async () => { setBusy(true); try { await api.message(id, `照獨立評審列的 ${must.length} 項必修全部修改：\n` + must.map((m, i) => `${i + 1}. [${m.shot || '全片'}${m.time != null ? ' ' + m.time + 's' : ''}] ${m.issue}`).join('\n')); } finally { setBusy(false); } };
  return (
    <div className="critique">
      <div className="row"><div className="avatar-ai critic"><I n="mag" /></div><b>獨立評審</b><span className="grow" /><span className={`cap ${c.pass ? 'ok' : 'bad'}`}>{c.pass ? <><I n="check" s={2.4} />通過</> : `${must.length} 項必修`}</span></div>
      {c.summary && <p className="small muted" style={{ margin: '10px 0 0' }}>{c.summary}</p>}
      {(c.peaks || []).length > 0 && <div style={{ marginTop: 12 }}><div className="sub-h" style={{ marginTop: 0 }}>高潮對決（上：參考片，下：我們）</div>
        {c.peaks!.map((p) => { const [label, cls] = VERDICT[p.verdict || 'equal'] || VERDICT.equal; return <div key={p.id} style={{ marginBottom: 10 }}>
          <div className="row"><span className="tagc">{p.id}{p.ours?.length ? ` · ${p.ours[0]}–${p.ours[1]}s` : ''}</span><span className={`cap ${cls}`}>{label}</span></div>
          {p.why && <p className="small muted" style={{ margin: '6px 0' }}>{p.why}</p>}
          {p.strip && <img className="shot-img" src={file(p.strip)} onClick={() => onZoom(file(p.strip!))} />}</div>; })}</div>}
      {sc.length > 0 && <div className="scores">{sc.map(([k, v]) => <div key={k} className={`score ${v < 4 ? 'low' : ''}`}><div className="row"><span>{k}</span><b>{v}</b></div><div className="pips">{[1, 2, 3, 4, 5].map((n) => <i key={n} className={n <= v ? 'on' : ''} />)}</div></div>)}</div>}
      {must.length > 0 && <ul className="issues" onClick={(e) => (e.target as Element).closest('li')?.classList.toggle('open')}>{must.map((m, i) => <li key={i} className={typeof m.time === 'number' ? 'seekable' : ''} onClick={() => typeof m.time === 'number' && onSeek?.(m.time)}><span className="tagc">{m.shot || '全片'}{typeof m.time === 'number' ? ` · ${m.time}s` : ''}</span><span>{m.issue}{m.fix && <span className="faint"> → {m.fix}</span>}</span></li>)}</ul>}
      {!c.pass && must.length > 0 && ['done', 'error'].includes(stage) && <div className="row" style={{ marginTop: 12 }}><button className="btn sm primary" disabled={busy} onClick={fix}>{busy ? <span className="spin-ring" /> : <I n="wand" />}照評審的 {must.length} 項全部修</button><span className="small faint">或在上方影片時間軸自己標要改的地方</span></div>}
    </div>
  );
}
