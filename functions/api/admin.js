// 後台 API：用 Firebase 登入，依角色決定能做什麼（見 lib/auth.js）
import { SHOP, CATEGORIES, CUTOFF_HOUR } from '../lib/config.js';
import { json, fail, readJSON, UserError } from '../lib/http.js';
import { push } from '../lib/line.js';
import { openDate, today, thisMonth, isDate, isMonth } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import { signedIn, need, can, ROLES, listUsers, addUser, updateUser, removeUser } from '../lib/auth.js';
import { remindText, statementMessage, approvedText, dunningText, receiptMessage } from '../lib/messages.js';
import { getFirestore } from 'firebase-admin/firestore';
import * as report from '../lib/report.js';

async function statement(month, storeId) {
  const rows = (await shop.monthAmounts(month)).filter((r) => r.storeId === storeId).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, total: rows.reduce((a, r) => a + r.amount, 0) };
}

// 這天各店的簽收紀錄（不含圖片）
async function signaturesOf(date) {
  const snap = await getFirestore().collection('signatures').where('date', '==', date).get();
  return Object.fromEntries(snap.docs.map((d) => { const { png, ...rest } = d.data(); return [rest.key || rest.storeId, rest]; }));
}

async function pushToStore(store, messages) {
  if (!store.members.length) throw new UserError(`「${store.name}」還沒綁定 LINE 帳號`);
  const results = await Promise.allSettled(store.members.map((m) => push(m.userId, messages)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error(r.reason));
  if (!ok) throw new UserError('LINE 訊息沒送出，可能是本月訊息額度用完了');
  return ok;
}

export async function GET(request) {
  try {
    const me = await signedIn(request);
    need(me, 'view');
    const q = new URL(request.url).searchParams;
    // 簽名圖另外載（列印、查看時才需要）
    if (q.get('sig')) {
      need(me, 'view');
      const s = (await getFirestore().doc('signatures/' + q.get('sig').replace(/[^\w-]/g, '')).get()).data();
      return json({ signature: s || null });
    }
    // AI 叫貨紀錄（最近 30 筆）
    if (q.get('ai')) {
      need(me, 'editOrders');
      const snap = await getFirestore().collection('aiDrafts').orderBy('createdAt', 'desc').limit(30).get();
      return json({ drafts: snap.docs.map((d) => d.data()) });
    }
    // 報表分頁另外載（要讀整個月的訂單）
    if (q.get('report')) {
      need(me, 'bills');
      const m = isMonth(q.get('report')) ? q.get('report') : thisMonth();
      const [r, ar] = await Promise.all([report.monthReport(m), report.receivables()]);
      return json({ ...r, receivables: ar });
    }
    const date = isDate(q.get('date')) ? q.get('date') : openDate();
    const month = isMonth(q.get('month')) ? q.get('month') : thisMonth();
    const bills = can(me.role, 'bills');
    const [stores, products, pending, monthRows, paid, dayOrders, dayPrices, units, users, priceGroups] = await Promise.all([
      shop.getStores(), shop.getProducts(),
      can(me.role, 'stores') ? shop.listPending() : [],
      bills ? shop.monthAmounts(month) : [],
      bills ? shop.getPaid(month) : {},
      shop.ordersOfDate(date),
      shop.getDayPrices(date),
      shop.getUnits(),
      can(me.role, 'users') ? listUsers() : [],
      can(me.role, 'prices') ? shop.getPriceGroups() : [],
    ]);
    const showPrices = can(me.role, 'prices') || bills;
    return json({
      me: { ...me, roleName: ROLES[me.role], can: ['bills', 'prices', 'editOrders', 'products', 'stores', 'remind', 'statement', 'users', 'sign'].filter((w) => can(me.role, w)) },
      roles: ROLES,
      shop: { name: SHOP.name, phone: SHOP.phone, payTerms: SHOP.payTerms },
      categories: CATEGORIES,
      units,
      cutoffHour: CUTOFF_HOUR,
      today: today(),
      openDate: openDate(),
      date,
      month,
      stores,
      // 理貨、司機看不到單價
      products: showPrices ? products : products.map(({ price, ...p }) => p),
      pending,
      orders: showPrices ? dayOrders : dayOrders.map((o) => ({ ...o, items: o.items.map(({ price, ...i }) => i) })),
      signatures: await signaturesOf(date),
      dayPrices: showPrices ? dayPrices : {},
      dayCosts: can(me.role, 'prices') ? await shop.getDayCosts(date) : {},
      monthRows,
      paid,
      users,
      priceGroups,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const me = await signedIn(request);
    const b = await readJSON(request);
    const store = async () => {
      const s = (await shop.getStores()).find((x) => x.id === b.storeId);
      if (!s) throw new UserError('找不到這家店', 404);
      return s;
    };

    switch (b.action) {
      case 'setQty': {
        need(me, 'editOrders');
        await store();
        const r = await shop.setQty(b.storeId, b.date, b.pid, b.qty, me.name, b.seq);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(({ price, ...i }) => i);
        return json(r);
      }
      case 'setShip': {
        need(me, 'editOrders');
        await store();
        const r = await shop.setShip(b.storeId, b.date, b.pid, b.ship, me.name, b.seq);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(({ price, ...i }) => i);
        return json(r);
      }
      case 'newSlip': {
        need(me, 'editOrders');
        await store();
        const r = await shop.newSlip(b.storeId, b.date, b.pid, b.qty, me.name);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(({ price, ...i }) => i);
        return json(r);
      }
      case 'dayPrices':
        need(me, 'prices');
        return json({ dayPrices: await shop.setDayPrices(b.date, b.prices, b.costs) });
      case 'units':
        need(me, 'products');
        return json({ units: await shop.saveUnits(b.units) });
      case 'products':
        need(me, 'products');
        return json({ products: await shop.saveProducts(b.products) });
      case 'priceGroups':
        need(me, 'stores');
        return json({ priceGroups: await shop.savePriceGroups(b.priceGroups) });
      case 'stores':
        need(me, 'stores');
        return json({ stores: await shop.saveStores(b.stores) });
      case 'approve': {
        need(me, 'stores');
        const s = await shop.approve(b.userId, { storeId: b.storeId, newStore: b.newStore });
        await push(b.userId, [approvedText(s)]).catch((err) => console.error(err));
        return json({ store: s });
      }
      case 'reject':
        need(me, 'stores');
        await shop.reject(b.userId);
        return json({ ok: true });
      case 'unbind':
        need(me, 'stores');
        await shop.unbind(b.userId);
        return json({ ok: true });
      case 'remind': {
        need(me, 'remind');
        const date = openDate();
        const stores = (await shop.getStores()).filter((s) => b.storeIds?.includes(s.id) && s.members.length);
        const res = await Promise.allSettled(stores.map((s) => pushToStore(s, [remindText(date)])));
        return json({ sent: res.filter((r) => r.status === 'fulfilled').length, total: stores.length });
      }
      case 'statement': {
        need(me, 'statement');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        const s = await store();
        const { rows, total } = await statement(b.month, s.id);
        if (!rows.length) throw new UserError('這個月沒有送貨紀錄');
        await pushToStore(s, [statementMessage(s, b.month, rows, total)]);
        return json({ ok: true });
      }
      case 'paid': {
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        await store();
        await shop.setPaid(b.month, b.storeId, !!b.paid);
        return json({ paid: await shop.getPaid(b.month) });
      }
      case 'receipt': {
        need(me, 'statement');
        if (!isDate(b.date)) throw new UserError('日期不正確');
        const stores = (await shop.getStores()).filter((s) => b.storeIds?.includes(s.id) && s.members.length);
        const orders = await shop.ordersOfDate(b.date);
        // 一家店有補單的話，每張各一則收據（LINE 一次最多 5 則）
        const res = await Promise.allSettled(stores.map((s) => {
          const mine = orders.filter((x) => x.storeId === s.id).sort((a, c) => (a.seq || 1) - (c.seq || 1)).slice(0, 5);
          return mine.length ? pushToStore(s, mine.map((o) => receiptMessage(s, b.date, o, shop.billQty))) : Promise.reject(new Error('沒有訂單'));
        }));
        const at = new Date().toISOString();
        await Promise.all(orders.filter((o) => stores.some((s, i) => s.id === o.storeId && res[i].status === 'fulfilled'))
          .map((o) => getFirestore().doc(`orders/${b.date}_${shop.slipKey(o.storeId, o.seq || 1)}`).update({ receiptSentAt: at })));
        return json({ sent: res.filter((r) => r.status === 'fulfilled').length, total: stores.length });
      }
      case 'sign': {
        need(me, 'sign');
        if (!isDate(b.date)) throw new UserError('日期不正確');
        const s = await store();
        const png = String(b.png || '');
        if (!/^data:image\/png;base64,/.test(png) || png.length > 300000) throw new UserError('簽名圖片不正確');
        const seq = Math.max(1, Math.floor(Number(b.seq)) || 1);
        const key = shop.slipKey(s.id, seq);
        if ((await getFirestore().doc(`signatures/${b.date}_${key}`).get()).exists) throw new UserError('這張出貨單已經簽收過了，不能重簽', 409);
        if (!(await shop.getOrder(b.date, s.id, seq))?.items.length) throw new UserError('這張出貨單沒有品項');
        const signer = String(b.signer || '').trim().slice(0, 20);
        const rec = { date: b.date, storeId: s.id, seq, key, png, signer, by: me.name, at: new Date().toISOString() };
        await getFirestore().doc(`signatures/${b.date}_${key}`).set(rec);
        return json({ signature: { ...rec, png: undefined } });
      }
      case 'costTypes':
        need(me, 'bills');
        return json({ costTypes: await report.saveCostTypes(b.costTypes) });
      case 'costs':
        need(me, 'bills');
        if (!isMonth(b.month)) throw new UserError('月份不正確');
        await report.saveCosts(b.month, b);
        return json(await report.monthReport(b.month));
      case 'dunning': {
        need(me, 'statement');
        const s = await store();
        const ar = (await report.receivables()).find((x) => x.storeId === s.id);
        if (!ar) throw new UserError(`「${s.name}」沒有未收款`);
        await pushToStore(s, [dunningText(s, ar)]);
        return json({ ok: true });
      }
      case 'addUser':
        need(me, 'users');
        return json({ users: await addUser(b) });
      case 'updateUser':
        need(me, 'users');
        if (b.email === me.email) throw new UserError('不能改自己的帳號');
        return json({ users: await updateUser(b) });
      case 'removeUser':
        need(me, 'users');
        if (b.email === me.email) throw new UserError('不能刪除自己的帳號');
        return json({ users: await removeUser(b) });
    }
    throw new UserError('不支援的操作');
  } catch (e) {
    return fail(e);
  }
}
