// LINE Messaging API webhook：https://你的網址/api/webhook
import { SHOP } from '../lib/config.js';
import { verifySignature, reply, displayName, notifyAdmins } from '../lib/line.js';
import { orderLink } from '../lib/token.js';
import { originOf } from '../lib/http.js';
import { openDate, today, addDays } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import { welcome, orderMessage, orderCard, myOrders } from '../lib/messages.js';
import { looksLikeOrder } from '../lib/ai.js';
import { queue, confirmDraft } from '../lib/aiorder.js';

export async function POST(request) {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get('x-line-signature'))) {
    return new Response('bad signature', { status: 401 });
  }
  const { events = [] } = JSON.parse(raw);
  const origin = originOf(request);
  await Promise.all(events.map((e) => handle(e, origin).catch((err) => console.error(err))));
  return new Response('ok');
}

async function handle(e, origin) {
  const uid = e.source?.userId;
  if (!uid || !e.replyToken || e.source.type !== 'user') return;
  const store = await shop.storeOfUser(uid);
  const url = orderLink(origin, uid);
  const say = (...messages) => reply(e.replyToken, messages);

  if (e.type === 'follow') return say(welcome(!!store));

  const said = e.type === 'message' && e.message.type === 'text' ? e.message.text.trim() : '';
  const pb = e.type === 'postback' ? new URLSearchParams(e.postback.data) : new URLSearchParams();
  const action = pb.get('action') || '';
  const wantsOrder = action === 'order' || /叫貨|叫菜|訂貨|下單|訂購/.test(said);
  const wantsMine = action === 'mine' || /^(我的訂單|查訂單|訂單查詢)$/.test(said);

  if (/^我的\s*id$/i.test(said)) {
    return say({ type: 'text', text: `您的 LINE userId：\n${uid}\n\n老闆把它填到 ADMIN_LINE_USER_IDS，就能收到開通申請通知。` });
  }
  if (action === 'contact' || /^聯絡(我們|老闆)?$/.test(said)) {
    return say({ type: 'text', text: `直接在這裡留言就可以，老闆看到會回覆您。${SHOP.phone ? `\n急事請打 ${SHOP.phone}` : ''}` });
  }

  // 還沒開通的人
  if (!store) {
    if (wantsOrder || wantsMine) {
      const name = await displayName(uid);
      const isNew = await shop.addPending(uid, name);
      if (isNew) await notifyAdmins(`🧄 有人申請叫貨帳號：${name || '（未知名稱）'}\n到後台「店家」開通：${origin}/admin`);
      return say({ type: 'text', text: '您還沒開通叫貨帳號，已經通知老闆了。\n請直接回覆您的「店名」，方便老闆幫您開通，開通後會再通知您。' });
    }
    // 申請中的人回覆的文字（通常是店名）記下來給老闆看
    if (said && (await shop.listPending()).some((p) => p.userId === uid)) await shop.addPending(uid, '', said);
    return;
  }

  // 圖文選單「拍照叫貨」：回快速回覆按鈕，點了直接開相機或相簿（圖文選單本身不能開相機）
  if (said === '拍照叫貨' || action === 'photo') {
    return say({
      type: 'text',
      text: '請拍一張叫貨單（手寫的也可以），或從相簿選照片。\n傳過來後大約 20 秒，會整理好給您確認。',
      quickReply: { items: [
        { type: 'action', action: { type: 'camera', label: '📷 拍照' } },
        { type: 'action', action: { type: 'cameraRoll', label: '🖼 從相簿選' } },
      ] },
    });
  }

  // AI 叫貨（放在關鍵字前面，「幫我叫貨 大蒜3」才會走 AI）：直接打字（像「大蒜3、去皮15斤」）或傳手寫單照片，交給 aiOrder 函式處理
  if (process.env.AI_ORDER !== 'off') {
    if (said && looksLikeOrder(said)) return queue({ type: 'text', text: said, userId: uid, replyToken: e.replyToken, origin });
    if (e.type === 'message' && e.message.type === 'image') return queue({ type: 'image', messageId: e.message.id, userId: uid, replyToken: e.replyToken, origin });
  }

  // 叫貨頁送出後，LIFF 會用店家的身分傳這幾句話進來，這裡回訂單卡（回覆不算訊息額度）
  const fromLiff = said.match(/^(訂單已送出|訂單已更新|取消今天的訂單)$/);
  if (fromLiff || wantsOrder) {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    if (said === '取消今天的訂單') return say({ type: 'text', text: '好的，這次的訂單已取消。' });
    const title = fromLiff ? (said === '訂單已更新' ? '訂單已更新' : '訂單已收到') : '叫貨單';
    return say(orderMessage(title, store, D, o, url));
  }

  if (wantsMine) {
    const D = openDate();
    const cards = [];
    // 已截單、還沒送的（例如今晚截單後問明天的貨）
    for (let d = addDays(today(), 1); d < D; d = addDays(d, 1)) {
      const o = await shop.getOrder(d, store.id);
      if (o?.items.length) cards.push(orderCard('已截單', store, d, o, url, false));
    }
    cards.push(orderCard('我的訂單', store, D, await shop.getOrder(D, store.id), url));
    return say(myOrders(store, cards));
  }
  // AI 叫貨：店家按「確認送出」
  if (action === 'aiok') return say(await confirmDraft(uid, pb.get('id'), origin));

  // 其他訊息不自動回覆，讓老闆在 LINE 官方帳號後台手動回
}
