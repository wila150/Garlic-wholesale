// LINE 訊息（Flex Message）。給店家的叫貨訊息不放價格，只有對帳單有金額。
import { SHOP, CUTOFF_HOUR } from './config.js';
import { label, cutoffLabel, md } from './dates.js';
import { qtyText } from './qty.js';

const C = { head: '#1F3A2C', headText: '#EEF3EA', sub: '#A9BFAE', tag: '#F5D547', text: '#1B2A21', muted: '#5B6B60', green: '#06C755' };
export const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

const text = (t, o = {}) => ({ type: 'text', text: String(t || ' '), size: 'sm', color: C.text, wrap: true, ...o });
const row = (l, r, { margin, ...o } = {}) => ({
  type: 'box',
  layout: 'horizontal',
  ...(margin ? { margin } : {}),
  contents: [text(l, { flex: 5, ...o }), text(r, { flex: 3, align: 'end', ...o })],
});
const sep = { type: 'separator', margin: 'md' };
const button = (label, uri) => ({ type: 'button', style: 'primary', color: C.green, height: 'sm', action: { type: 'uri', label, uri } });

function bubble(title, sub, body, footer) {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: C.head,
      contents: [text(title, { color: C.headText, weight: 'bold', size: 'lg' }), ...(sub ? [text(sub, { color: C.tag, size: 'xs', weight: 'bold' })] : [])],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } } : {}),
  };
}
const flex = (altText, contents) => ({ type: 'flex', altText, contents });

export function welcome(bound) {
  return {
    type: 'text',
    text: bound
      ? `您好，點下方「我要叫貨」就可以叫貨，不用打字。前一天 ${CUTOFF_HOUR}:00 截單，隔天送到。`
      : `您好，這裡是${SHOP.name}。\n第一次使用請點下方「我要叫貨」申請開通，老闆開通後就能直接在 LINE 叫貨。`,
  };
}

// 叫貨單卡片：items 只有品名和數量
export function orderCard(title, store, date, order, url, editable = true) {
  const items = order?.items || [];
  const body = items.length
    ? items.map((i) => row(i.name, qtyText(i.qty, i.unit), { weight: 'bold' }))
    : [text('還沒叫貨', { color: C.muted })];
  const foot = editable ? `共 ${items.length} 項，${cutoffLabel(date)} 前可以修改` : `共 ${items.length} 項，已截單`;
  return bubble(title, `${store.name}・${label(date)} 配送`, [...body, sep, text(foot, { size: 'xs', color: C.muted, margin: 'md' })],
    editable ? [button(items.length ? '修改訂單' : '我要叫貨', url)] : null);
}
export const orderMessage = (title, ...args) => flex(`${title}`, orderCard(title, ...args));

export function myOrders(store, cards) {
  return flex('我的訂單', cards.length === 1 ? cards[0] : { type: 'carousel', contents: cards });
}

export function remindText(date) {
  return { type: 'text', text: `提醒您：${label(date)} 配送的貨，${cutoffLabel(date)} 截單，今天還沒叫貨喔！點下方「我要叫貨」就可以叫。` };
}

export function statementMessage(store, month, rows, total) {
  const [y, m] = month.split('-');
  return flex(`${+m} 月對帳單 ${money(total)}`, bubble(`${+m} 月對帳單`, `${store.name}・${y}/${m}`, [
    ...rows.map((r) => row(md(r.date), money(r.amount))),
    sep,
    row(`本月應付（${rows.length} 天）`, money(total), { weight: 'bold', size: 'md', margin: 'md' }),
    text(SHOP.payTerms, { size: 'xs', color: C.muted }),
  ]));
}

export function approvedText(store) {
  return { type: 'text', text: `已幫您開通「${store.name}」的叫貨帳號！\n點下方「我要叫貨」就可以開始叫貨。` };
}
