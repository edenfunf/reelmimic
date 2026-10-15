// Who may use the bot. Anyone can add a LINE bot as a friend, so the bot answers nobody until they link their account
// with a one-time code from the computer running ReelMimic (or their user ID is listed in LINE_ALLOWED_USERS).
// A code exists only when the owner asks for one (server start, `npm run line-code`): it works for 10 minutes, once,
// and 5 wrong tries burn it. So a stranger gets at most 5 guesses at a 6-digit code per code the owner issues,
// and can't make a new one. Linked accounts are saved in a JSON file the server chooses (~/.reelmimic/line.json).
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type BotLang = 'zh' | 'en';
export interface LineUser {
  pairedAt: string;
  notify: boolean;
  lang: BotLang;
  listed?: boolean;   // allowed through LINE_ALLOWED_USERS, not a code: only valid while the ID is still listed there
}
interface State { users: Record<string, LineUser> }

export const CODE_TTL_MS = 10 * 60e3;
export const CODE_TRIES = 5;
export type PairResult = 'ok' | 'already' | 'wrong' | 'burned' | 'expired' | 'error';

export class Store {
  readonly path: string;
  private state: State;
  private preset: Set<string>;
  private code: string | null = null;
  private expires = 0;
  private wrong = 0;

  constructor(path: string, allowed = '') {
    this.path = path;
    this.preset = new Set(allowed.split(/[\s,]+/).filter(Boolean));
    let users: Record<string, LineUser> = {};
    try { users = (JSON.parse(readFileSync(path, 'utf8')) as State).users || {}; } catch (e) { if (existsSync(path)) console.error(`LINE: ${path} is not valid JSON, starting with no linked accounts (${(e as Error).message})`); }
    this.state = { users };
  }

  get(userId: string): LineUser | null {
    const u = this.state.users[userId];
    if (u) return u.listed && !this.preset.has(userId) ? null : u;
    return this.preset.has(userId) ? { pairedAt: '', notify: true, lang: 'zh', listed: true } : null;
  }
  users() {
    return [...new Set([...this.preset, ...Object.keys(this.state.users)])].flatMap((id) => { const u = this.get(id); return u ? [{ id, ...u }] : []; });
  }

  // A new code replaces the old one. Only the server's owner can call this (terminal, localhost API).
  newCode(now = Date.now()) {
    this.code = String(randomInt(0, 1e6)).padStart(6, '0'); this.expires = now + CODE_TTL_MS; this.wrong = 0;
    return { code: this.code, expiresAt: new Date(this.expires).toISOString() };
  }

  pair(userId: string, code: string, lang: BotLang, now = Date.now()): PairResult {
    if (this.get(userId)) return 'already';
    if (!this.code || now > this.expires) { this.code = null; return 'expired'; }
    if (code !== this.code) { if (++this.wrong >= CODE_TRIES) { this.code = null; return 'burned'; } return 'wrong'; }
    this.code = null;   // used up before anything else, so it can't link a second account even if saving fails
    this.state.users[userId] = { pairedAt: new Date(now).toISOString(), notify: true, lang };
    if (this.save()) return 'ok';
    delete this.state.users[userId];
    return 'error';
  }
  unpair(userId: string) { delete this.state.users[userId]; this.preset.delete(userId); this.save(); }
  set(userId: string, patch: Partial<Pick<LineUser, 'notify' | 'lang'>>) {
    const u = this.get(userId); if (!u) return;
    const next = { ...u, ...patch };
    if (next.notify === u.notify && next.lang === u.lang) return;
    this.state.users[userId] = next; this.save();
  }

  // write-then-rename, so a crash mid-write never leaves a half file. False (and a log line) when the disk refuses,
  // e.g. on Windows while another program holds the file.
  private save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 1)); renameSync(tmp, this.path);
      return true;
    } catch (e) { console.error(`LINE: could not save ${this.path}: ${(e as Error).message}`); return false; }
  }
}
