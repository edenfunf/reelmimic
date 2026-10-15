// LINE Messaging API: the webhook signature check and the two calls the bot makes (reply, push). Nothing else talks to LINE.
// https://developers.line.biz/en/reference/messaging-api/
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const API = 'https://api.line.me/v2/bot';
export const TEXT_MAX = 5000;        // characters per text message
export const MESSAGES_MAX = 5;       // messages per reply / push
export const QUICK_MAX = 13;         // quick-reply buttons per message
export const LABEL_MAX = 20;         // characters per quick-reply label

export interface QuickReplyItem { type: 'action'; action: { type: 'message'; label: string; text: string } }
export interface TextMessage { type: 'text'; text: string; quickReply?: { items: QuickReplyItem[] } }
export type LineMessage = TextMessage;

// Every webhook request is signed: base64(HMAC-SHA256(channel secret, raw body)) in the x-line-signature header.
export function verifySignature(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const want = createHmac('sha256', secret).update(body).digest(), got = Buffer.from(signature, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

// Buttons under a message that send a command when tapped (labels are cut to LINE's limit).
export const quick = (items: { label: string; text: string }[]) => ({
  items: items.slice(0, QUICK_MAX).map((i): QuickReplyItem => ({ type: 'action', action: { type: 'message', label: [...i.label].slice(0, LABEL_MAX).join(''), text: i.text } })),
});

export const text = (t: string, quickReply?: TextMessage['quickReply']): TextMessage => {
  const chars = [...t];
  return { type: 'text', text: chars.length > TEXT_MAX ? chars.slice(0, TEXT_MAX - 1).join('') + '…' : t, ...(quickReply?.items.length ? { quickReply } : {}) };
};

// One attempt, or for push a few: a network error, 429 or 5xx is retried with the same X-Line-Retry-Key, so LINE
// delivers the message once even if an earlier attempt did arrive (it answers 409 to the duplicate).
async function call(token: string, path: string, body: object, { attempts = 1, retryKey }: { attempts?: number; retryKey?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(retryKey ? { 'X-Line-Retry-Key': retryKey } : {}) };
  for (let i = 1; i <= attempts; i++) {
    let retry: boolean;
    try {
      const r = await fetch(`${API}${path}`, { method: 'POST', signal: AbortSignal.timeout(15000), headers, body: JSON.stringify(body) });
      if (r.ok || (retryKey && r.status === 409 && i > 1)) return true;
      retry = r.status === 429 || r.status >= 500;
      console.error(`LINE ${path} answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    } catch (e) { retry = true; console.error(`LINE ${path} failed: ${(e as Error).message}`); }
    if (!retry || i === attempts) break;
    await new Promise((res) => setTimeout(res, RETRY_MS * i));
  }
  return false;
}
const RETRY_MS = +(process.env.LINE_RETRY_MS || 2000);   // wait before retry n is n × this (tests set it low)

// Reply to a webhook event: free, but the token is single-use and expires about a minute after the event, so no retry.
export const reply = (token: string, replyToken: string, messages: LineMessage[]) => call(token, '/message/reply', { replyToken, messages: messages.slice(0, MESSAGES_MAX) });
// Message someone unprompted (counts against the channel's monthly message quota).
export const push = (token: string, to: string, messages: LineMessage[]) => call(token, '/message/push', { to, messages: messages.slice(0, MESSAGES_MAX) }, { attempts: 3, retryKey: randomUUID() });
