import crypto from 'node:crypto';

const API = 'https://api.line.me/v2/bot';

export function verifySignature(raw, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('base64'));
  const got = Buffer.from(signature);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function call(path, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  // 本機模擬器設成 dry-run：只印出來，不真的送
  if (!token || token === 'dry-run') {
    console.log('[LINE 未設定，略過]', path, JSON.stringify(body).slice(0, 300));
    return;
  }
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}: ${await r.text()}`);
}

export const reply = (replyToken, messages) => call('/message/reply', { replyToken, messages });
export const push = (to, messages) => call('/message/push', { to, messages });

export async function displayName(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || token === 'dry-run') return '';
  const r = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? (await r.json()).displayName || '' : '';
}

export function adminIds() {
  return (process.env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function notifyAdmins(text) {
  const results = await Promise.allSettled(adminIds().map((id) => push(id, [{ type: 'text', text }])));
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
}
