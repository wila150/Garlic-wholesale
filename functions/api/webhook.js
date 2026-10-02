// LINE Messaging API webhook：https://你的網址/api/webhook
import { SHOP } from '../lib/config.js';
import { verifySignature, reply, displayName, notifyAdmins, loading } from '../lib/line.js';
import { orderLink } from '../lib/token.js';
import { originOf } from '../lib/http.js';
import { openDate, today, addDays, addonDate } from '../lib/dates.js';
import * as shop from '../lib/shop.js';
import { welcome, orderMessage, orderCard, myOrders, addonCard, flex } from '../lib/messages.js';
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

  // 店家確認配送單後按「回傳給老闆」帶過來的訊息
  if (/^已(確認|簽收)/.test(said)) return say({ type: 'text', text: '收到您的確認，謝謝！' });

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
    // AI 讀的時候先顯示「…」（文字約 5 秒、照片約 20 秒）
    if (said && looksLikeOrder(said)) return loading(uid, 20).then(() => queue({ type: 'text', text: said, userId: uid, replyToken: e.replyToken, origin }));
    if (e.type === 'message' && e.message.type === 'image') return loading(uid, 60).then(() => queue({ type: 'image', messageId: e.message.id, userId: uid, replyToken: e.replyToken, origin }));
  }

  // 叫貨頁送出後，LIFF 會用店家的身分傳這幾句話進來，這裡回訂單卡（回覆不算訊息額度）
  const fromLiff = said.match(/^(訂單已送出|訂單已更新|取消今天的訂單)$/);
  const A = addonDate();
  const addonUrl = `${url}&m=addon`;
  // 截單後加點：補單跟原本的訂單分開，另開一張
  if (/^(補單|加點|追加|補單已送出|補單已更新|取消補單)$/.test(said)) {
    if (!A) return say({ type: 'text', text: '現在沒有可以補單的配送日。要叫貨請點「我要叫貨」；急著加點請直接留言給老闆。' });
    if (said === '取消補單') return say({ type: 'text', text: '好的，補單已取消。' });
    const o = await shop.addonSlipOf(store.id, A);
    return say(flex(said.startsWith('補單已') ? said : '補單', addonCard(store, A, o, addonUrl)));
  }
  if (fromLiff || wantsOrder) {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    if (said === '取消今天的訂單') return say({ type: 'text', text: '好的，這次的訂單已取消。' });
    const title = fromLiff ? (said === '訂單已更新' ? '訂單已更新' : '訂單已收到') : '叫貨單';
    // 還能補單的話，多附一張補單卡片（回覆不算訊息額度）
    if (!fromLiff && A) return say(flex('叫貨單', { type: 'carousel', contents: [orderCard(title, store, D, o, url), addonCard(store, A, await shop.addonSlipOf(store.id, A), addonUrl)] }));
    return say(orderMessage(title, store, D, o, url));
  }

  if (wantsMine) {
    const D = openDate();
    const cards = [];
    // 今天要送的、已截單還沒送的（例如今晚截單後問明天的貨），連補單一起列
    for (let d = today(); d <= D; d = addDays(d, 1)) {
      // 叫貨中的那張可以修改，沒叫貨也要顯示（按鈕是「我要叫貨」）
      if (d === D) cards.push(orderCard('我的訂單', store, D, await shop.getOrder(D, store.id), url));
      for (const o of await shop.slipsOfDay(store.id, d)) {
        const seq = o.seq || 1;
        if (d === D && seq === 1) continue;
        const title = seq > 1 || o.addon ? `補單 #${seq}` : d === today() ? '今天配送' : '已截單';
        cards.push(orderCard(title, store, d, o, url, false));
      }
    }
    return say(myOrders(store, cards.slice(-12)));
  }
  // AI 叫貨：店家按「確認送出」
  if (action === 'aiok') return say(await confirmDraft(uid, pb.get('id'), origin));

  // 其他訊息不自動回覆，讓老闆在 LINE 官方帳號後台手動回
}
