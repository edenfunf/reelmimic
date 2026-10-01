// ReelMimic server: REST + SSE over the job machine in jobs.ts, and static files (the built UI and project files).
//   node server/index.ts             → http://localhost:4318
import './env.ts';   // first: API keys / tool paths from ~/.reelmimic/secrets.json
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import type { AgentStatus } from '../shared/types.ts';
import { agentStatus } from './agents/index.ts';
import * as J from './jobs.ts';
import { startNotifier } from './notify.ts';
// Ctrl+C / kill: stop the agents first (the next start marks their turns interrupted, and Retry resumes them)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { J.stopAll(); setTimeout(() => process.exit(0), 800); });

const PORT = +(process.env.PORT || 4318);
const app = express();
app.use(express.json({ limit: '2mb' }));
mkdirSync(J.PROJECTS, { recursive: true });
const upload = multer({ dest: join(J.PROJECTS, '.uploads'), limits: { fileSize: 2 * 1024 ** 3 } });

const slug = () => new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 7);
// multer hands over multipart filenames as latin1; browsers send UTF-8
type Upload = Express.Multer.File;
const fileName = (f: Upload) => safeName(Buffer.from(f.originalname, 'latin1').toString('utf8'));
const safeName = (n: string) => n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
const isUrl = (s: string | undefined) => /^https?:\/\/\S+$/i.test((s || '').trim());
const guard = (res: Response, id: string) => { if (!/^[\w-]+$/.test(id) || !existsSync(join(J.dirOf(id), 'job.json'))) { res.status(404).json({ error: 'no such project' }); return false; } return true; };

let AGENTS: AgentStatus | null = null;
app.get('/api/agents', (req, res) => { AGENTS = AGENTS || agentStatus(); res.json(AGENTS); });
app.get('/api/projects', (req, res) => res.json(J.listJobs()));

// New project: a reference (file upload or URL) + brief + agent, optional music / assets / lyrics files.
app.post('/api/projects', upload.fields([{ name: 'reference', maxCount: 1 }, { name: 'inputs', maxCount: 20 }]), (req, res) => {
  const { url, brief = '', agent = 'claude', title } = req.body, lang = ['zh-TW', 'en', 'zh-CN'].includes(req.body.lang) ? req.body.lang : 'zh-TW';
  const files = req.files as Record<string, Upload[]> | undefined, ref = files?.reference?.[0];
  if (!ref && !isUrl(url)) return res.status(400).json({ error: '請上傳參考影片或貼上影片連結' });
  if (!['claude', 'codex'].includes(agent)) return res.status(400).json({ error: 'agent 必須是 claude 或 codex' });
  if (/�/.test(brief + (title || ''))) return res.status(400).json({ error: '需求文字編碼錯誤（請用 UTF-8 送出）' });
  // optional review/fix round limits for this project (castRounds, chunkRounds, finalRounds: whole numbers 1–10)
  let settings;
  try { settings = Object.fromEntries(Object.entries(J.cleanRounds(req.body)).filter(([, v]) => v != null)); }
  catch (e) { for (const f of Object.values(files || {}).flat()) try { unlinkSync(f.path); } catch {} return res.status(400).json({ error: (e as Error).message }); }
  const id = slug();
  const job = J.createJob({ id, title: (title || brief.split('\n')[0] || '未命名').slice(0, 40), agent, brief, lang, settings,
    reference: ref ? { type: 'file', src: 'inputs/reference' + (extname(ref.originalname) || '.mp4') } : { type: 'url', src: url.trim() } });
  if (ref) renameSync(ref.path, join(J.dirOf(id), job.reference.src));
  for (const f of files?.inputs || []) renameSync(f.path, join(J.dirOf(id), 'inputs', fileName(f)));
  J.start(id).catch((e) => console.error(e));
  res.json({ id });
});

app.get('/api/projects/:id', (req, res) => { if (guard(res, req.params.id)) res.json(J.snapshot(req.params.id)); });

// Extra inputs later (e.g. the user finds their song file during plan review).
// ?to=attachments → chat attachments (inputs/attachments/, timestamped so repeats don't overwrite); returns the saved paths
app.post('/api/projects/:id/inputs', upload.array('inputs', 20), async (req, res) => {
  if (!guard(res, req.params.id)) return;
  const attach = req.query.to === 'attachments', sub = attach ? join('inputs', 'attachments') : 'inputs';
  mkdirSync(join(J.dirOf(req.params.id), sub), { recursive: true });
  const saved = [];
  for (const f of (req.files as Upload[] | undefined) || []) {
    const name = (attach ? `${Date.now().toString(36)}_` : '') + fileName(f);
    renameSync(f.path, join(J.dirOf(req.params.id), sub, name)); saved.push(`${sub.split(sep).join('/')}/${name}`);
  }
  // ?for=<required input id>: these files answer that item (any file name); lyrics text/timing is handled there
  if (!attach && req.query.for) J.provideInput(req.params.id, String(req.query.for), saved);
  else if (!attach) J.alignIfReady(req.params.id).catch(() => null);   // background: lyrics waiting for music
  J.touch(req.params.id);
  res.json({ ...J.snapshot(req.params.id), saved });
});

const act = (fn: (id: string, text: string, meta: J.MessageMeta) => unknown) => (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params; if (!guard(res, id)) return;
  if (J.busy(id) && fn !== J.cancel && !(fn === J.message && J.PRE_PLAN.includes(J.load(id).stage))) return res.status(409).json({ error: 'agent 正在工作中，請等這一輪完成' });
  Promise.resolve(fn(id, req.body?.text, req.body?.meta || {})).catch((e) => console.error(e));
  res.json({ ok: true });
};
app.post('/api/projects/:id/message', (req, res) => { if (!(req.body?.text || '').trim() && !(req.body?.meta?.attachments || []).length) return res.status(400).json({ error: 'empty' }); act(J.message)(req, res); });
// Approve: blocked (409) while a required input is open — production never starts without it.
app.post('/api/projects/:id/approve', (req, res) => {
  const { id } = req.params; if (!guard(res, id)) return;
  if (J.busy(id)) return res.status(409).json({ error: 'agent 正在工作中，請等這一輪完成' });
  const open = J.openInputs(id);
  if (open.length) return res.status(409).json({ error: '還有需要你提供或略過的素材：' + open.map((r) => r.label || r.id).join('、'), open });
  J.approve(id).catch((e) => console.error(e)); res.json({ ok: true });
});
// Lyrics: the user pastes the text; the server times it against the plan's music section.
app.post('/api/projects/:id/lyrics', async (req, res) => {
  const { id } = req.params; if (!guard(res, id)) return;
  const text = (req.body?.text || '').trim(); if (!text) return res.status(400).json({ error: '請貼上歌詞文字' });
  res.json(await J.saveLyrics(id, text));
});
app.post('/api/projects/:id/waive', (req, res) => { const { id } = req.params; if (!guard(res, id)) return; J.waive(id, String(req.body?.input || '')); res.json(J.snapshot(id)); });
app.post('/api/projects/:id/unwaive', (req, res) => { const { id } = req.params; if (!guard(res, id)) return; J.unwaive(id, String(req.body?.input || '')); res.json(J.snapshot(id)); });
app.post('/api/projects/:id/resume', act(J.resume));
app.post('/api/projects/:id/accept', act(J.accept));
// Review/fix round limits for this project. Allowed any time (also while agents work): the next check uses the new value.
app.post('/api/projects/:id/settings', (req, res) => {
  if (!guard(res, req.params.id)) return;
  try { res.json(J.setRounds(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.get('/api/config', (req, res) => res.json(J.CONFIG));
app.post('/api/projects/:id/retry', act(J.retry));
app.post('/api/projects/:id/critique', act(J.critique));
app.post('/api/projects/:id/cancel', (req, res) => { if (guard(res, req.params.id)) { J.cancel(req.params.id); res.json({ ok: true }); } });

// Live events for one project (Server-Sent Events).
app.get('/api/projects/:id/events', (req, res) => {
  const { id } = req.params; if (!guard(res, id)) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (jid: string, ev: J.BusEvent) => { if (jid === id) res.write(`data: ${JSON.stringify(ev.type === 'job' ? { type: 'job', stage: ev.job.stage } : ev)}\n\n`); };
  J.bus.on('job', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); J.bus.off('job', send); });
});

// Project files (images, video, markdown), confined to the project folder.
app.get<'/files/:id/*', { id: string; 0: string }>('/files/:id/*', (req, res) => {
  const { id } = req.params; if (!guard(res, id)) return;
  const base = resolve(J.dirOf(id)), p = resolve(base, req.params[0]);
  if (!p.startsWith(base + sep) || !existsSync(p)) return res.status(404).end();
  res.set('Cache-Control', 'no-cache'); res.sendFile(p);
});

// The built UI (npm run build → app/dist); in dev, Vite serves it and proxies /api and /files here.
const dist = join(import.meta.dirname, '..', 'dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get(/^\/(?!api|files).*/, (req, res) => res.sendFile(join(dist, 'index.html'))); }

J.recoverOrphans();
if (startNotifier()) console.log('Notifications on (Discord / webhook)');
app.listen(PORT, '127.0.0.1', () => console.log(`ReelMimic → http://localhost:${PORT}`));
