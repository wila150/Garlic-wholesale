// 確認配送單：配貨完，老闆把連結貼到 LINE 聊天室，店家點開核對品項和數量、按確認
// （現場簽收用紙本，印出來給客戶用筆簽或免簽）
import { getFirestore } from 'firebase-admin/firestore';
import { SHOP } from '../lib/config.js';
import { verifySlipToken } from '../lib/token.js';
import { json, fail, readJSON, UserError } from '../lib/http.js';
import { label } from '../lib/dates.js';
import * as shop from '../lib/shop.js';

async function slipOf(token) {
  const t = verifySlipToken(token);
  if (!t) throw new UserError('這個連結已經過期或不正確，請跟老闆要新的連結', 401);
  const [store, order, sig, dayPrices] = await Promise.all([
    getFirestore().doc('stores/' + t.storeId).get().then((d) => d.data()),
    shop.getOrder(t.date, t.storeId, t.seq),
    getFirestore().doc(`signatures/${t.date}_${t.key}`).get().then((d) => d.data()),
    shop.getDayPrices(t.date),
  ]);
  if (!store || !order?.items.length) throw new UserError('找不到這張配送單，可能已經取消了', 404);
  return { t, store, order, sig, priced: order.items.every((i) => i.pid in dayPrices) };
}

export async function GET(request) {
  try {
    const { t, store, order, sig, priced } = await slipOf(new URL(request.url).searchParams.get('t'));
    // 單價還沒全部確認（先出貨後補價）就只給數量，金額之後看對帳單
    const items = order.items.map((i) => {
      const q = shop.billQty(i);
      return { name: i.name, unit: i.unit, qty: q, ordered: i.qty, ...(priced ? { price: i.price, amount: Math.round(q * i.price) } : {}) };
    });
    return json({
      shopName: SHOP.name,
      basicId: SHOP.basicId,
      store: store.name,
      date: t.date,
      dateLabel: label(t.date),
      seq: t.seq,
      items,
      total: priced ? shop.amountOf(order) : null,
      confirmed: sig ? { at: sig.at, signer: sig.signer } : null,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const b = await readJSON(request);
    const { t, sig } = await slipOf(b.t);
    if (sig) throw new UserError('這張配送單已經確認過了', 409);
    if (b.confirmed !== true) throw new UserError('請先勾選「品項和數量正確」');
    const rec = { date: t.date, storeId: t.storeId, seq: t.seq, key: t.key, signer: String(b.signer || '').trim().slice(0, 20), by: '店家線上確認', at: new Date().toISOString() };
    await getFirestore().doc(`signatures/${t.date}_${t.key}`).set(rec);
    return json({ confirmed: { at: rec.at, signer: rec.signer } });
  } catch (e) {
    return fail(e);
  }
}
