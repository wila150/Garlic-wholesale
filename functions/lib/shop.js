// 資料都放在 Firestore：
//   settings/products   { items: 品項清單 }
//   settings/units      { items: 單位清單 }
//   stores/{id}         店家（含路線站號、綁定的 LINE 帳號 members）
//   members/{userId}    { storeId }：LINE 帳號屬於哪家店
//   pending/{userId}    申請開通的人
//   orders/{日期}_{店}   訂單（每家店每個配送日一張；簽收後追加的「補單」是 {日期}_{店}-2、-3…，seq 欄位記第幾張）
//   dayPrices/{日期}     { prices: { pid: 單價 } }：老闆確認過的當天單價
//   monthly/{YYYY-MM}   { amounts: { "日期|店[-補單號]": 金額 } }：對帳用的每日金額，一次讀完一整個月
//   paid/{YYYY-MM}      { stores: { 店: { at } } }：收款紀錄
//   settings/priceGroups { items: 報價組 }：店家 groupId 對到這裡，決定拿基本價的幾折或固定價
//   users/{uid}         後台帳號的角色（見 lib/auth.js）
//   storeAliases/{店}    { items: [{ text, pid }] }：只有這家店用的叫法（例如這家說「大的」是指某個品項）
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { DEFAULT_PRODUCTS, CATEGORIES, DEFAULT_UNITS, UNITS_VERSION, UNITS_ADDED } from './config.js';
import { qtyText, roundQty } from './qty.js';
import { UserError } from './http.js';
import { openDate, isDate, today, addonDate, getRulesNow, cutoffLabel, addonUntilLabel } from './dates.js';

const db = () => getFirestore();
const doc = (path) => db().doc(path);
const data = async (path) => (await doc(path).get()).data() ?? null;

const rid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (s, max) => String(s ?? '').trim().slice(0, max);

/* ---------- 品項 ---------- */
export async function getProducts() {
  return (await data('settings/products'))?.items ?? DEFAULT_PRODUCTS;
}

/* ---------- 別名（客人常打的寫法，給 AI 對照） ---------- */
// 舊資料是一串字（用、或逗號隔開），新的存成陣列；兩種都讀得懂
export const ALIAS_MAX = 50; // 每個品項最多幾個叫法
export function aliasList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(/[、,，;；\n]/);
  return [...new Set(arr.map((s) => clean(s, 20)).filter(Boolean))].slice(0, ALIAS_MAX);
}

// 從 AI 紀錄「看不懂」加叫法。storeId 有填＝只有這家店用；沒填＝全部店家通用
export async function addAlias({ text, pid, storeId }) {
  text = clean(text, 20);
  if (!text) throw new UserError('請填客人寫的叫法');
  const products = await getProducts();
  const p = products.find((x) => x.id === pid);
  if (!p) throw new UserError('請選對應的品項');
  if (storeId) {
    const ref = doc('storeAliases/' + storeId);
    await db().runTransaction(async (tx) => {
      const items = ((await tx.get(ref)).data()?.items || []).filter((a) => a.text !== text);
      if (items.length >= 200) throw new UserError('這家店的專屬叫法太多了，請先刪掉一些');
      tx.set(ref, { items: [...items, { text, pid }] });
    });
    return { products, storeAliases: await getStoreAliases(storeId) };
  }
  const ref = doc('settings/products');
  const list = await db().runTransaction(async (tx) => {
    const items = (await tx.get(ref)).data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    const other = items.find((x) => x.id !== pid && aliasList(x.alias).includes(text));
    if (other) throw new UserError(`「${text}」已經是「${other.name}」的叫法了，同一個叫法不能對到兩個品項（不同店意思不同的話，請選「只有這家店」）`);
    const it = items.find((x) => x.id === pid);
    if (!it) throw new UserError('找不到這個品項，請重新整理');
    const cur = aliasList(it.alias);
    if (!cur.includes(text)) {
      if (cur.length >= ALIAS_MAX) throw new UserError(`「${it.name}」的叫法已經有 ${ALIAS_MAX} 個了`);
      it.alias = [...cur, text];
    }
    tx.set(ref, { items });
    return items;
  });
  return { products: list };
}

export const getStoreAliases = async (storeId) => (await data('storeAliases/' + storeId))?.items || [];
export async function allStoreAliases() {
  const snap = await db().collection('storeAliases').get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().items || []]));
}
export async function removeStoreAlias(storeId, text) {
  const ref = doc('storeAliases/' + storeId);
  await db().runTransaction(async (tx) => {
    const items = ((await tx.get(ref)).data()?.items || []).filter((a) => a.text !== text);
    tx.set(ref, { items });
  });
  return getStoreAliases(storeId);
}

/* ---------- 單位 ---------- */
export async function getUnits() {
  const saved = await data('settings/units');
  if (!saved?.items) return DEFAULT_UNITS;
  if ((saved.v || 1) >= UNITS_VERSION) return saved.items;
  const add = Object.entries(UNITS_ADDED).filter(([v]) => +v > (saved.v || 1)).flatMap(([, u]) => u);
  const items = [...new Set([...saved.items, ...add])];
  await doc('settings/units').set({ items, v: UNITS_VERSION });
  return items;
}

export async function saveUnits(input) {
  if (!Array.isArray(input)) throw new UserError('單位格式錯誤');
  const list = [...new Set(input.map((u) => clean(u, 6)).filter(Boolean))];
  if (!list.length) throw new UserError('至少要有一個單位');
  const used = (await getProducts()).filter((p) => !list.includes(p.unit));
  if (used.length) throw new UserError(`「${used[0].unit}」還有品項在用（${used[0].name}），先把品項改成別的單位`);
  await doc('settings/units').set({ items: list, v: UNITS_VERSION });
  return list;
}

/* ---------- 分類（後台品項頁「分類管理」可以自己加刪）---------- */
//   settings/categories { items: 分類清單 }
export async function getCategories() {
  const list = (await data('settings/categories'))?.items ?? CATEGORIES;
  // 品項用到、但清單裡沒有的分類也列出來，免得品項看不到
  const extra = [...new Set((await getProducts()).map((p) => p.cat).filter((c) => c && !list.includes(c)))];
  return [...list, ...extra];
}
export async function saveCategories(input) {
  if (!Array.isArray(input)) throw new UserError('分類格式錯誤');
  const list = [...new Set(input.map((c) => clean(c, 12)).filter(Boolean))];
  if (!list.length) throw new UserError('至少要有一個分類');
  const used = (await getProducts()).filter((p) => !list.includes(p.cat));
  if (used.length) throw new UserError(`「${used[0].cat}」還有品項在用（${used[0].name}），先把品項改到別的分類`);
  await doc('settings/categories').set({ items: list });
  return list;
}

// 分類改名：連同這個分類底下的品項一起改
export async function renameCategory(from, to) {
  to = clean(to, 12);
  if (!to) throw new UserError('請填新的分類名稱');
  const cats = await getCategories();
  if (!cats.includes(from)) throw new UserError('找不到這個分類，請重新整理');
  if (from === to) return { categories: cats, products: await getProducts() };
  if (cats.includes(to)) throw new UserError(`「${to}」已經有了`);
  const pref = doc('settings/products');
  const products = await db().runTransaction(async (tx) => {
    const items = (await tx.get(pref)).data()?.items ?? structuredClone(DEFAULT_PRODUCTS);
    items.forEach((p) => { if (p.cat === from) p.cat = to; });
    tx.set(pref, { items });
    tx.set(doc('settings/categories'), { items: cats.map((c) => (c === from ? to : c)) });
    return items;
  });
  return { categories: cats.map((c) => (c === from ? to : c)), products };
}

// 品項只管名稱、分類、單位、上下架；單價每天在「單價」頁輸入
export async function saveProducts(input) {
  if (!Array.isArray(input)) throw new UserError('品項格式錯誤');
  const cats = (await data('settings/categories'))?.items ?? CATEGORIES;
  const old = new Map((await getProducts()).map((p) => [p.id, p]));
  const units = await getUnits();
  const names = new Set();
  const aliasOwner = new Map(); // 叫法 → 品名：同一個叫法不能對到兩個品項
  const list = input.map((p) => {
    const name = clean(p.name, 40);
    if (!name) throw new UserError('有品項沒有填品名');
    if (names.has(name)) throw new UserError(`「${name}」重複了`);
    names.add(name);
    const id = clean(p.id, 30) || rid('p');
    return {
      id,
      cat: cats.includes(p.cat) ? p.cat : cats[0],
      name,
      unit: units.includes(p.unit) ? p.unit : units[0],
      price: old.get(id)?.price ?? 0, // 最近一次輸入的單價，新訂單先用這個
      cost: old.get(id)?.cost ?? null, // 最近一次輸入的進價
      on: !!p.on,
      // 別名（客人常打的寫法，給 AI 對照用）。畫面沒送 alias 時保留原本的，免得存品項時被清空
      alias: p.alias === undefined ? aliasList(old.get(id)?.alias) : aliasList(p.alias),
    };
  });
  for (const p of list) {
    for (const a of p.alias) {
      if (aliasOwner.has(a) && aliasOwner.get(a) !== p.name) throw new UserError(`「${a}」同時是「${aliasOwner.get(a)}」和「${p.name}」的叫法，請只留一個`);
      aliasOwner.set(a, p.name);
    }
  }
  await doc('settings/products').set({ items: list });
  return list;
}

/* ---------- 報價組 ---------- */
// type：none 照基本價、percent 打折（value＝90 是 9 折）、minus 每單位減 value 元；fixed 是個別品項的固定價
export async function getPriceGroups() {
  return (await data('settings/priceGroups'))?.items ?? [];
}

export function priceFor(base, pid, group) {
  if (!group) return base;
  if (group.fixed?.[pid] != null) return group.fixed[pid];
  if (group.type === 'percent') return Math.round((base * group.value) / 100);
  if (group.type === 'minus') return Math.max(0, base - group.value);
  return base;
}

export async function savePriceGroups(input) {
  if (!Array.isArray(input)) throw new UserError('報價組格式錯誤');
  const names = new Set();
  const list = input.map((g) => {
    const name = clean(g.name, 20);
    if (!name) throw new UserError('有報價組沒有填名稱');
    if (names.has(name)) throw new UserError(`報價組「${name}」重複了`);
    names.add(name);
    const type = ['none', 'percent', 'minus'].includes(g.type) ? g.type : 'none';
    const value = Number(g.value) || 0;
    if (type === 'percent' && !(value > 0 && value <= 200)) throw new UserError(`「${name}」的折數不正確（例如 9 折填 90）`);
    if (type === 'minus' && !(value >= 0)) throw new UserError(`「${name}」每單位減的金額不正確`);
    const fixed = {};
    for (const [pid, v] of Object.entries(g.fixed || {})) {
      if (v === '' || v == null) continue;
      const n = Math.round(Number(v));
      if (!(n >= 0)) throw new UserError(`「${name}」有固定價不正確`);
      fixed[pid] = n;
    }
    return { id: clean(g.id, 30) || rid('g'), name, type, value, fixed };
  });
  await doc('settings/priceGroups').set({ items: list });
  await repriceOpen();
  return list;
}

// 店家換組、報價組改規則後，今天（含）以後還沒送的訂單重算
async function repriceOpen() {
  const [stores, groups] = await Promise.all([getStores(), getPriceGroups()]);
  const gOf = (sid) => groups.find((g) => g.id === stores.find((s) => s.id === sid)?.groupId);
  const snap = await db().collection('orders').where('date', '>=', today()).get();
  const batch = db().batch();
  let n = 0;
  for (const d of snap.docs) {
    const o = d.data();
    let changed = false;
    for (const it of o.items) {
      const base = it.base ?? it.price;
      const p = priceFor(base, it.pid, gOf(o.storeId));
      if (p !== it.price || it.base !== base) { it.price = p; it.base = base; changed = true; }
    }
    if (changed) {
      batch.set(d.ref, o);
      batch.set(doc('monthly/' + o.month), { amounts: { [monthKey(o.date, o.storeId, o.seq)]: amountOf(o) } }, { merge: true });
      n++;
    }
  }
  if (n) await batch.commit();
}

/* ---------- 每日單價 ---------- */
export async function getDayPrices(date) {
  return (await data('dayPrices/' + date))?.prices || {};
}
export async function getDayCosts(date) {
  return (await data('dayPrices/' + date))?.costs || {};
}

// input：{ pid: 基本價 }；costInput：{ pid: 進價 }（選填，算毛利用）
export async function setDayPrices(date, input, costInput = {}) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  const prices = {};
  for (const [pid, v] of Object.entries(input || {})) {
    const n = Math.round(Number(v));
    if (v === '' || v == null || !(n >= 0)) throw new UserError('有單價沒填或不正確');
    prices[pid] = n;
  }
  const costs = {};
  for (const [pid, v] of Object.entries(costInput || {})) {
    if (v === '' || v == null) continue;
    const n = Math.round(Number(v) * 100) / 100;
    if (!(n >= 0)) throw new UserError('有進價不正確');
    costs[pid] = n;
  }
  const cur = (await data('dayPrices/' + date)) || {};
  const day = { ...(cur.prices || {}), ...prices };
  const dayCosts = { ...(cur.costs || {}), ...costs };
  const batch = db().batch();
  batch.set(doc('dayPrices/' + date), { date, prices: day, costs: dayCosts });

  // 套用到這天所有訂單（各店照報價組換算）
  const [stores, groups] = await Promise.all([getStores(), getPriceGroups()]);
  for (const o of await ordersOfDate(date)) {
    const g = groups.find((x) => x.id === stores.find((s) => s.id === o.storeId)?.groupId);
    let changed = false;
    for (const it of o.items) {
      if (!(it.pid in prices)) continue;
      const p = priceFor(prices[it.pid], it.pid, g);
      if (it.price !== p || it.base !== prices[it.pid]) { it.price = p; it.base = prices[it.pid]; changed = true; }
    }
    if (changed) {
      batch.set(orderDoc(date, o.storeId, o.seq), o);
      batch.set(doc('monthly/' + date.slice(0, 7)), { amounts: { [monthKey(date, o.storeId, o.seq)]: amountOf(o) } }, { merge: true });
    }
  }
  // 記成最近的單價，之後的新訂單先帶這個
  const products = await getProducts();
  let changed = false;
  for (const p of products) {
    if (p.id in prices && p.price !== prices[p.id]) { p.price = prices[p.id]; changed = true; }
    if (p.id in costs && p.cost !== costs[p.id]) { p.cost = costs[p.id]; changed = true; }
  }
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
      groupId: clean(s.groupId, 30),
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
  if (list.some((s) => (old.get(s.id)?.groupId || '') !== s.groupId)) await repriceOpen();
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
// seq：第幾張單（1 是原本的叫貨單，2 以後是簽收後開的補單）
export const slipKey = (sid, seq = 1) => (seq > 1 ? `${sid}-${seq}` : sid);
const orderDoc = (date, sid, seq = 1) => doc(`orders/${date}_${slipKey(sid, seq)}`);
const monthKey = (date, sid, seq = 1) => `${date}|${slipKey(sid, seq)}`;
// 簽收後出貨單就鎖住，數量和品項都不能再改（單價還是可以補）；要追加就開補單（檢查在 saveOrder／setShip 的 transaction 裡）
export const getOrder = async (date, sid, seq = 1) => (await orderDoc(date, sid, seq).get()).data() ?? null;

export async function ordersOfDate(date, { withEmpty = false } = {}) {
  const snap = await db().collection('orders').where('date', '==', date).get();
  return snap.docs.map((d) => d.data()).filter((o) => withEmpty || o.items.length);
}

// 這家店最近一張（配送日早於 date 的）訂單，用來「照上次叫」
export async function lastOrder(sid, date) {
  const snap = await db().collection('orders').where('storeId', '==', sid).where('date', '<', date).orderBy('date', 'desc').limit(5).get();
  return snap.docs.map((d) => d.data()).find((o) => o.items.length) ?? null;
}

// 一整個月每家店每天的金額（讀一份文件）
export async function monthAmounts(month) {
  const amounts = (await data('monthly/' + month))?.amounts || {};
  // 同一天的補單併成一筆
  const m = new Map();
  for (const [k, amount] of Object.entries(amounts)) {
    const [date, key] = k.split('|');
    const storeId = key.replace(/-\d+$/, '');
    const r = m.get(date + '|' + storeId) || { date, storeId, amount: 0 };
    r.amount += amount;
    m.set(date + '|' + storeId, r);
  }
  return [...m.values()];
}

// 整張訂單覆蓋。by：'店家' 或 '後台'；who：後台是誰改的
// items 可以是陣列，或 (舊訂單) => 陣列：要「在舊的單上加減」時用函式，才不會跟同時間的修改互相蓋掉
// 用 transaction：同一張單同時有人改（店家改單、理貨填實出量、AI 確認），Firestore 會自動重跑，不會遺失修改
export async function saveOrder(sid, date, items, by, who = '', seq = 1) {
  if (!isDate(date)) throw new UserError('配送日不正確');
  if (by === '店家' && date !== openDate()) throw new UserError('這一天已經截單了，請重新整理後再叫貨', 409);
  seq = Math.max(1, Math.floor(Number(seq)) || 1);
  const [products, dayPrices, storeDoc, groups] = await Promise.all([getProducts(), getDayPrices(date), data('stores/' + sid), getPriceGroups()]);
  const pm = new Map(products.map((p) => [p.id, p]));
  const group = groups.find((g) => g.id === storeDoc?.groupId);
  const ref = orderDoc(date, sid, seq);
  const sigRef = doc(`signatures/${date}_${slipKey(sid, seq)}`);

  return db().runTransaction(async (tx) => {
  // 這裡面可能被重跑好幾次，不要有寄訊息之類的副作用
  const [sigSnap, oldSnap] = await Promise.all([tx.get(sigRef), tx.get(ref)]);
  if (sigSnap.exists) throw new UserError('這張配送單已經確認，不能再修改；要追加請開補單', 409);
  const old = oldSnap.data() ?? null;
  // 交易撞到別人同時改單會重跑：每次都要用這次讀到的最新的單重算，不能改掉外面的 items
  const list = typeof items === 'function' ? items(old) : items;
  const oldMap = new Map((old?.items || []).map((i) => [i.pid, i]));

  const next = [];
  const seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    const qty = roundQty(it?.qty);
    if (!(qty > 0) || seen.has(it.pid)) continue;
    if (qty > 999) throw new UserError('數量太大了');
    const p = pm.get(it.pid);
    const was = oldMap.get(it.pid);
    if (!p && !was) continue;
    if (p && !p.on && !was && by.startsWith('店家')) throw new UserError(`「${p.name}」暫時沒有供貨`);
    seen.add(it.pid);
    const src = p || was;
    // 叫貨量沒變的話，保留理貨已經秤好的實出量
    const keepShip = was && was.qty === qty && was.ship != null ? { ship: was.ship } : {};
    const base = p ? dayPrices[it.pid] ?? p.price : was.base ?? was.price;
    next.push({ pid: it.pid, name: src.name, unit: src.unit, base, price: p ? priceFor(base, it.pid, group) : was.price, qty, ...keepShip });
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
    seq,
    ...(old?.addon || by === '店家補單' ? { addon: true } : {}), // 店家自己開的補單
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
  tx.set(ref, order);
  tx.set(doc('monthly/' + order.month), { amounts: { [monthKey(date, sid, seq)]: next.length ? amountOf(order) : FieldValue.delete() } }, { merge: true });
  return { order, had: !!old?.items.length, changes };
  });
}

export async function setQty(sid, date, pid, qty, who, seq = 1) {
  return saveOrder(sid, date, (old) => {
    const items = (old?.items || []).filter((i) => i.pid !== pid);
    const at = (old?.items || []).findIndex((i) => i.pid === pid);
    const it = { pid, qty: Math.max(0, roundQty(qty) || 0) };
    if (at >= 0) items.splice(at, 0, it); else items.push(it);
    return items;
  }, '後台', who, seq);
}

// 整張刪除（還沒簽收的才可以）：品項清空、對帳金額移除，改單紀錄會留下刪了什麼
export async function deleteSlip(sid, date, who, seq = 1) {
  const o = await getOrder(date, sid, seq);
  if (!o?.items.length) throw new UserError('這張出貨單已經是空的');
  return saveOrder(sid, date, [], '後台', who ? `${who}・整張刪除` : '整張刪除', seq);
}

// 這家店這天所有有品項的單（含補單），依序號排
export async function slipsOfDay(sid, date) {
  const snap = await db().collection('orders').where('date', '==', date).where('storeId', '==', sid).get();
  return snap.docs.map((d) => d.data()).filter((o) => o.items.length).sort((a, b) => (a.seq || 1) - (b.seq || 1));
}

// 後台開補單：跟原本的單分開，另開一張（原本的單有沒有確認都可以）
export async function newSlip(sid, date, pid, qty, who) {
  const seqs = (await slipsOfDay(sid, date)).map((o) => o.seq || 1);
  if (!seqs.length) throw new UserError('這家店這天還沒有出貨單，直接加品項就好');
  return saveOrder(sid, date, [{ pid, qty }], '後台', who, Math.max(...seqs) + 1);
}

// 店家自己補單（截單後加點）：跟原本的訂單分開。還沒確認的店家補單就繼續加在同一張，確認過了再另開一張
export async function addonSlipOf(sid, date) {
  const slips = await slipsOfDay(sid, date);
  for (const o of slips.filter((x) => x.addon).reverse()) {
    if (!(await doc(`signatures/${date}_${slipKey(sid, o.seq || 1)}`).get()).exists) return o;
  }
  return null;
}
// 這家店現在可以補單的配送日：
//   叫貨中的那天，原本的單已經被後台確認（鎖住）了 → 補那一天（到截單為止）
//   否則 → 已截單、還沒過補單截止時間的那天
export async function addonFor(sid) {
  const D = openDate();
  if (getRulesNow().addon && (await doc(`signatures/${D}_${slipKey(sid, 1)}`).get()).exists) return { date: D, until: cutoffLabel(D), mainLocked: true };
  const A = addonDate();
  return A ? { date: A, until: addonUntilLabel(A), mainLocked: false } : null;
}
export async function saveAddon(sid, date, items) {
  if (date !== (await addonFor(sid))?.date) throw new UserError('補單時間已經過了，要追加請直接留言給老闆', 409);
  const cur = await addonSlipOf(sid, date);
  let seq = cur?.seq;
  if (!seq) {
    // 用沒用過的序號（包含已經清空的單），補單才不會蓋到別張
    const snap = await db().collection('orders').where('date', '==', date).where('storeId', '==', sid).get();
    seq = Math.max(0, ...snap.docs.map((d) => d.data().seq || 1)) + 1;
  }
  return saveOrder(sid, date, items, '店家補單', '', seq);
}

// 計價用的數量：理貨秤過就用實出量，沒秤就用叫貨量
export const billQty = (i) => i.ship ?? i.qty;
export const amountOf = (o) => Math.round(o.items.reduce((a, i) => a + billQty(i) * i.price, 0));

// 理貨填實際秤出的量（0＝缺貨，不出貨也不計價）
export async function setShip(sid, date, pid, ship, who, seq = 1) {
  ship = Math.max(0, roundQty(ship) || 0);
  if (ship > 999) throw new UserError('數量太大了');
  const ref = orderDoc(date, sid, seq);
  const sigRef = doc(`signatures/${date}_${slipKey(sid, seq)}`);
  return db().runTransaction(async (tx) => {
    const [sigSnap, snap] = await Promise.all([tx.get(sigRef), tx.get(ref)]);
    if (sigSnap.exists) throw new UserError('這張配送單已經確認，不能再修改；要追加請開補單', 409);
    const o = snap.data();
    const it = o?.items.find((i) => i.pid === pid);
    if (!it) throw new UserError('這家店這天沒有叫這個品項');
    const before = billQty(it);
    if (before === ship) return { order: o };
    if (ship === it.qty) delete it.ship; else it.ship = ship;
    const at = new Date().toISOString();
    o.updatedAt = at;
    o.log = [...(o.log || []), { at, by: '後台', who, text: `實出 ${it.name} ${qtyText(before, it.unit)} → ${ship ? qtyText(ship, it.unit) : '缺貨'}` }];
    tx.set(ref, o);
    tx.set(doc('monthly/' + o.month), { amounts: { [monthKey(date, sid, seq)]: amountOf(o) } }, { merge: true });
    return { order: o };
  });
}

/* ---------- 收款 ---------- */
export const getPaid = async (month) => (await data('paid/' + month))?.stores || {};
export async function setPaid(month, sid, paid) {
  await doc('paid/' + month).set({ stores: { [sid]: paid ? { at: new Date().toISOString() } : FieldValue.delete() } }, { merge: true });
}
