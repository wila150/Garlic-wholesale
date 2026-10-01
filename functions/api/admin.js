// 後台 API：用 Firebase 登入，依角色決定能做什麼（見 lib/auth.js）
import { SHOP, CATEGORIES, CUTOFF_HOUR } from '../lib/config.js';
import { json, fail, readJSON, UserError } from '../lib/http.js';
import { push } from '../lib/line.js';
import { openDate, today, thisMonth, isDate, isMonth } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import { signedIn, need, can, ROLES, listUsers, addUser, updateUser, removeUser } from '../lib/auth.js';
import { remindText, statementMessage, approvedText } from '../lib/messages.js';

async function statement(month, storeId) {
  const rows = (await shop.monthAmounts(month)).filter((r) => r.storeId === storeId).sort((a, b) => a.date.localeCompare(b.date));
  return { rows, total: rows.reduce((a, r) => a + r.amount, 0) };
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
    const date = isDate(q.get('date')) ? q.get('date') : openDate();
    const month = isMonth(q.get('month')) ? q.get('month') : thisMonth();
    const bills = can(me.role, 'bills');
    const [stores, products, pending, monthRows, paid, dayOrders, dayPrices, units, users] = await Promise.all([
      shop.getStores(), shop.getProducts(),
      can(me.role, 'stores') ? shop.listPending() : [],
      bills ? shop.monthAmounts(month) : [],
      bills ? shop.getPaid(month) : {},
      shop.ordersOfDate(date),
      shop.getDayPrices(date),
      shop.getUnits(),
      can(me.role, 'users') ? listUsers() : [],
    ]);
    const showPrices = can(me.role, 'prices') || bills;
    return json({
      me: { ...me, roleName: ROLES[me.role], can: ['bills', 'prices', 'editOrders', 'products', 'stores', 'remind', 'statement', 'users'].filter((w) => can(me.role, w)) },
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
      dayPrices: showPrices ? dayPrices : {},
      monthRows,
      paid,
      users,
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
        const r = await shop.setQty(b.storeId, b.date, b.pid, b.qty, me.name);
        if (!can(me.role, 'prices')) r.order.items = r.order.items.map(({ price, ...i }) => i);
        return json(r);
      }
      case 'dayPrices':
        need(me, 'prices');
        return json({ dayPrices: await shop.setDayPrices(b.date, b.prices) });
      case 'units':
        need(me, 'products');
        return json({ units: await shop.saveUnits(b.units) });
      case 'products':
        need(me, 'products');
        return json({ products: await shop.saveProducts(b.products) });
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
