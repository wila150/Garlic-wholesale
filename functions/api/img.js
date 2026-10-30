// 傳給 LINE 的圖片（例如催款附的對帳單）：LINE 要一個公開的 https 網址才抓得到圖
//   pushImages/{id} { data: base64, type, at }；id 是隨機長字串，猜不到
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { UserError } from '../lib/http.js';

const MAX = 900 * 1024; // Firestore 一份文件最多 1MB

// dataUrl：data:image/jpeg;base64,…  回傳圖片網址
export async function saveImage(dataUrl, origin) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new UserError('圖片格式不正確');
  if (m[2].length * 0.75 > MAX) throw new UserError('圖片太大');
  const id = crypto.randomBytes(18).toString('base64url');
  await getFirestore().doc('pushImages/' + id).set({ data: m[2], type: m[1], at: new Date().toISOString() });
  return `${origin}/api/img?id=${id}`;
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[\w-]{20,40}$/.test(id)) return new Response('Not found', { status: 404 });
  const d = (await getFirestore().doc('pushImages/' + id).get()).data();
  if (!d) return new Response('Not found', { status: 404 });
  return new Response(Buffer.from(d.data, 'base64'), { headers: { 'Content-Type': d.type, 'Cache-Control': 'public, max-age=86400' } });
}

// 60 天前的圖片刪掉
export async function cleanOldImages(days = 60) {
  const before = new Date(Date.now() - days * 86400e3).toISOString();
  const snap = await getFirestore().collection('pushImages').where('at', '<', before).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = getFirestore().batch();
    snap.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  console.log(`清掉 ${snap.size} 張推播圖片`);
}
