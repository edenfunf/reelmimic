// Required inputs (lyrics, product photos, logos…) and lyric timing.
// plan.required_inputs: [{ id, kind: lyrics|audio|image|text|other, label, why }]. Satisfied by a file in inputs/ (or the
// aligned lyrics), or waived by the user. Approval is blocked while any is open, so production never runs without them.
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnTool } from './runner.ts';
import { L, PY, ROOT, SCRIPTS, chat, dirOf, load, log, noPython, readJSON, readText, update } from './store.ts';
import type { Job, Plan, RequiredInput } from '../shared/types.ts';

export function requiredInputs(id: string, plan: Plan | null, job: Job): RequiredInput[] {
  const d = dirOf(id), files = existsSync(join(d, 'inputs')) ? readdirSync(join(d, 'inputs')) : [];
  return (plan?.required_inputs || []).map((r) => {
    let status: RequiredInput['status'] = 'missing';
    const given = (job.provided?.[r.id] || []).filter((f) => existsSync(join(d, f)));
    if ((job.waived || []).includes(r.id)) status = 'waived';
    else if (given.length) status = 'provided';   // uploaded for this item from the web app
    else if (r.kind === 'lyrics' && (existsSync(join(d, 'inputs', 'lyrics.txt')) || existsSync(join(d, 'analysis', 'lyrics', 'subs.lrc')) || files.some((f) => /\.lrc$/i.test(f)))) status = 'provided';
    else if (r.file && existsSync(join(d, r.file))) status = 'provided';
    else if (r.kind !== 'lyrics' && files.some((f) => f.toLowerCase().includes((r.match || r.id).toLowerCase()))) status = 'provided';
    return { ...r, status, files: given };
  });
}
export function openInputs(id: string) {
  const planPath = join(dirOf(id), 'plan.json'), plan = readJSON<Plan>(planPath);
  if (!plan && existsSync(planPath)) {
    // A plan file that exists but cannot be parsed must block approval.
    // readJSON swallows the parse error (store.ts), and (plan?.required_inputs || [])
    // would otherwise silently clear the gate.
    return [{ id: 'plan', kind: 'other', label: 'plan.json', why: 'unreadable', status: 'missing', files: [] }];
  }
  return requiredInputs(id, plan, load(id)).filter((r) => r.status === 'missing');
}
export function waive(id: string, inputId: string) { update(id, (j) => { j.waived = [...new Set([...(j.waived || []), inputId])]; j.needs = (j.needs || []).filter((n) => n.input !== inputId); }); }
export function unwaive(id: string, inputId: string) { update(id, (j) => { j.waived = (j.waived || []).filter((x) => x !== inputId); }); }

// Files uploaded for one required input (inputs/…): remember which item they answer, so any file name counts.
// A .txt for a lyrics item is taken as the lyric text. Then time the lyrics if the music is there now.
export function provideInput(id: string, inputId: string, saved: string[]) {   // records the answer now; lyric timing (≈1 min) runs in the background
  const d = dirOf(id), r = (readJSON<Plan>(join(d, 'plan.json'))?.required_inputs || []).find((x) => x.id === inputId);
  if (!r || !saved.length) return false;
  update(id, (j) => { j.provided = { ...(j.provided || {}), [inputId]: saved }; j.waived = (j.waived || []).filter((x) => x !== inputId); });
  const txt = r.kind === 'lyrics' && saved.find((f) => /\.txt$/i.test(f)), text = txt && !/(^|\/)lyrics\.txt$/i.test(txt) ? readText(join(d, txt)) : null;
  void withAlignNotice(id, text?.trim() ? saveLyrics(id, text) : alignIfReady(id));
  return true;
}
// Lyrics pasted before the music arrived are only text: time them as soon as there is audio (and again before production).
// A failed timing used to be invisible to the person who can act on it: `saveLyrics` resolves an
// `{ ok: false }` result and an `alignIfReady` rejection carries only a message, so both call
// sites dropped the outcome. Every alignment attempt now ends in a chat line when it fails - the
// job log keeps the detail, the chat says that it happened and what to do next.
export function withAlignNotice(id: string, p: Promise<LyricsResult | null>): Promise<LyricsResult | null> {
  return p
    .then((r) => {
      if (r && !r.ok) chat(id, 'system', L(id, '無法為歌詞對時；流程會繼續，之後重新貼上歌詞即可再試一次',
        'Lyrics could not be timed; the run continues, and pasting them again later will retry the alignment'));
      return r;
    })
    .catch((e: Error) => {
      chat(id, 'system', L(id, `無法為歌詞對時（${e.message}）；流程會繼續，之後重新貼上歌詞即可再試一次`,
        `Lyrics could not be timed (${e.message}); the run continues, and pasting them again later will retry the alignment`));
      return null;
    });
}
export const alignIfReadyWithNotice = (id: string) => withAlignNotice(id, alignIfReady(id));
export async function alignIfReady(id: string): Promise<LyricsResult | null> {
  const d = dirOf(id);
  if (!existsSync(join(d, 'inputs', 'lyrics.txt')) || existsSync(join(d, 'analysis', 'lyrics', 'subs.lrc')) || !musicFile(id)) return null;
  return saveLyrics(id, readText(join(d, 'inputs', 'lyrics.txt')) ?? '');
}
// The song to time lyrics against: the plan's music file, else a file the user uploaded for an audio item, else any audio in inputs/.
function musicFile(id: string): string | null {
  const d = dirOf(id), plan = readJSON<Plan>(join(d, 'plan.json')) || {}, job = load(id), AUD = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i;
  if (plan.music?.file && existsSync(join(d, plan.music.file))) return plan.music.file;
  const audioIds = (plan.required_inputs || []).filter((r) => r.kind === 'audio').map((r) => r.id);
  for (const k of audioIds) for (const f of job.provided?.[k] || []) if (AUD.test(f) && existsSync(join(d, f))) return f;
  const f = existsSync(join(d, 'inputs')) ? readdirSync(join(d, 'inputs')).find((x) => AUD.test(x) && !/^reference\./i.test(x)) : null;
  return f ? `inputs/${f}` : null;
}

// The user pastes lyrics (their text) → inputs/lyrics.txt → timed against the plan's music section → analysis/lyrics/subs.lrc
export interface LyricsResult { ok: boolean; aligned: boolean; report?: string }
export function saveLyrics(id: string, text: string): Promise<LyricsResult> {
  const d = dirOf(id); writeFileSync(join(d, 'inputs', 'lyrics.txt'), text.trim() + '\n');
  const plan = readJSON<Plan>(join(d, 'plan.json')) || {}, m = plan.music || {};
  const song = musicFile(id), audio = song ? join(d, song) : null;
  const out = join(d, 'analysis', 'lyrics'); mkdirSync(out, { recursive: true });
  if (!audio) { log(id, { type: 'text', text: L(id, '歌詞已存，收到配樂後會自動對時', 'Lyrics saved; they will be timed as soon as the music arrives') }); return Promise.resolve({ ok: true, aligned: false }); }
  const args = [join(SCRIPTS, 'align_lyrics.py'), audio, join(d, 'inputs', 'lyrics.txt'), '--out', join(out, 'subs.lrc')];
  if (m.section?.start_s != null && song && !/clip/i.test(song)) args.push('--start', String(m.section.start_s), '--end', String(m.section.end_s));
  log(id, { type: 'tool', name: 'align_lyrics.py', detail: `對時：${song}` });
  return new Promise((resolve) => {
    const p = spawnTool(id, PY, args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }); let o = '', done = false;
    p.stdout.on('data', (b) => { o += b; }); p.stderr.on('data', () => {});
    const finish = (code: number | null, err?: Error) => {
      if (done) return; done = true;
      const first = o.split('\n').find((l) => l.startsWith('lines')) || '';
      log(id, { type: code === 0 ? 'text' : 'error', text: code === 0 ? `歌詞對時完成：${first}` : err ? `歌詞對時失敗：${noPython(err)}` : '歌詞對時失敗' });
      if (code === 0) update(id, (j) => { j.needs = (j.needs || []).filter((n) => n.kind !== 'lyrics'); });
      resolve({ ok: code === 0, aligned: code === 0, report: first });
    };
    p.on('error', (e) => finish(null, e));   // e.g. Python not found: without this listener the server crashes
    p.on('close', (code) => finish(code));
  });
}
