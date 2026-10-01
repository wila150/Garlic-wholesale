// 報表：每日毛利、出貨重量、自訂成本項目、應收帳齡
//   settings/costTypes  { items: [{ id, name, period: 'daily' | 'monthly' }] }
//   costs/{YYYY-MM}     { daily: { 日期: { 項目: 金額 } }, monthly: { 項目: 金額 } }
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';
import { addDays, thisMonth } from './dates.js';
import * as shop from './shop.js';

const db = () => getFirestore();
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const rid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const daysOf = (month) => {
  const n = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
};
// 換算成公斤；不是重量的單位（包、箱…）不算
const KG = { 斤: 0.6, 台斤: 0.6, 兩: 0.0375, 公斤: 1, kg: 1, 公克: 0.001 };

export async function getCostTypes() {
  return (await db().doc('settings/costTypes').get()).data()?.items ?? [];
}

export async function saveCostTypes(input) {
  if (!Array.isArray(input)) throw new UserError('成本項目格式錯誤');
  const names = new Set();
  const list = input.map((c) => {
    const name = clean(c.name, 20);
    if (!name) throw new UserError('有成本項目沒有填名稱');
    if (names.has(name)) throw new UserError(`成本項目「${name}」重複了`);
    names.add(name);
    return { id: clean(c.id, 30) || rid(), name, period: c.period === 'monthly' ? 'monthly' : 'daily' };
  });
  await db().doc('settings/costTypes').set({ items: list });
  return list;
}

export async function saveCosts(month, input) {
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Math.round(Number(v));
    if (!(n >= 0)) throw new UserError('有成本金額不正確');
    return n;
  };
  const daily = {};
  for (const [date, row] of Object.entries(input.daily || {})) {
    if (!date.startsWith(month)) continue;
    for (const [k, v] of Object.entries(row || {})) { const n = num(v); if (n != null) (daily[date] ??= {})[k] = n; }
  }
  const monthly = {};
  for (const [k, v] of Object.entries(input.monthly || {})) { const n = num(v); if (n != null) monthly[k] = n; }
  await db().doc('costs/' + month).set({ daily, monthly });
}

export async function monthReport(month) {
  const days = daysOf(month);
  const [ordersSnap, pricesSnap, costDoc, costTypes, products] = await Promise.all([
    db().collection('orders').where('month', '==', month).get(),
    db().collection('dayPrices').where('date', '>=', days[0]).where('date', '<=', days.at(-1)).get(),
    db().doc('costs/' + month).get(),
    getCostTypes(),
    shop.getProducts(),
  ]);
  const dayCosts = Object.fromEntries(pricesSnap.docs.map((d) => [d.id, d.data().costs || {}]));
  const fallbackCost = Object.fromEntries(products.map((p) => [p.id, p.cost ?? null]));
  const costs = costDoc.data() || { daily: {}, monthly: {} };
  const monthlyTotal = costTypes.filter((t) => t.period === 'monthly').reduce((a, t) => a + (costs.monthly?.[t.id] || 0), 0);

  const rows = Object.fromEntries(days.map((d) => [d, { date: d, revenue: 0, purchase: 0, missingCost: 0, kg: 0, stores: 0 }]));
  for (const doc of ordersSnap.docs) {
    const o = doc.data();
    if (!o.items.length || !rows[o.date]) continue;
    const r = rows[o.date];
    r.stores++;
    r.revenue += shop.amountOf(o);
    for (const it of o.items) {
      const q = shop.billQty(it);
      const c = dayCosts[o.date]?.[it.pid] ?? fallbackCost[it.pid];
      if (c == null) r.missingCost += q * it.price; else r.purchase += q * c;
      if (KG[it.unit]) r.kg += q * KG[it.unit];
    }
  }
  const out = days.map((d) => {
    const r = rows[d];
    const other = costTypes.filter((t) => t.period === 'daily').reduce((a, t) => a + (costs.daily?.[d]?.[t.id] || 0), 0) + monthlyTotal / days.length;
    const gross = r.revenue - r.purchase;
    return { ...r, purchase: Math.round(r.purchase), kg: Math.round(r.kg * 10) / 10, other: Math.round(other), gross: Math.round(gross), net: Math.round(gross - other), missingCost: Math.round(r.missingCost) };
  });
  return { month, days: out, costTypes, costs };
}

// 應收帳齡：最近 12 個月沒勾「已收款」的金額
export async function receivables() {
  const months = [];
  for (let m = thisMonth(), i = 0; i < 12; i++, m = addDays(m + '-01', -1).slice(0, 7)) months.push(m);
  const [stores, ...docs] = await Promise.all([shop.getStores(), ...months.flatMap((m) => [shop.monthAmounts(m), shop.getPaid(m)])]);
  const list = stores.map((s) => ({ storeId: s.id, name: s.name, hasLine: !!s.members?.length, months: [], total: 0 }));
  months.forEach((m, i) => {
    const amounts = docs[i * 2], paid = docs[i * 2 + 1];
    for (const s of list) {
      if (paid[s.storeId]) continue;
      const amt = amounts.filter((r) => r.storeId === s.storeId).reduce((a, r) => a + r.amount, 0);
      if (amt) { s.months.push({ month: m, amount: amt, age: i }); s.total += amt; }
    }
  });
  return list.filter((s) => s.total).sort((a, b) => b.total - a.total);
}
