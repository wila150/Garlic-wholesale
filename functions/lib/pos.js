// 門市收銀（POS）：不接線上金流，付款方式只是記下來
//   sales/{id}       { id, no, date, at, items: [{ pid, name, unit, qty, price, amount }], subtotal, discount, total,
//                      method, paid, change, by, void: false | { at, by, reason } }
//   posDays/{日期}    { seq }：當天第幾張收據（收據號 1031-001）
// 單價用品項的「門市價」（retail），沒填就用批發的最新單價
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { today, isDate } from './dates.js';
import { getProducts } from './shop.js';
import { roundQty } from './qty.js';

const db = () => getFirestore();
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
export const PAY = ['現金', '轉帳', 'LINE Pay', '刷卡', '其他'];
export const retailOf = (p) => (p.retail != null && p.retail !== '' ? Number(p.retail) : Number(p.price) || 0);

export async function checkout(input, who) {
  const pm = Object.fromEntries((await getProducts()).map((p) => [p.id, p]));
  const lines = (Array.isArray(input.items) ? input.items : []).map((i) => {
    const p = pm[i.pid];
    if (!p) throw new UserError('有品項已經不存在，請重新整理');
    const qty = roundQty(Number(i.qty));
    if (!(qty > 0 && qty < 10000)) throw new UserError(`「${p.name}」數量不正確`);
    // 單價可以在收銀時改（議價），沒改就用門市價
    const price = i.price != null && i.price !== '' ? Math.round(Number(i.price) * 100) / 100 : retailOf(p);
    if (!(price >= 0)) throw new UserError(`「${p.name}」單價不正確`);
    return { pid: p.id, name: p.name, unit: p.unit, qty, price, amount: Math.round(qty * price) };
  });
  if (!lines.length) throw new UserError('還沒有選品項');
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const discount = Math.max(0, Math.min(subtotal, Math.round(Number(input.discount) || 0))); // 抹零、折扣
  const total = subtotal - discount;
  const method = PAY.includes(input.method) ? input.method : '現金';
  const paid = method === '現金' ? Math.round(Number(input.paid) || total) : total;
  if (paid < total) throw new UserError('收的錢不夠');
  const date = today();
  const ref = db().collection('sales').doc();
  const sale = await db().runTransaction(async (tx) => {
    const dref = db().doc('posDays/' + date);
    const seq = ((await tx.get(dref)).data()?.seq || 0) + 1;
    const s = { id: ref.id, no: `${date.slice(5).replace('-', '')}-${String(seq).padStart(3, '0')}`, date, month: date.slice(0, 7), at: new Date().toISOString(),
      items: lines, subtotal, discount, total, method, paid, change: paid - total, by: clean(who, 40), void: false };
    tx.set(dref, { seq }, { merge: true });
    tx.set(ref, s);
    return s;
  });
  return sale;
}

export async function voidSale(id, who, reason) {
  const ref = db().doc('sales/' + clean(id, 40).replace(/[^\w-]/g, '_'));
  return db().runTransaction(async (tx) => {
    const s = (await tx.get(ref)).data();
    if (!s) throw new UserError('找不到這張單', 404);
    if (s.void) throw new UserError('這張單已經作廢了');
    if (s.date !== today()) throw new UserError('只能作廢今天的單');
    const v = { at: new Date().toISOString(), by: clean(who, 40), reason: clean(reason, 60) };
    tx.update(ref, { void: v });
    return { ...s, void: v };
  });
}

export async function salesOf(date) {
  if (!isDate(date)) throw new UserError('日期不正確');
  const snap = await db().collection('sales').where('date', '==', date).get();
  return snap.docs.map((d) => d.data()).sort((a, b) => b.at.localeCompare(a.at));
}

export async function salesOfMonth(month) {
  const snap = await db().collection('sales').where('month', '==', month).get();
  return snap.docs.map((d) => d.data()).filter((s) => !s.void);
}

// 日結：筆數、總額、各付款方式
export function summary(sales) {
  const ok = sales.filter((s) => !s.void);
  const by = {};
  for (const s of ok) by[s.method] = (by[s.method] || 0) + s.total;
  return { count: ok.length, total: ok.reduce((a, s) => a + s.total, 0), voided: sales.length - ok.length, by };
}
