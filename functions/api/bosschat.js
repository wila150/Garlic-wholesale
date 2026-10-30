// 老闆選單的「今日訂單」「未收帳款」（查詢用回覆，不算額度；提醒、催款是推播給店家，會用額度）
import { openDate, buyDate, label, cutoffLabel } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import * as report from '../lib/report.js';
import { remindText, dunningText, statementMessage, money } from '../lib/messages.js';
import { push } from '../lib/line.js';

const pbAct = (label, data, text) => ({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data, displayText: text || label } });
const pushStore = (s, msgs) => Promise.allSettled(s.members.map((m) => push(m.userId, msgs))).then((r) => r.some((x) => x.status === 'fulfilled'));

export async function bossInfo({ said, pb, action }) {
  /* ---------- 今日訂單：還在叫貨的那天，誰叫了、誰還沒叫 ---------- */
  if (/^(今日訂單|今天訂單|訂單狀況|誰還沒叫)$/.test(said) || action === 'remindall') {
    const D = openDate();
    const [stores, orders] = await Promise.all([shop.getStores(), shop.ordersOfDate(D)]);
    const active = stores.filter((s) => s.on);
    const ordered = new Set(orders.map((o) => o.storeId));
    const miss = active.filter((s) => !ordered.has(s.id));
    if (action === 'remindall') {
      const can = miss.filter((s) => s.members.length);
      const ok = (await Promise.all(can.map((s) => pushStore(s, [remindText(D)])))).filter(Boolean).length;
      return { type: 'text', text: `已用 LINE 提醒 ${ok} 家：${can.map((s) => s.name).join('、') || '（沒有綁 LINE 的店）'}${miss.length > can.length ? `\n沒綁 LINE、要打電話的：${miss.filter((s) => !s.members.length).map((s) => s.name).join('、')}` : ''}` };
    }
    const n = (sid) => orders.filter((o) => o.storeId === sid).reduce((a, o) => a + o.items.length, 0);
    const lines = [`📋 ${label(D)} 配送（${cutoffLabel(D)} 截單）`, `已叫 ${ordered.size}／${active.length} 家`];
    if (ordered.size) lines.push('', '✅ 已叫：', ...active.filter((s) => ordered.has(s.id)).map((s) => `・${s.name} ${n(s.id)} 樣`));
    if (miss.length) lines.push('', '⏳ 還沒叫：', ...miss.map((s) => `・${s.name}${s.members.length ? '' : '（沒綁 LINE）'}`));
    // 截單後在買的那天（例如今晚截單後看明天的），也一起列
    const B = buyDate();
    if (B !== D) {
      const bo = await shop.ordersOfDate(B);
      lines.push('', `🚚 ${label(B)} 要送：${new Set(bo.map((o) => o.storeId)).size} 家（已截單）`);
    }
    const canRemind = miss.filter((s) => s.members.length).length;
    return {
      type: 'text', text: lines.join('\n'),
      quickReply: { items: [pbAct('🔄 再看一次', 'action=menuinfo&w=orders', '今日訂單'), ...(canRemind ? [pbAct(`📣 提醒沒叫的 ${canRemind} 家`, 'action=remindall', '提醒沒叫的店家')] : [])] },
    };
  }

  /* ---------- 未收帳款：誰還欠多少，可以直接催款 ---------- */
  if (/^(未收帳款|未收款|應收帳款|誰還沒付)$/.test(said) || action === 'dun') {
    const ar = await report.receivables();
    if (action === 'dun') {
      const s = (await shop.getStores()).find((x) => x.id === pb.get('sid'));
      const a = ar.find((x) => x.storeId === s?.id);
      if (!s || !a) return { type: 'text', text: '這家店已經沒有未收款了。' };
      if (!s.members.length) return { type: 'text', text: `「${s.name}」沒有綁 LINE，請打電話催款${s.phone ? `：${s.phone}` : ''}。` };
      // 先確認一次，免得手滑就傳給客人
      if (!pb.get('go')) return { type: 'text', text: `確定要用 LINE 傳催款通知給「${s.name}」嗎？\n未收 ${money(a.total)}，會附上 ${Math.min(4, a.months.length)} 張對帳單。`, quickReply: { items: [pbAct('📣 確定催款', `action=dun&sid=${s.id}&go=1`, `確定催款：${s.name}`), pbAct('取消', 'action=menuinfo&w=ar', '取消')] } };
      const months = a.months.slice(0, 4).reverse();
      const stmts = await Promise.all(months.map(async (m) => {
        const [rows, paid] = await Promise.all([shop.monthAmounts(m.month), shop.getPaid(m.month)]);
        const mine = rows.filter((r) => r.storeId === s.id).sort((x, y) => x.date.localeCompare(y.date));
        const total = mine.reduce((x, r) => x + r.amount, 0);
        return statementMessage(s, m.month, mine, total, shop.paidSum(paid[s.id], total));
      }));
      await pushStore(s, [...stmts, dunningText(s, a)]);
      return { type: 'text', text: `已傳催款通知和 ${stmts.length} 張對帳單給「${s.name}」（${money(a.total)}）。` };
    }
    if (!ar.length) return { type: 'text', text: '✅ 沒有未收款，全部都收清了！' };
    const total = ar.reduce((a, s) => a + s.total, 0);
    const old = ar.filter((s) => s.months.some((m) => m.age >= 2));
    const lines = [`💰 未收帳款 ${ar.length} 家，共 ${money(total)}`, '', ...ar.slice(0, 20).map((s) => `・${s.name} ${money(s.total)}${s.months.some((m) => m.age >= 2) ? ' ⚠️超過2個月' : ''}\n　${s.months.slice().reverse().map((m) => `${+m.month.slice(5)}月 ${money(m.amount)}`).join('、')}`)];
    if (ar.length > 20) lines.push(`…還有 ${ar.length - 20} 家，到後台「報表」看`);
    if (old.length) lines.push('', `⚠️ ${old.length} 家超過 2 個月沒付清`);
    return {
      type: 'text', text: lines.join('\n'),
      quickReply: { items: ar.filter((s) => s.hasLine).slice(0, 12).map((s) => pbAct(`催 ${s.name}`, `action=dun&sid=${s.storeId}`, `催款：${s.name}`)) },
    };
  }
  if (action === 'menuinfo') return bossInfo({ said: pb.get('w') === 'orders' ? '今日訂單' : '未收帳款', pb, action: '' });
  return null;
}
