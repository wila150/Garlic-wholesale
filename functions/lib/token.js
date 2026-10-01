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
