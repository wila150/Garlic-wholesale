// AI 叫貨流程：webhook 收到 → 建 aiJobs（Firestore 觸發 aiOrder 函式處理）→ 回卡片給店家確認 → 店家按「確認送出」才成立訂單
//   aiJobs/{id}     待處理的訊息（webhook 先存起來，馬上回 200 給 LINE）
//   aiDrafts/{id}   AI 整理好的叫貨單，等店家確認
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import sharp from 'sharp';
import { parseOrder } from './ai.js';
import { reply, push, getContent } from './line.js';
import { orderLink } from './token.js';
import { openDate } from './dates.js';
import { roundQty } from './qty.js';
import * as shop from './shop.js';
import { draftMessage, orderMessage } from './messages.js';

const db = () => getFirestore();

export async function queue(job) {
  await db().collection('aiJobs').add({ ...job, at: new Date().toISOString() });
}

// 回覆用 replyToken（不算額度），過期了才改推播
async function answer(job, messages) {
  try { await reply(job.replyToken, messages); }
  catch (e) { console.warn('reply 失敗，改用 push', e.message); await push(job.userId, messages); }
}

export async function processJob(job, jobId) {
  const store = await shop.storeOfUser(job.userId);
  if (!store) return;
  const products = await shop.getProducts();
  let image;
  if (job.type === 'image') {
    // 縮小再送，AI 比較快，也不會超過大小限制
    const buf = await sharp(await getContent(job.messageId)).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    image = 'data:image/jpeg;base64,' + buf.toString('base64');
  }
  let parsed;
  try {
    parsed = await parseOrder({ text: job.text, image, products });
  } catch (e) {
    console.error('AI 辨識失敗', e);
    return answer(job, [{ type: 'text', text: '抱歉，這次沒辦法自動整理，請點下方「我要叫貨」用叫貨單叫，或直接留言給老闆。' }]);
  }
  // 什麼都看不出來（多半是聊天或別的照片），就不打擾
  if (!parsed.items.length && !parsed.unknown.length) return;

  const date = openDate();
  const ref = db().collection('aiDrafts').doc(jobId);
  const draft = { id: ref.id, storeId: store.id, userId: job.userId, date, type: job.type, text: job.text || '', ...parsed, status: 'pending', createdAt: new Date().toISOString() };
  await ref.set(draft);
  const existing = await shop.getOrder(date, store.id);
  const editUrl = `${orderLink(job.origin, job.userId)}&d=${ref.id}`;
  await answer(job, [draftMessage(store, date, draft, existing?.items.length || 0, editUrl)]);
}

// 店家按「確認送出」
export async function confirmDraft(userId, id, origin) {
  const ref = db().collection('aiDrafts').doc(id);
  const d = (await ref.get()).data();
  const store = await shop.storeOfUser(userId);
  if (!d || !store || d.storeId !== store.id) return { type: 'text', text: '找不到這張叫貨單，請重新傳一次。' };
  if (d.status !== 'pending') return { type: 'text', text: '這張叫貨單已經處理過了，點「我的訂單」可以查看。' };
  if (d.date !== openDate()) {
    await ref.update({ status: 'expired' });
    return { type: 'text', text: '這張叫貨單的配送日已經截單了，請點「我要叫貨」重新叫。' };
  }
  // 加進這次已叫的品項（同品項數量相加）
  const old = await shop.getOrder(d.date, store.id);
  const items = (old?.items || []).map((i) => ({ pid: i.pid, qty: i.qty }));
  for (const it of d.items) {
    const same = items.find((x) => x.pid === it.pid);
    if (same) same.qty = roundQty(same.qty + it.qty); else items.push({ pid: it.pid, qty: it.qty });
  }
  const { order, had } = await shop.saveOrder(store.id, d.date, items, '店家', d.type === 'image' ? 'LINE 照片叫貨' : 'LINE 文字叫貨');
  await ref.update({ status: 'confirmed', confirmedAt: FieldValue.serverTimestamp() });
  return orderMessage(had ? '訂單已更新' : '訂單已收到', store, d.date, order, orderLink(origin, userId));
}

// 叫貨頁「用叫貨單修改」時帶入 AI 整理的品項
export async function draftFor(userId, id) {
  const d = (await db().collection('aiDrafts').doc(id).get()).data();
  const store = await shop.storeOfUser(userId);
  if (!d || !store || d.storeId !== store.id || d.status !== 'pending' || d.date !== openDate()) return null;
  return { id: d.id, items: d.items.map(({ pid, qty }) => ({ pid, qty })), unknown: d.unknown };
}

export const markDraftUsed = (id) => db().collection('aiDrafts').doc(id).update({ status: 'edited' }).catch(() => {});
