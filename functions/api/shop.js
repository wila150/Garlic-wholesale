// 店家叫貨頁用的 API（不回傳任何價格）
import { SHOP, PRESET } from '../lib/config.js';
import { verify, orderLink } from '../lib/token.js';
import { json, fail, readJSON, originOf, UserError } from '../lib/http.js';
import { push, notifyAdmins } from '../lib/line.js';
import { openDate, label, cutoffLabel, addonDate, addonUntilLabel, getRulesNow } from '../lib/dates.js';
import { qtyText } from '../lib/qty.js';
import * as shop from '../lib/shop.js';
import { orderMessage } from '../lib/messages.js';
import { draftFor, markDraftUsed } from '../lib/aiorder.js';

// 店家看不到任何價格：只回需要的欄位（白名單），不要用「拿掉 price」的方式，免得 base、cost 漏出去
const noPrice = (o) => o && { date: o.date, v: o.updatedAt || null, items: o.items.map(({ pid, name, unit, qty }) => ({ pid, name, unit, qty })) };

// 送出時檢查訂單在店家打開頁面之後有沒有被改過（別的手機、AI 叫貨、後台），改過就擋下來，免得舊頁面整張蓋掉
const unchanged = (v, items) => (old) => {
  if ((old?.items.length ? old.updatedAt : null) !== (v ?? null)) throw new UserError('這張單剛剛有變動（可能是別的手機或 AI 叫貨），已經重新載入，請再確認一次', 409);
  return items;
};

export async function GET(request) {
  try {
    const q = new URL(request.url).searchParams;
    const t = q.get('t');
    const uid = verify(t);
    if (!uid) return json({ error: t ? '這個叫貨連結過期了，請回到 LINE 再點一次「我要叫貨」' : '請從 LINE 點「我要叫貨」開啟這個頁面', shopName: SHOP.name }, 401);
    const store = await shop.storeOfUser(uid);
    if (!store) return json({ error: '您的帳號還沒開通，老闆開通後就能叫貨', shopName: SHOP.name }, 403);
    const D = openDate();
    const AF = await shop.addonFor(store.id);
    const A = AF?.date;
    const [products, order, last, addonSlip, addonBase] = await Promise.all([
      shop.getProducts(), shop.getOrder(D, store.id), shop.lastOrder(store.id, D),
      A ? shop.addonSlipOf(store.id, A) : null, A ? shop.slipsOfDay(store.id, A) : [],
    ]);
    return json({
      shopName: SHOP.name,
      palette: getRulesNow().palette,
      logo: SHOP.logo,
      search: PRESET.search,
      liffId: SHOP.liffId,
      store: { name: store.name },
      date: D,
      dateLabel: label(D),
      cutoff: cutoffLabel(D),
      categories: await shop.getCategories(),
      products: products.map(({ id, cat, name, unit, on, alias }) => ({ id, cat, name, unit, on, alias })),
      order: order?.items.length ? noPrice(order) : null,
      last: last ? noPrice(last) : null,
      draft: q.get('d') ? await draftFor(uid, q.get('d')) : null,
      // 截單後還能補單的配送日：補單跟原本的訂單分開，另開一張
      addon: A ? {
        date: A,
        dateLabel: label(A),
        until: AF.until,
        mainLocked: AF.mainLocked,
        order: addonSlip ? noPrice(addonSlip) : null,
        others: addonBase.filter((o) => o.seq !== addonSlip?.seq).map((o) => ({ seq: o.seq || 1, addon: !!o.addon, items: o.items.map((i) => ({ name: i.name, unit: i.unit, qty: i.qty })) })),
      } : null,
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(request) {
  try {
    const body = await readJSON(request);
    const uid = verify(body.t);
    if (!uid) throw new UserError('這個叫貨連結過期了，請回到 LINE 再點一次「我要叫貨」', 401);
    const store = await shop.storeOfUser(uid);
    if (!store) throw new UserError('您的帳號還沒開通', 403);
    if (body.mode === 'addon') {
      const { order, had, changes } = await shop.saveAddon(store.id, body.date, unchanged(body.v, body.items));
      // 通知老闆有人補單（每位老闆用掉 1 則推播額度）
      const what = order.items.length ? (had ? `修改補單：${changes.join('、')}` : '補單：' + order.items.map((i) => `${i.name} ${qtyText(i.qty, i.unit)}`).join('、')) : '取消補單';
      await notifyAdmins(`🧾 ${store.name} ${label(body.date)} ${what}\n後台：${originOf(request)}/admin`).catch((err) => console.error(err));
      return json({ order: noPrice(order), had, changes });
    }
    const { order, had, changes } = await shop.saveOrder(store.id, body.date, unchanged(body.v, body.items), '店家', body.draftId ? 'AI 整理後修改' : '');
    if (body.draftId) await markDraftUsed(String(body.draftId), store.id);

    // 沒有用 LIFF 的話，叫貨頁沒辦法替店家在聊天室發訊息；有設定 PUSH_ORDER_CONFIRM 才主動推播（會用掉訊息額度）
    if (process.env.PUSH_ORDER_CONFIRM === '1' && !body.viaLiff) {
      const title = !order.items.length ? null : had ? '訂單已更新' : '訂單已收到';
      const msg = title ? orderMessage(title, store, order.date, order, orderLink(originOf(request), uid)) : { type: 'text', text: '好的，這次的訂單已取消。' };
      await push(uid, [msg]).catch((err) => console.error(err));
    }
    return json({ order: noPrice(order), had, changes });
  } catch (e) {
    return fail(e);
  }
}
