import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, TextareaHTMLAttributes } from 'react';
import type { RoundKey, Rounds } from '../../shared/types.ts';

// ---------- icons (SF-Symbols-like strokes) ----------
const P = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  sliders: 'M4 7h9M17 7h3M15 4.5v5M4 17h3M11 17h9M9 14.5v5',
  link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1',
  clip: 'M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4',
  up: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  chev: 'M9 5.5 15.5 12 9 18.5',
  back: 'M15 5.5 8.5 12l6.5 6.5',
  check: 'M5 12.5 10 17.5 19 7',
  x: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  film: 'M4 5h16v14H4zM8 5v14M16 5v14M4 9.5h4M4 14.5h4M16 9.5h4M16 14.5h4',
  spark: 'M12 3.5c.5 4.3 2.7 6.5 7 7-4.3.5-6.5 2.7-7 7-.5-4.3-2.7-6.5-7-7 4.3-.5 6.5-2.7 7-7Z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z',
  term: 'M4 6.5 9 12l-5 5.5M12 18h8',
  pencil: 'M15.5 5.5l3 3L9 18H6v-3zM13.5 7.5l3 3',
  doc: 'M7 3.5h7l4 4V20.5H7zM14 3.5v4h4M9.5 12h6M9.5 15.5h6',
  search: 'M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12ZM15 15l5 5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17M15.5 9.2a1.2 1.2 0 1 0 0 .1',
  wand: 'M5 19 16 8M14 6l4 4M18 3v3M16.5 4.5h3M20 9.5v2M19 10.5h2',
  pause: 'M8.5 5.5v13M15.5 5.5v13',
  alert: 'M12 4 21 19.5H3zM12 10v4.5M12 17.2v.1',
  download: 'M12 4.5V15M7 10.5l5 5 5-5M5 19.5h14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
  moon: 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z',
  globe: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5Z',
  bubble: 'M4.5 5.5h15v10h-8l-4.5 4v-4h-2.5z',
  retry: 'M4.5 12a7.5 7.5 0 0 1 13-5.1M19.5 12a7.5 7.5 0 0 1-13 5.1M17.5 3.5v3.5H14M6.5 20.5V17H10',
  play: 'M8 5.5v13l10.5-6.5z',
  user: 'M12 4a3.8 3.8 0 1 1 0 7.6A3.8 3.8 0 0 1 12 4ZM5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5',
  layers: 'M12 4 20.5 8.5 12 13 3.5 8.5zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5',
  scan: 'M4 8.5V5h3.5M16.5 5H20v3.5M20 15.5V19h-3.5M7.5 19H4v-3.5M8 12h8',
  music: 'M9 18.5V6.5l10-2v12M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM19 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  mag: 'M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12ZM15 15l5 5M8 10.5h5',
  stop: 'M7 7h10v10H7z',
};
export type IconName = keyof typeof P;
export const I = ({ n, s, style, className = '' }: { n: IconName; s?: number; style?: CSSProperties; className?: string }) => (
  <svg className={`ico ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={s || 1.8} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true"><path d={P[n]} /></svg>
);

export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7A6BFF" /><stop offset=".55" stopColor="#E86BD2" /><stop offset="1" stopColor="#FF9D5C" /></linearGradient></defs>
    <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#bm)" />
    <rect x="7" y="9" width="12" height="14" rx="3.2" fill="none" stroke="#fff" strokeWidth="2" opacity=".55" />
    <rect x="12" y="9" width="12" height="14" rx="3.2" fill="#fff" />
    <path d="M16.4 13v6l4.6-3z" fill="#B65CE0" />
  </svg>
);

export const Orb = ({ size = 56, live, idle, className = '' }: { size?: number; live?: boolean; idle?: boolean; className?: string }) => <div className={`orb ${live ? 'live' : ''} ${idle ? 'idle' : ''} ${className}`} style={{ '--s': `${size}px` } as CSSProperties}><i /></div>;

// ---------- segmented control with a sliding thumb ----------
export type SegOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean; title?: string };
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: SegOption<T>[]; onChange: (v: T) => void }) {
  const ref = useRef<HTMLDivElement>(null), [th, setTh] = useState<{ w: number; x: number } | null>(null);
  useLayoutEffect(() => {
    const m = () => { const b = ref.current?.querySelector<HTMLElement>(`[data-v="${value}"]`); if (b) setTh({ w: b.offsetWidth, x: b.offsetLeft }); };
    m(); addEventListener('resize', m); return () => removeEventListener('resize', m);
  }, [value, options.map((o) => o.value).join()]);
  return (
    <div className="seg" ref={ref} role="tablist">
      {th && <span className="thumb" style={{ width: th.w, transform: `translateX(${th.x - 3}px)`, left: 3 }} />}
      {options.map((o) => <button key={o.value} data-v={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export const Ring = ({ value = 0, size = 64, stroke = 6 }: { value?: number; size?: number; stroke?: number }) => {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#ringg)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value)} style={{ transition: 'stroke-dashoffset 1s cubic-bezier(.32,.72,0,1)' }} />
        <defs><linearGradient id="ringg"><stop offset="0" stopColor="#7A6BFF" /><stop offset="1" stopColor="#E86BD2" /></linearGradient></defs></svg>
      <b>{Math.round(value * 100)}%</b>
    </div>
  );
};

// ---------- time ----------
export function useNow(active = true, ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [active, ms]);
  return n;
}
export const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
};
export const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const ago = (iso?: string) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '剛剛'; if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`; if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
};
export const fmt = (x?: number | null) => (x == null ? '' : `${Number(x).toFixed(1)}s`);

// ---------- minimal markdown ----------
export function Md({ src }: { src?: string | null }) {
  const html = useMemo(() => {
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inl = (t: string) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const out: string[] = [], L = (src || '').split('\n');
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      if (/^\s*\|/.test(l)) {
        const rows: string[][] = []; while (i < L.length && /^\s*\|/.test(L[i])) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(L[i])) rows.push(L[i].trim().replace(/^\||\|$/g, '').split('|')); i++; } i--;
        out.push('<table>' + rows.map((r, k) => '<tr>' + r.map((c) => `<${k ? 'td' : 'th'}>${inl(c.trim())}</${k ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>');
      } else if (/^#{1,4} /.test(l)) { const n = l.match(/^#+/)![0].length; out.push(`<h${Math.min(n + 1, 4)}>${inl(l.replace(/^#+ /, ''))}</h${Math.min(n + 1, 4)}>`); }
      else if (/^>\s?/.test(l)) out.push(`<blockquote>${inl(l.replace(/^>\s?/, ''))}</blockquote>`);
      else if (/^\s*\d+\. /.test(l)) { const items: string[] = []; while (i < L.length && /^\s*\d+\. /.test(L[i])) { items.push(`<li>${inl(L[i].replace(/^\s*\d+\. /, ''))}</li>`); i++; } i--; out.push(`<ol>${items.join('')}</ol>`); }
      else if (/^\s*[-*] /.test(l)) { const items: string[] = []; while (i < L.length && /^\s*[-*] /.test(L[i])) { items.push(`<li>${inl(L[i].replace(/^\s*[-*] /, ''))}</li>`); i++; } i--; out.push(`<ul>${items.join('')}</ul>`); }
      else if (l.trim()) out.push(`<p>${inl(l)}</p>`);
    }
    return out.join('');
  }, [src]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// textarea that grows with its content
export const AutoText = React.forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }>(function AutoText({ value, onChange, minRows = 1, ...rest }, outer) {
  const ref = useRef<HTMLTextAreaElement>(null);
  React.useImperativeHandle(outer, () => ref.current as HTMLTextAreaElement);
  useLayoutEffect(() => { const t = ref.current; if (!t) return; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }, [value]);
  return <textarea ref={ref} rows={minRows} value={value} onChange={onChange} {...rest} />;
});

// ---------- review/fix round limits (per project) ----------
// value: the project's own settings (may be partial); defaults: server defaults. Changing a number calls onChange with
// the full next value; a number equal to its default is sent as null (= follow the default).
export const ROUND_FIELDS: [RoundKey, string, string][] = [
  ['castRounds', '角色關', '每個角色最多審幾輪'],
  ['chunkRounds', '每段鏡頭', '每段最多審幾輪'],
  ['finalRounds', '最後評審', '自動修改最多幾輪'],
];
export type RoundValues = Partial<Record<RoundKey, number | null>>;
export function RoundsEditor({ value = {}, defaults, min = 1, max = 10, onChange, disabled }: { value?: RoundValues; defaults: Rounds; min?: number; max?: number; onChange: (next: RoundValues) => void; disabled?: boolean }) {
  const set = (k: RoundKey, v: number) => onChange({ ...value, [k]: v === defaults[k] ? null : v });
  return (
    <div className="rounds">
      {ROUND_FIELDS.map(([k, label, hint]) => {
        const v = value[k] ?? defaults[k], custom = value[k] != null && value[k] !== defaults[k];
        return (
          <div className="rd-row" key={k}>
            <div className="grow"><b>{label}</b><div className="tiny faint">{hint}{custom ? ` · 預設 ${defaults[k]}` : ' · 預設'}</div></div>
            <div className="stepper">
              <button className="icon-btn" disabled={disabled || v <= min} onClick={() => set(k, v - 1)} aria-label="減少"><I n="minus" /></button>
              <span className={`num ${custom ? 'custom' : ''}`}>{v}</span>
              <button className="icon-btn" disabled={disabled || v >= max} onClick={() => set(k, v + 1)} aria-label="增加"><I n="plus" /></button>
            </div>
          </div>
        );
      })}
      <div className="rd-foot">
        <div className="tiny faint rd-note">到了上限還沒通過，會暫停請你決定，不會一直來回修改。輪數多，品質有機會更好，但時間和 AI 用量也會增加。</div>
        {ROUND_FIELDS.some(([k]) => value[k] != null && value[k] !== defaults[k]) && <button className="btn sm plain" disabled={disabled} onClick={() => onChange(Object.fromEntries(ROUND_FIELDS.map(([k]) => [k, null])))}>恢復預設</button>}
      </div>
    </div>
  );
}

// ---------- error boundary ----------
// A render error (an agent-written file in a shape the UI doesn't expect, say) unmounts everything up to the nearest
// boundary; without one the whole page goes blank. This shows a card with a way out instead and logs the error.
// page: stands in for a whole page (back: with the link to the project list) · log: link to the project's raw log
type BoundaryProps = { children: ReactNode; page?: boolean; back?: boolean; log?: string };
export class ErrorBoundary extends React.Component<BoundaryProps, { error: Error | null; where?: string }> {
  override state: { error: Error | null; where?: string } = { error: null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e : new Error(String(e)) }; }
  override componentDidCatch(e: unknown, info: React.ErrorInfo) { console.error('ReelMimic UI error:', e, info.componentStack); this.setState({ where: info.componentStack || '' }); }
  override render() {
    const { error, where } = this.state, { page, back, log } = this.props;
    if (!error) return this.props.children;
    const card = (
      <div className="banner bad fade-in" role="alert">
        <div className="b-ico"><I n="alert" s={2.2} /></div>
        <div className="grow">
          <h3>這裡的畫面顯示不出來</h3>
          <div className="small muted">伺服器上的工作和檔案都不受影響。可以重新載入；回報問題時請附上技術細節。</div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn sm primary" onClick={() => location.reload()}><I n="retry" />重新載入</button>
            {log && <a className="btn sm plain" href={log} target="_blank" rel="noreferrer"><I n="doc" />完整紀錄</a>}
          </div>
          <details style={{ marginTop: 12 }}><summary className="small muted" style={{ cursor: 'pointer' }}>技術細節</summary><pre>{String(error)}{where}</pre></details>
        </div>
      </div>
    );
    return page ? <main className="page">{back && <a className="back" href="#/"><I n="back" s={2.2} />專案</a>}{card}</main> : card;
  }
}
