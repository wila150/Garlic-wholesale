// 訂購連結裡的簽章：證明這個連結是機器人發給某位 LINE 使用者的，不用另外登入
import crypto from 'node:crypto';
import { SHOP } from './config.js';

const DAYS = 7;
const key = () => 'order-link:' + (process.env.LINE_CHANNEL_SECRET || 'dev');
const mac = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');

export function sign(userId) {
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  const payload = `${userId}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${mac(payload)}`;
}

export function verify(token) {
  const [p64, sig] = String(token || '').split('.');
  if (!p64 || !sig) return null;
  const payload = Buffer.from(p64, 'base64url').toString();
  const want = Buffer.from(mac(payload));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [userId, exp] = payload.split('.');
  if (!userId || !(+exp > Date.now() / 1000)) return null;
  return userId;
}

// 叫貨頁連結：有設定 LIFF 就用 LIFF 開（送出後可以直接在聊天室回訂單卡）
export const orderLink = (origin, userId) =>
  SHOP.liffId ? `https://liff.line.me/${SHOP.liffId}?t=${sign(userId)}` : `${origin}/?t=${sign(userId)}`;

// 簽收連結：老闆自己在聊天室傳給店家（不算推播額度），店家點開簽名。內容是「配送日_出貨單代號」
const signMac = (s) => crypto.createHmac('sha256', 'sign-link:' + (process.env.LINE_CHANNEL_SECRET || 'dev')).update(s).digest('base64url');
export function signSlipToken(date, key, days = 7) {
  const payload = `${date}_${key}.${Math.floor(Date.now() / 1000) + days * 86400}`;
  return `${Buffer.from(payload).toString('base64url')}.${signMac(payload)}`;
}
export function verifySlipToken(token) {
  const [p64, sig] = String(token || '').split('.');
  if (!p64 || !sig) return null;
  const payload = Buffer.from(p64, 'base64url').toString();
  const want = Buffer.from(signMac(payload));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [id, exp] = payload.split('.');
  const m = id?.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
  if (!m || !(+exp > Date.now() / 1000)) return null;
  const [, date, key] = m;
  return { date, key, storeId: key.replace(/-\d+$/, ''), seq: +(key.match(/-(\d+)$/)?.[1] || 1) };
}
