// 門市收銀（POS）：不接線上金流，付款方式只是記下來
//   sales/{id}        { id, no, date, at, items: [{ pid, name, unit, qty, price, amount }], subtotal, discount, total,
//                       method, paid, change, by, customer: { id, name } | null, void: false | { at, by, reason } }
//   posDays/{日期}     { seq, open: { at, by, cash } | null, moves: [{ id, at, by, type: 'in'|'out', amount, note }],
//                       close: { at, by, counted, expected, diff, note } | null }：收據號、錢櫃、日結
//   posHolds/{id}     { id, at, by, name, items, discount, customer }：掛單
//   settings/stock    { items: { pid: 數量 }, low: { pid: 低於多少提醒 } }：庫存（有在這裡的品項才算有管庫存）
//   stockMoves/{id}   { id, at, by, pid, name, unit, delta, type: 'in'|'adjust', note, after }：進貨、盤點紀錄
//   customers/{id}    { id, name, phone, note, discount（打幾折，例如 95）, total, visits, lastAt }：常客
// 單價用品項的「門市價」（retail），沒填就用批發的最新單價
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { today, isDate } from './dates.js';
import { getProducts } from './shop.js';
import { roundQty } from './qty.js';

const db = () => getFirestore();
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const safeId = (id) => clean(id, 40).replace(/[^\w-]/g, '_') || '_';
const now = () => new Date().toISOString();
const money = (v) => Math.round(Number(v) || 0);
export const PAY = ['現金', '轉帳', 'LINE Pay', '刷卡', '其他'];
export const retailOf = (p) => (p.retail != null && p.retail !== '' ? Number(p.retail) : Number(p.price) || 0);
const stockRef = () => db().doc('settings/stock');

function linesOf(items, pm) {
  return (Array.isArray(items) ? items : []).map((i) => {
    const p = pm[i.pid];
    if (!p) throw new UserError('有品項已經不存在，請重新整理');
    const qty = roundQty(Number(i.qty));
    if (!(qty > 0 && qty < 10000)) throw new UserError(`「${p.name}」數量不正確`);
    // 單價可以在收銀時改（議價），沒改就用門市價
    const price = i.price != null && i.price !== '' ? Math.round(Number(i.price) * 100) / 100 : retailOf(p);
    if (!(price >= 0)) throw new UserError(`「${p.name}」單價不正確`);
    return { pid: p.id, name: p.name, unit: p.unit, qty, price, amount: Math.round(qty * price) };
  });
}

/* ---------- 結帳、作廢 ---------- */
export async function checkout(input, who) {
  const pm = Object.fromEntries((await getProducts()).map((p) => [p.id, p]));
  const lines = linesOf(input.items, pm);
  if (!lines.length) throw new UserError('還沒有選品項');
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const discount = Math.max(0, Math.min(subtotal, money(input.discount))); // 抹零、會員折扣
  const total = subtotal - discount;
  const method = PAY.includes(input.method) ? input.method : '現金';
  const paid = method === '現金' ? money(input.paid) || total : total;
  if (paid < total) throw new UserError('收的錢不夠');
  const date = today();
  const ref = db().collection('sales').doc();
  const cref = input.customerId ? db().doc('customers/' + safeId(input.customerId)) : null;
  return db().runTransaction(async (tx) => {
    const dref = db().doc('posDays/' + date);
    const [day, stock, cust] = await Promise.all([tx.get(dref), tx.get(stockRef()), cref ? tx.get(cref) : null]);
    const seq = (day.data()?.seq || 0) + 1;
    const c = cust?.data();
    const s = { id: ref.id, no: `${date.slice(5).replace('-', '')}-${String(seq).padStart(3, '0')}`, date, month: date.slice(0, 7), at: now(),
      items: lines, subtotal, discount, total, method, paid, change: paid - total, by: clean(who, 40),
      customer: c ? { id: c.id, name: c.name } : null, void: false };
    tx.set(dref, { seq }, { merge: true });
    tx.set(ref, s);
    // 有管庫存的品項，賣出就扣
    const have = stock.data()?.items || {};
    const dec = {};
    for (const l of lines) if (l.pid in have) dec[l.pid] = FieldValue.increment(-l.qty);
    if (Object.keys(dec).length) tx.set(stockRef(), { items: dec }, { merge: true });
    if (c) tx.update(cref, { total: FieldValue.increment(total), visits: FieldValue.increment(1), lastAt: s.at });
    return s;
  });
}

export async function voidSale(id, who, reason) {
  const ref = db().doc('sales/' + safeId(id));
  return db().runTransaction(async (tx) => {
    const [snap, stock] = await Promise.all([tx.get(ref), tx.get(stockRef())]);
    const s = snap.data();
    if (!s) throw new UserError('找不到這張單', 404);
    if (s.void) throw new UserError('這張單已經作廢了');
    if (s.date !== today()) throw new UserError('只能作廢今天的單');
    const v = { at: now(), by: clean(who, 40), reason: clean(reason, 60) };
    tx.update(ref, { void: v });
    // 作廢：庫存加回去、常客的消費扣回來
    const have = stock.data()?.items || {};
    const inc = {};
    for (const l of s.items) if (l.pid in have) inc[l.pid] = FieldValue.increment(l.qty);
    if (Object.keys(inc).length) tx.set(stockRef(), { items: inc }, { merge: true });
    if (s.customer) tx.set(db().doc('customers/' + safeId(s.customer.id)), { total: FieldValue.increment(-s.total), visits: FieldValue.increment(-1) }, { merge: true });
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

// 各付款方式小計
export function summary(sales) {
  const ok = sales.filter((s) => !s.void);
  const by = {};
  for (const s of ok) by[s.method] = (by[s.method] || 0) + s.total;
  return { count: ok.length, total: ok.reduce((a, s) => a + s.total, 0), voided: sales.length - ok.length, by };
}

/* ---------- 錢櫃、日結 ---------- */
export async function getDay(date) {
  const d = (await db().doc('posDays/' + date).get()).data() || {};
  return { open: d.open || null, moves: d.moves || [], close: d.close || null };
}
// 應有現金＝開班零用金＋現金收入＋存入－提出
export function expectedCash(day, sum) {
  const moves = day.moves.reduce((a, m) => a + (m.type === 'in' ? m.amount : -m.amount), 0);
  return (day.open?.cash || 0) + (sum.by['現金'] || 0) + moves;
}
export async function openShift(cash, who) {
  const date = today();
  const ref = db().doc('posDays/' + date);
  await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data() || {};
    if (d.open) throw new UserError('今天已經開班了');
    tx.set(ref, { open: { at: now(), by: clean(who, 40), cash: Math.max(0, money(cash)) } }, { merge: true });
  });
  return getDay(date);
}
export async function cashMove(type, amount, note, who) {
  const a = money(amount);
  if (!(a > 0)) throw new UserError('金額不正確');
  if (!clean(note, 40)) throw new UserError('請寫用途，例如「買塑膠袋」');
  const date = today();
  const m = { id: 'm' + Date.now().toString(36), at: now(), by: clean(who, 40), type: type === 'in' ? 'in' : 'out', amount: a, note: clean(note, 40) };
  await db().doc('posDays/' + date).set({ moves: FieldValue.arrayUnion(m) }, { merge: true });
  return getDay(date);
}
export async function closeShift(counted, note, who) {
  const date = today();
  const [day, sales] = await Promise.all([getDay(date), salesOf(date)]);
  const expected = expectedCash(day, summary(sales));
  const c = money(counted);
  const close = { at: now(), by: clean(who, 40), counted: c, expected, diff: c - expected, note: clean(note, 60) };
  await db().doc('posDays/' + date).set({ close }, { merge: true });
  return { ...day, close };
}
export async function reopenShift() {
  await db().doc('posDays/' + today()).set({ close: null }, { merge: true });
  return getDay(today());
}

/* ---------- 掛單 ---------- */
export async function listHolds() {
  const snap = await db().collection('posHolds').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => a.at.localeCompare(b.at));
}
export async function hold(input, who) {
  const pm = Object.fromEntries((await getProducts()).map((p) => [p.id, p]));
  const items = linesOf(input.items, pm);
  if (!items.length) throw new UserError('還沒有選品項');
  const ref = db().collection('posHolds').doc();
  await ref.set({ id: ref.id, at: now(), by: clean(who, 40), name: clean(input.name, 20), items, discount: money(input.discount), customer: input.customer?.id ? { id: safeId(input.customer.id), name: clean(input.customer.name, 30) } : null });
  return listHolds();
}
export async function dropHold(id) {
  await db().doc('posHolds/' + safeId(id)).delete();
  return listHolds();
}

/* ---------- 庫存 ---------- */
export async function getStock() {
  const d = (await stockRef().get()).data() || {};
  return { items: d.items || {}, low: d.low || {} };
}
// type：in 進貨（加）、adjust 盤點（改成這個數）、track 開始／停止管這個品項的庫存；low：低於多少提醒
export async function stockChange(input, who) {
  const p = (await getProducts()).find((x) => x.id === input.pid);
  if (!p) throw new UserError('找不到這個品項');
  const type = ['in', 'adjust', 'track', 'untrack', 'low'].includes(input.type) ? input.type : 'in';
  const q = roundQty(Number(input.qty));
  await db().runTransaction(async (tx) => {
    const cur = (await tx.get(stockRef())).data() || {};
    const have = cur.items?.[p.id];
    if (type === 'untrack') { tx.set(stockRef(), { items: { [p.id]: FieldValue.delete() }, low: { [p.id]: FieldValue.delete() } }, { merge: true }); return; }
    if (type === 'low') { tx.set(stockRef(), { low: { [p.id]: q > 0 ? q : FieldValue.delete() } }, { merge: true }); return; }
    if (!(q >= 0) || (type === 'in' && !(q > 0))) throw new UserError('數量不正確');
    const after = type === 'in' ? roundQty((have || 0) + q) : q;
    tx.set(stockRef(), { items: { [p.id]: after } }, { merge: true });
    const ref = db().collection('stockMoves').doc();
    tx.set(ref, { id: ref.id, at: now(), by: clean(who, 40), pid: p.id, name: p.name, unit: p.unit, delta: type === 'in' ? q : roundQty(q - (have || 0)), type: type === 'track' ? 'adjust' : type, note: clean(input.note, 40), after });
  });
  return getStock();
}
export async function stockMoves(limit = 50) {
  const snap = await db().collection('stockMoves').orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data());
}

/* ---------- 常客／會員 ---------- */
export async function listCustomers() {
  const snap = await db().collection('customers').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
}
export async function saveCustomer(input) {
  const name = clean(input.name, 30);
  if (!name) throw new UserError('請填名字');
  const phone = clean(input.phone, 20).replace(/[^\d+#-]/g, '');
  const discount = input.discount === '' || input.discount == null ? null : Math.round(Number(input.discount));
  if (discount != null && !(discount >= 50 && discount <= 100)) throw new UserError('折扣請填 50～100，例如 95 是 95 折');
  const all = await listCustomers();
  if (phone && all.some((c) => c.phone === phone && c.id !== input.id)) throw new UserError('這支電話已經有人用了');
  const ref = input.id ? db().doc('customers/' + safeId(input.id)) : db().collection('customers').doc();
  const old = all.find((c) => c.id === ref.id);
  await ref.set({ id: ref.id, name, phone, note: clean(input.note, 60), discount: discount === 100 ? null : discount, total: old?.total || 0, visits: old?.visits || 0, lastAt: old?.lastAt || null, at: old?.at || now() });
  return listCustomers();
}
export async function deleteCustomer(id) {
  await db().doc('customers/' + safeId(id)).delete();
  return listCustomers();
}
