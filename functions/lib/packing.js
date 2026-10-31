// 分裝：照店家的訂單一包一包分好，記下哪幾包分好了、這個品項用了多少原料（算損耗、成本、利潤）
//   packing/{配送日}  { done: { "店[-補單號]|品項": true }, raw: { 品項: { from: 原料品項, qty: 原料用量（原料的單位）, by, at } } }
//   原料有管庫存（settings/stock）的話，記用量時從庫存扣，改用量只扣差額；stockMoves 記成 type: 'pack'
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { isDate } from './dates.js';
import { getProducts } from './shop.js';
import { roundQty } from './qty.js';

const db = () => getFirestore();
const ref = (date) => db().doc('packing/' + date);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const need = (date) => { if (!isDate(date)) throw new UserError('日期不正確'); };

// 換成台斤；原料和成品都是重量單位才算得出損耗
export const JIN = { 斤: 1, 台斤: 1, 兩: 1 / 16, 公斤: 1 / 0.6 };
export function convert(qty, from, to) {
  if (from === to) return qty;
  if (JIN[from] && JIN[to]) return roundQty((qty * JIN[from]) / JIN[to]);
  return null;
}

export async function getPacking(date) {
  need(date);
  const d = (await ref(date).get()).data() || {};
  return { done: d.done || {}, raw: d.raw || {} };
}

export async function setDone(date, keys, done) {
  need(date);
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => clean(k, 80)).filter((k) => k.includes('|'));
  if (!list.length) throw new UserError('沒有要勾的');
  await ref(date).set({ done: Object.fromEntries(list.map((k) => [k, done ? true : FieldValue.delete()])) }, { merge: true });
  return getPacking(date);
}

// 記原料用量：qty 空白＝清掉；有管庫存的原料照差額扣
export async function setRaw(date, input, who) {
  need(date);
  const pm = Object.fromEntries((await getProducts()).map((p) => [p.id, p]));
  const pid = clean(input.pid, 30), p = pm[pid];
  if (!p) throw new UserError('找不到這個品項，請重新整理');
  const from = pm[clean(input.from, 30)] || p;
  const clear = input.qty === '' || input.qty == null;
  const qty = clear ? 0 : roundQty(Number(input.qty));
  if (!clear && !(qty > 0 && qty < 100000)) throw new UserError('原料用量不正確');
  await db().runTransaction(async (tx) => {
    const [cur, stock] = await Promise.all([tx.get(ref(date)), tx.get(db().doc('settings/stock'))]);
    const old = cur.data()?.raw?.[pid];
    const items = stock.data()?.items || {};
    const now = new Date().toISOString();
    // 先把舊的用量加回原本的原料，再扣新的（換了原料也對）
    const delta = {};
    if (old?.from && old.from in items) delta[old.from] = (delta[old.from] || 0) + old.qty;
    if (!clear && from.id in items) delta[from.id] = (delta[from.id] || 0) - qty;
    for (const [id, d] of Object.entries(delta)) {
      const dq = roundQty(d);
      if (!dq) continue;
      const after = roundQty((items[id] || 0) + dq);
      tx.set(db().doc('settings/stock'), { items: { [id]: after } }, { merge: true });
      const m = db().collection('stockMoves').doc();
      tx.set(m, { id: m.id, at: now, by: clean(who, 40), pid: id, name: pm[id]?.name || '', unit: pm[id]?.unit || '', delta: dq, type: 'pack', note: `${date.slice(5)} 分裝${p.name}`, after });
    }
    tx.set(ref(date), { raw: { [pid]: clear ? FieldValue.delete() : { from: from.id, qty, by: clean(who, 40), at: now } } }, { merge: true });
  });
  return getPacking(date);
}

// 一個品項一天的分裝結果：出貨量、原料用量（換成成品單位）、損耗、原料成本、營收、毛利
//   items：這天這個品項各店的 { qty（實出）, price }；cost：原料一單位的進價（沒填就是 null）
export function packStat({ unit, items, raw, rawUnit, cost }) {
  const out = roundQty(items.reduce((a, i) => a + i.qty, 0));
  const revenue = Math.round(items.reduce((a, i) => a + i.qty * i.price, 0));
  if (!raw) return { out, revenue };
  const used = convert(raw.qty, rawUnit, unit);
  const loss = used == null ? null : roundQty(used - out);
  const rawCost = cost == null ? null : Math.round(raw.qty * cost);
  return {
    out, revenue, rawQty: raw.qty, rawUnit, used, loss,
    lossRate: used ? Math.round(((used - out) / used) * 1000) / 10 : null,
    rawCost, unitCost: rawCost != null && out ? Math.round((rawCost / out) * 10) / 10 : null,
    gross: rawCost == null ? null : revenue - rawCost,
  };
}
