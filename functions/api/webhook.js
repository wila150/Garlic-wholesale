// LINE Messaging API webhook：https://你的網址/api/webhook
import { SHOP } from '../lib/config.js';
import { verifySignature, reply, displayName, notifyAdmins, loading } from '../lib/line.js';
import { orderLink } from '../lib/token.js';
import { originOf } from '../lib/http.js';
import { openDate, today, addDays, label, cutoffLabel, getRulesNow } from '../lib/dates.js';
import { qtyText } from '../lib/qty.js';
import * as shop from '../lib/shop.js';
import { welcome, orderMessage, orderCard, myOrders, addonCard, flex } from '../lib/messages.js';
import { looksLikeOrder } from '../lib/ai.js';
import { queue, confirmDraft, aiQuotaOk } from '../lib/aiorder.js';

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

  // 掃店家的綁定 QR Code：聊天室帶好「綁定 XXXXXXXX」，送出就自動綁好（回覆不算訊息額度）
  const bindCode = said.match(/^綁定\s*([A-Za-z0-9]{6,12})$/)?.[1];
  if (bindCode) {
    try {
      const name = await displayName(uid);
      const r = await shop.bindByInvite(uid, name, bindCode);
      if (r.already) return say({ type: 'text', text: `您已經綁定「${r.store.name}」了，要叫貨直接打字傳過來就好。` });
      if (process.env.BIND_NOTIFY !== 'off') await notifyAdmins(`🔗 ${r.store.name} 多綁了一個 LINE：${name || '（未知名稱）'}\n不是你們的人的話，到後台「店家」解除：${origin}/admin`).catch(() => {});
      return say({ type: 'text', text: `✅ 已綁定「${r.store.name}」，可以叫貨了！\n\n・直接打字傳過來，例如「${SHOP.example}」\n・或在紙上寫好，點「拍照叫貨」拍照` });
    } catch (err) {
      if (err.status) return say({ type: 'text', text: err.message });
      throw err;
    }
  }

  // 還沒開通的人
  if (!store) {
    // 已經綁定、但店家被設成暫停合作：不要當成新申請
    if (await shop.isPausedMember(uid)) return say({ type: 'text', text: '您的店家目前暫停叫貨，有問題請直接在這裡留言給老闆。' });
    // 新店家自己開通：請他填店名、地址、電話（叫貨頁的表單），填完馬上能叫貨；先傳的叫貨內容會留著，開通後幫他整理
    if (getRulesNow().autoJoin !== false) {
      const orderText = said && looksLikeOrder(said) ? said : '';
      if (!(wantsOrder || wantsMine || orderText || said === '拍照叫貨' || action === 'photo' || (e.type === 'message' && e.message.type === 'image'))) return;
      await shop.addPending(uid, await displayName(uid), '', { order: orderText });
      return say({
        type: 'template',
        altText: '第一次叫貨，請先填店家資料',
        template: {
          type: 'buttons',
          text: `第一次使用，請先填店家資料（店名、地址、電話），填完馬上就能叫貨。${orderText ? '\n剛剛傳的叫貨內容會幫您留著。' : ''}`,
          actions: [{ type: 'uri', label: '📝 填店家資料', uri: url }],
        },
      });
    }
    if (wantsOrder || wantsMine || said === '拍照叫貨' || action === 'photo' || (e.type === 'message' && e.message.type === 'image')) {
      const name = await displayName(uid);
      const isNew = await shop.addPending(uid, name);
      if (isNew) await notifyAdmins(`🧄 有人申請叫貨帳號：${name || '（未知名稱）'}\n到後台「店家」開通：${origin}/admin`);
      return say({ type: 'text', text: '您還沒開通叫貨帳號，已經通知老闆了。\n請直接回覆您的「店名」，方便老闆幫您開通，開通後會再通知您。' });
    }
    // 申請中的人回覆的文字（通常是店名）記下來給老闆看；只記第一句，不會被後來的話蓋掉
    if (said && (await shop.getPending(uid))) {
      const saved = await shop.addPending(uid, '', said, { keepText: true });
      return say({ type: 'text', text: saved ? `收到「${said.slice(0, 20)}」，老闆開通後會通知您。` : '已經通知老闆了，開通後會通知您。' });
    }
    return;
  }

  // 店家確認配送單後按「回傳給老闆」帶過來的訊息
  if (/^已(確認|簽收)/.test(said)) return say({ type: 'text', text: '收到您的確認，謝謝！' });
  // 開通表單送出後，叫貨頁用店家的身分傳這句進來
  if (said === '開通完成') return say({ type: 'text', text: `✅「${store.name}」開通好了！\n\n要叫貨直接打字傳過來就好，例如：\n${SHOP.example}\n也可以點下方「拍照叫貨」拍手寫單。` });

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
  const isAiText = said && looksLikeOrder(said) && !/有問題|不對|少了|壞|爛|\?|？/.test(said);
  const isAiImage = e.type === 'message' && e.message.type === 'image';
  if (process.env.AI_ORDER !== 'off' && (isAiText || isAiImage) && !(await aiQuotaOk(store.id))) {
    return say({ type: 'text', text: '今天用 AI 整理的次數太多了，請點下方「我要叫貨」→「用清單選」，或直接留言給老闆。' });
  }
  if (process.env.AI_ORDER !== 'off') {
    // AI 讀的時候先顯示「…」（文字約 5 秒、照片約 20 秒）
    // 回報配送單有問題、問問題這類訊息不要送去 AI 叫貨
    if (said && looksLikeOrder(said) && !/有問題|不對|少了|壞|爛|\?|？/.test(said)) return loading(uid, 20).then(() => queue({ type: 'text', text: said, userId: uid, replyToken: e.replyToken, origin }, e.webhookEventId));
    if (e.type === 'message' && e.message.type === 'image') return loading(uid, 60).then(() => queue({ type: 'image', messageId: e.message.id, userId: uid, replyToken: e.replyToken, origin }, e.webhookEventId));
  }

  // 叫貨頁送出後，LIFF 會用店家的身分傳這幾句話進來，這裡回訂單卡（回覆不算訊息額度）
  const fromLiff = said.match(/^(訂單已送出|訂單已更新|取消今天的訂單)$/);
  const AF = await shop.addonFor(store.id);
  const A = AF?.date;
  const addonUrl = `${url}&m=addon`;
  // 截單後加點：補單跟原本的訂單分開，另開一張
  if (/^(補單|加點|追加|補單已送出|補單已更新|取消補單)$/.test(said)) {
    if (!A) return say({ type: 'text', text: '現在沒有可以補單的配送日。要叫貨請點「我要叫貨」；急著加點請直接留言給老闆。' });
    if (said === '取消補單') return say({ type: 'text', text: '好的，補單已取消。' });
    const o = await shop.addonSlipOf(store.id, A);
    return say(flex(said.startsWith('補單已') ? said : '補單', addonCard(store, A, o, addonUrl, AF.until)));
  }
  // 圖文選單「我要叫貨」：店家平常都直接傳訊息，所以請他直接打字（AI 整理好再給他確認），點選單選品項只留成備用
  if (!fromLiff && wantsOrder && process.env.AI_ORDER !== 'off') {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    const has = o?.items?.length ? o.items : [];
    const lines = has.slice(0, 8).map((i) => `・${i.name} ${qtyText(i.qty, i.unit)}`).join('\n') + (has.length > 8 ? `\n…共 ${has.length} 樣` : '');
    const text = has.length
      ? `${label(D)} 配送已經叫了：\n${lines}\n\n要加或改，直接打字傳過來就好，例如：\n「再加 ${SHOP.example.split(/[、,，]/)[0]}」「${has[0].name}改成 5」「${has[0].name}不要了」`
      : `要叫什麼，直接打字傳過來就好 👇\n例如：${SHOP.example}\n\n一行一樣，或用頓號隔開都可以，傳了會整理好給您確認。`;
    return say({
      type: 'text',
      text: `${text}\n${cutoffLabel(D)} 截單，${label(D)} 送到。`,
      quickReply: { items: [
        { type: 'action', action: { type: 'message', label: '📷 拍照叫貨', text: '拍照叫貨' } },
        { type: 'action', action: { type: 'message', label: '📋 我的訂單', text: '我的訂單' } },
        { type: 'action', action: { type: 'uri', label: '☰ 用清單選', uri: url } },
      ] },
    });
  }
  if (fromLiff || wantsOrder) {
    const D = openDate();
    const o = await shop.getOrder(D, store.id);
    if (said === '取消今天的訂單') return say({ type: 'text', text: '好的，這次的訂單已取消。' });
    const title = fromLiff ? (said === '訂單已更新' ? '訂單已更新' : '訂單已收到') : '叫貨單';
    // 還能補單的話，多附一張補單卡片（回覆不算訊息額度）
    if (!fromLiff && A) return say(flex('叫貨單', { type: 'carousel', contents: [orderCard(AF.mainLocked ? '已確認' : title, store, D, o, url, !AF.mainLocked), addonCard(store, A, await shop.addonSlipOf(store.id, A), addonUrl, AF.until)] }));
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
  if (action === 'aiok') { const r = await confirmDraft(uid, pb.get('id'), origin, pb.get('to') || '', pb.get('force') === '1'); return say(...(Array.isArray(r) ? r : [r])); }

  // 其他訊息不自動回覆，讓老闆在 LINE 官方帳號後台手動回
}
