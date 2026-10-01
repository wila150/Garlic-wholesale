// 資料都放在 Firestore：
//   settings/products   { items: 品項清單 }
//   settings/units      { items: 單位清單 }
//   stores/{id}         店家（含路線站號、綁定的 LINE 帳號 members）
//   members/{userId}    { storeId }：LINE 帳號屬於哪家店
//   pending/{userId}    申請開通的人
//   orders/{日期}_{店}   訂單（每家店每個配送日一張）
//   dayPrices/{日期}     { prices: { pid: 單價 } }：老闆確認過的當天單價
//   monthly/{YYYY-MM}   { amounts: { "日期|店": 金額 } }：對帳用的每日金額，一次讀完一整個月
//   paid/{YYYY-MM}      { stores: { 店: { at } } }：收款紀錄
//   users/{uid}         後台帳號的角色（見 lib/auth.js）
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { DEFAULT_PRODUCTS, CATEGORIES, DEFAULT_UNITS } from './config.js';
import { qtyText, roundQty } from './qty.js';
import { UserError } from './http.js';
import { openDate, isDate } from './dates.js';

const db = () => getFirestore();
const doc = (path) => db().doc(path);
const data = async (path) => (await doc(path).get()).data() ?? null;

const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

/* ---------- 品項 ---------- */
export async function getProducts() {
  return (await data('settings/products'))?.items ?? DEFAULT_PRODUCTS;
}

/* ---------- 單位 ---------- */
export async function getUnits() {
  return (await data('settings/units'))?.items ?? DEFAULT_UNITS;
}

export async function saveUnits(input) {
  if (!Array.isArray(input)) throw new UserError('單位格式錯誤');
  const list = [...new Set(input.map((u) => clean(u, 6)).filter(Boolean))];
  if (!list.length) throw new UserError('至少要有一個單位');
  const used = (await getProducts()).filter((p) => !list.includes(p.unit));
  if (used.length) throw new UserError(`「${used[0].unit}」還有品項在用（${used[0].name}），先把品項改成別的單位`);
  await doc('settings/units').set({ items: list });
  return list;
}

// 品項只管名稱、分類、單位、上下架；單價每天在「單價」頁輸入
export async function saveProducts(input) {
  if (!Array.isArray(input)) throw new UserError('品項格式錯誤');
  const old = new Map((await getProducts()).map((p) => [p.id, p]));
  const units = await getUnits();
  const names = new Set();
  const list = input.map((p) => {
    const name = clean(p.name, 40);
    if (!name) throw new UserError('有品項沒有填品名');
    if (names.has(name)) throw new UserError(`「${name}」重複了`);
    names.add(name);
    const id = clean(p.id, 30) || rid('p');
    return {
      id,
      cat: CATEGORIES.includes(p.cat) ? p.cat : CATEGORIES[0],
      name,
      unit: units.includes(p.unit) ? p.unit : units[0],
      price: old.get(id)?.price ?? 0, // 最近一次輸入的單價，新訂單先用這個
      on: !!p.on,
    };
  });
  await doc('settings/products').set({ items: list });
  return list;
}

/* ---------- 每日單價 ---------- */
export async function getDayPrices(date) {
  return (await data('dayPrices/' + date))?.prices || {};
}

export async function setDayPrices(date, input) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  const prices = {};
  for (const [pid, v] of Object.entries(input || {})) {
    const n = Math.round(Number(v));
    if (v === '' || v == null || !(n >= 0)) throw new UserError('有單價沒填或不正確');
    prices[pid] = n;
  }
  const day = { ...(await getDayPrices(date)), ...prices };
  const batch = db().batch();
  batch.set(doc('dayPrices/' + date), { date, prices: day });

  // 套用到這天所有訂單
  for (const o of await ordersOfDate(date)) {
    let changed = false;
    for (const it of o.items) if (it.pid in prices && it.price !== prices[it.pid]) { it.price = prices[it.pid]; changed = true; }
    if (changed) {
      batch.set(orderDoc(date, o.storeId), o);
      batch.set(doc('monthly/' + date.slice(0, 7)), { amounts: { [`${date}|${o.storeId}`]: amountOf(o) } }, { merge: true });
    }
  }
  // 記成最近的單價，之後的新訂單先帶這個
  const products = await getProducts();
  let changed = false;
  for (const p of products) if (p.id in prices && p.price !== prices[p.id]) { p.price = prices[p.id]; changed = true; }
  if (changed) batch.set(doc('settings/products'), { items: products });
  await batch.commit();
  return day;
}

/* ---------- 店家 ---------- */
export async function getStores() {
  const snap = await db().collection('stores').get();
  return snap.docs.map((d) => d.data()).sort((a, b) => a.route - b.route);
}

export async function saveStores(input) {
  if (!Array.isArray(input)) throw new UserError('店家格式錯誤');
  const old = new Map((await getStores()).map((s) => [s.id, s]));
  const list = input.map((s) => {
    const name = clean(s.name, 30);
    if (!name) throw new UserError('有店家沒有填店名');
    const route = Math.floor(Number(s.route));
    return {
      id: clean(s.id, 30) || rid('s'),
      name,
      route: route > 0 ? route : 99,
      phone: clean(s.phone, 20),
      address: clean(s.address, 80),
      on: s.on !== false,
      members: old.get(s.id)?.members || [], // 綁定的 LINE 帳號只能用開通／解除改
    };
  });
  const batch = db().batch();
  for (const s of list) batch.set(doc('stores/' + s.id), s);
  // 被刪掉的店家，連同它的 LINE 綁定一起刪
  const kept = new Set(list.map((s) => s.id));
  for (const s of old.values()) {
    if (kept.has(s.id)) continue;
    batch.delete(doc('stores/' + s.id));
    for (const m of s.members) batch.delete(doc('members/' + m.userId));
  }
  await batch.commit();
  return getStores();
}

export async function storeOfUser(userId) {
  const sid = (await data('members/' + userId))?.storeId;
  if (!sid) return null;
  const s = await data('stores/' + sid);
  return s && s.on ? s : null;
}

export const listPending = async () => (await db().collection('pending').get()).docs.map((d) => d.data()).sort((a, b) => a.at.localeCompare(b.at));

export async function addPending(userId, name, text) {
  const old = await data('pending/' + userId);
  await doc('pending/' + userId).set({
    userId,
    name: name || old?.name || '',
    text: clean(text, 60) || old?.text || '',
    at: old?.at || new Date().toISOString(),
  });
  return !old;
}

export async function approve(userId, { storeId, newStore }) {
  const p = await data('pending/' + userId);
  if (!p) throw new UserError('找不到這個申請，可能已經處理過了');
  const stores = await getStores();
  let s = stores.find((x) => x.id === storeId);
  if (!s) {
    const name = clean(newStore?.name, 30);
    if (!name) throw new UserError('請選店家，或填新店家的店名');
    s = { id: rid('s'), name, route: Math.max(0, ...stores.map((x) => x.route)) + 1, phone: '', address: '', on: true, members: [] };
  }
  const batch = db().batch();
  // 從舊店家移除（如果有）
  const prev = (await data('members/' + userId))?.storeId;
  const old = stores.find((x) => x.id === prev && x.id !== s.id);
  if (old) batch.update(doc('stores/' + old.id), { members: old.members.filter((m) => m.userId !== userId) });
  s.members = [...s.members.filter((m) => m.userId !== userId), { userId, name: p.name }];
  batch.set(doc('stores/' + s.id), s);
  batch.set(doc('members/' + userId), { storeId: s.id });
  batch.delete(doc('pending/' + userId));
  await batch.commit();
  return s;
}

export const reject = (userId) => doc('pending/' + userId).delete();

export async function unbind(userId) {
  const sid = (await data('members/' + userId))?.storeId;
  const s = sid && (await data('stores/' + sid));
  const batch = db().batch();
  if (s) batch.update(doc('stores/' + sid), { members: s.members.filter((m) => m.userId !== userId) });
  batch.delete(doc('members/' + userId));
  await batch.commit();
}

/* ---------- 訂單 ---------- */
const orderDoc = (date, sid) => doc(`orders/${date}_${sid}`);
export const getOrder = async (date, sid) => (await orderDoc(date, sid).get()).data() ?? null;

export async function ordersOfDate(date) {
  const snap = await db().collection('orders').where('date', '==', date).get();
  return snap.docs.map((d) => d.data()).filter((o) => o.items.length);
}

// 這家店最近一張（配送日早於 date 的）訂單，用來「照上次叫」
export async function lastOrder(sid, date) {
  const snap = await db().collection('orders').where('storeId', '==', sid).where('date', '<', date).orderBy('date', 'desc').limit(5).get();
  return snap.docs.map((d) => d.data()).find((o) => o.items.length) ?? null;
}

// 一整個月每家店每天的金額（讀一份文件）
export async function monthAmounts(month) {
  const amounts = (await data('monthly/' + month))?.amounts || {};
  return Object.entries(amounts).map(([k, amount]) => {
    const [date, storeId] = k.split('|');
    return { date, storeId, amount };
  });
}

// 整張訂單覆蓋。by：'店家' 或 '後台'；who：後台是誰改的
export async function saveOrder(sid, date, items, by, who = '') {
  if (!isDate(date)) throw new UserError('配送日不正確');
  if (by === '店家' && date !== openDate()) throw new UserError('這一天已經截單了，請重新整理後再叫貨', 409);
  const products = await getProducts();
  const pm = new Map(products.map((p) => [p.id, p]));
  const old = await getOrder(date, sid);
  const dayPrices = await getDayPrices(date);
  const oldMap = new Map((old?.items || []).map((i) => [i.pid, i]));

  const next = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const qty = roundQty(it?.qty);
    if (!(qty > 0) || seen.has(it.pid)) continue;
    if (qty > 999) throw new UserError('數量太大了');
    const p = pm.get(it.pid);
    const was = oldMap.get(it.pid);
    if (!p && !was) continue;
    if (p && !p.on && !was && by === '店家') throw new UserError(`「${p.name}」暫時沒有供貨`);
    seen.add(it.pid);
    const src = p || was;
    next.push({ pid: it.pid, name: src.name, unit: src.unit, price: dayPrices[it.pid] ?? src.price, qty });
  }
  if (!next.length && !old?.items.length) throw new UserError('還沒選任何品項');
  const idx = (pid) => { const i = products.findIndex((p) => p.id === pid); return i < 0 ? 1e9 : i; };
  next.sort((a, b) => idx(a.pid) - idx(b.pid));

  const changes = [];
  if (old?.items.length) {
    for (const pid of new Set([...oldMap.keys(), ...next.map((i) => i.pid)])) {
      const a = oldMap.get(pid)?.qty || 0;
      const n = next.find((i) => i.pid === pid);
      const b = n?.qty || 0;
      const { name, unit } = n || oldMap.get(pid);
      if (a !== b) changes.push(`${name} ${qtyText(a, unit)} → ${qtyText(b, unit)}`);
    }
  }
  const at = new Date().toISOString();
  const order = {
    date,
    month: date.slice(0, 7),
    storeId: sid,
    items: next,
    createdAt: old?.items.length ? old.createdAt : at,
    updatedAt: at,
    log: [
      ...(old?.log || []),
      ...(changes.length ? [{ at, by, who, text: changes.join('、') }] : []),
      // 新訂單只在有特別來源（例如 AI 叫貨）時記一筆
      ...(!old?.items.length && who ? [{ at, by, who, text: '新叫貨：' + next.map((i) => `${i.name} ${qtyText(i.qty, i.unit)}`).join('、') }] : []),
    ],
  };
  const batch = db().batch();
  batch.set(orderDoc(date, sid), order);
  batch.set(doc('monthly/' + order.month), { amounts: { [`${date}|${sid}`]: next.length ? amountOf(order) : FieldValue.delete() } }, { merge: true });
  await batch.commit();
  return { order, had: !!old?.items.length, changes };
}

export async function setQty(sid, date, pid, qty, who) {
  const old = await getOrder(date, sid);
  const items = (old?.items || []).filter((i) => i.pid !== pid);
  const at = (old?.items || []).findIndex((i) => i.pid === pid);
  const it = { pid, qty: Math.max(0, roundQty(qty) || 0) };
  if (at >= 0) items.splice(at, 0, it); else items.push(it);
  return saveOrder(sid, date, items, '後台', who);
}

export const amountOf = (o) => Math.round(o.items.reduce((a, i) => a + i.qty * i.price, 0));

/* ---------- 收款 ---------- */
export const getPaid = async (month) => (await data('paid/' + month))?.stores || {};
export async function setPaid(month, sid, paid) {
  await doc('paid/' + month).set({ stores: { [sid]: paid ? { at: new Date().toISOString() } : FieldValue.delete() } }, { merge: true });
}
