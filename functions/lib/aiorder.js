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

// 用 LINE 的 webhookEventId 當文件 ID：LINE 重送同一個事件時 create 會失敗，就不會重複辨識、重複回卡片
export async function queue(job, eventId) {
  const col = db().collection('aiJobs');
  const ref = eventId ? col.doc(String(eventId).replace(/[^\w-]/g, '')) : col.doc();
  if (eventId && (await db().collection('aiDrafts').doc(ref.id).get()).exists) return; // 已經處理過（aiJobs 處理完會刪掉，所以也查 aiDrafts）
  await ref.create({ ...job, at: new Date().toISOString() }).catch((e) => { if (e.code !== 6) throw e; }); // 6＝ALREADY_EXISTS
}

// 回覆用 replyToken（不算額度），過期了才改推播
async function answer(job, messages) {
  try { await reply(job.replyToken, messages); }
  catch (e) { console.warn('reply 失敗，改用 push', e.message); await push(job.userId, messages); }
}

export async function processJob(job, jobId) {
  const store = await shop.storeOfUser(job.userId);
  if (!store) return;
  const [products, storeAliases] = await Promise.all([shop.getProducts(), shop.getStoreAliases(store.id)]);
  const date = openDate();
  const ref = db().collection('aiDrafts').doc(jobId);
  if ((await ref.get()).exists) return; // 重送的事件，處理過了
  // 每一筆都留紀錄（含失敗），後台「AI 紀錄」看得到
  const base = { id: ref.id, storeId: store.id, storeName: store.name, userId: job.userId, date, type: job.type, text: job.text || '', items: [], unknown: [], note: '', createdAt: new Date().toISOString() };
  let image, thumb = '';
  let parsed;
  try {
    if (job.type === 'image') {
      // 縮小再送，AI 比較快，也不會超過大小限制；另外存一張小縮圖給後台看
      const raw = await getContent(job.messageId);
      // 手寫單：轉灰階、拉對比、稍微銳利化，字比較清楚
      const buf = await sharp(raw).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).grayscale().normalize().sharpen().jpeg({ quality: 85 }).toBuffer();
      image = 'data:image/jpeg;base64,' + buf.toString('base64');
      // 原圖不留（在 LINE 那邊）；後台看的縮圖約 50～90KB（看得清楚手寫字），店家確認後就刪，其他的 14 天後自動清掉
      thumb = 'data:image/jpeg;base64,' + (await sharp(raw).rotate().resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 60, mozjpeg: true }).toBuffer()).toString('base64');
    }
    const t = Date.now();
    parsed = await parseOrder({ text: job.text, image, products, storeAliases });
    console.log('AI 叫貨', JSON.stringify({ store: store.name, type: job.type, ms: Date.now() - t, items: parsed.items.length, unknown: parsed.unknown }));
  } catch (e) {
    console.error('AI 辨識失敗', store.name, job.type, e);
    await ref.set({ ...base, thumb, status: 'error', error: String(e.message || e).slice(0, 300) });
    return answer(job, [{ type: 'text', text: '抱歉，這次沒辦法自動整理，請點下方「我要叫貨」用叫貨單叫，或直接留言給老闆。' }]);
  }
  // 什麼都看不出來（多半是聊天或別的照片），就不打擾店家，但留紀錄
  if (!parsed.items.length && !parsed.unknown.length) {
    await ref.set({ ...base, ...parsed, thumb, status: 'empty' });
    return;
  }
  const draft = { ...base, ...parsed, thumb, status: 'pending' };
  await ref.set(draft);
  const existing = await shop.getOrder(date, store.id);
  const editUrl = `${orderLink(job.origin, job.userId)}&d=${ref.id}`;
  await answer(job, [draftMessage(store, date, draft, existing?.items.length || 0, editUrl)]);
}

// 店家按「確認送出」
// 連按兩下或 LINE 重送 postback 時，只有第一次會成立：先用 transaction 把狀態從 pending 改成 confirming（搶到的才往下做）
export async function confirmDraft(userId, id, origin) {
  const ref = db().collection('aiDrafts').doc(String(id || '') || '_');
  const store = await shop.storeOfUser(userId);
  const claim = await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || !store || d.storeId !== store.id) return { msg: '找不到這張叫貨單，請重新傳一次。' };
    if (d.status !== 'pending') return { msg: '這張叫貨單已經處理過了，點「我的訂單」可以查看。' };
    if (d.date !== openDate()) { tx.update(ref, { status: 'expired' }); return { msg: '這張叫貨單的配送日已經截單了，請點「我要叫貨」重新叫。' }; }
    tx.update(ref, { status: 'confirming' });
    return { d };
  });
  if (!claim.d) return { type: 'text', text: claim.msg };
  const d = claim.d;
  let saved;
  try {
    // 加進這次已叫的品項（同品項數量相加）；在 saveOrder 的 transaction 裡讀最新的單再加
    saved = await shop.saveOrder(store.id, d.date, (old) => {
      const items = (old?.items || []).map((i) => ({ pid: i.pid, qty: i.qty }));
      for (const it of d.items) {
        const same = items.find((x) => x.pid === it.pid);
        if (same) same.qty = roundQty(same.qty + it.qty); else items.push({ pid: it.pid, qty: it.qty });
      }
      return items;
    }, '店家', d.type === 'image' ? 'LINE 照片叫貨' : 'LINE 文字叫貨');
  } catch (e) {
    // 只有「訂單沒存成功」才放回 pending，店家可以再按一次；存成功之後的錯誤不能放回去，不然會重複加
    await ref.update({ status: 'pending' }).catch(() => {});
    if (e.status) return { type: 'text', text: e.message };
    throw e;
  }
  await ref.update({ status: 'confirmed', confirmedAt: FieldValue.serverTimestamp(), thumb: FieldValue.delete() });
  return orderMessage(saved.had ? '訂單已更新' : '訂單已收到', store, d.date, saved.order, orderLink(origin, userId));
}

// 叫貨頁「用叫貨單修改」時帶入 AI 整理的品項
export async function draftFor(userId, id) {
  const d = (await db().collection('aiDrafts').doc(id).get()).data();
  const store = await shop.storeOfUser(userId);
  if (!d || !store || d.storeId !== store.id || d.status !== 'pending' || d.date !== openDate()) return null;
  return { id: d.id, items: d.items.map(({ pid, qty }) => ({ pid, qty })), unknown: d.unknown };
}

// 後台「對照改單」：行政看著照片把這家店那天的訂單改好（整張單照畫面上的存）
export async function applyDraft(id, items, who) {
  const ref = db().collection('aiDrafts').doc(id);
  const d = (await ref.get()).data();
  if (!d) throw new Error('找不到這筆 AI 紀錄');
  const r = await shop.saveOrder(d.storeId, d.date, items, '後台', `${who}・對照${d.type === 'image' ? '照片' : '訊息'}改單`);
  await ref.update({ status: 'admin', handledBy: who, handledAt: new Date().toISOString() });
  return r;
}

export const markDraftUsed = (id) => db().collection('aiDrafts').doc(id).update({ status: 'edited', thumb: FieldValue.delete() }).catch(() => {});

// 每天清一次：14 天前的照片縮圖刪掉（文字紀錄留著）
export async function cleanOldPhotos(days = 14) {
  const before = new Date(Date.now() - days * 86400e3).toISOString();
  const snap = await db().collection('aiDrafts').where('createdAt', '<', before).get();
  const old = snap.docs.filter((d) => d.data().thumb);
  for (let i = 0; i < old.length; i += 400) {
    const b = db().batch();
    old.slice(i, i + 400).forEach((d) => b.update(d.ref, { thumb: FieldValue.delete() }));
    await b.commit();
  }
  console.log(`清掉 ${old.length} 張 AI 叫貨照片縮圖`);
}
