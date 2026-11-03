// LINE 收集模式（.env 設 LINE_COLLECT=on）：剛接上新的 LINE 官方帳號、還不開放叫貨時用
// - 只記下誰傳了訊息（userId、LINE 名稱）和傳了什麼（文字、照片），機器人不回覆、不推圖文選單
// - 客人照樣在 LINE 官方帳號後台（chat.line.biz）跟老闆聊天，老闆手動回
//   lineContacts/{userId}  { userId, name, firstAt, lastAt, count, last, followed }
//   lineInbox/{事件 id}     { uid, name, type, text, img, at }（照片另外存 lineInboxImg/{訊息 id}）
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { displayName, getContent } from './line.js';

const db = () => getFirestore();
export const collecting = () => process.env.LINE_COLLECT === 'on';
const IMG_MAX = 900 * 1024; // Firestore 一份文件上限 1MB，base64 後要留空間

function describe(e) {
  if (e.type === 'follow') return { type: 'follow', text: '（加入好友）' };
  if (e.type === 'unfollow') return { type: 'unfollow', text: '（封鎖／刪除好友）' };
  if (e.type === 'postback') return { type: 'postback', text: e.postback?.data || '' };
  if (e.type !== 'message') return null;
  const m = e.message;
  const text = { text: m.text, sticker: '（貼圖）', image: '（照片）', video: '（影片）', audio: '（語音）', file: `（檔案）${m.fileName || ''}`, location: `（位置）${m.address || m.title || ''}` }[m.type];
  return { type: m.type, text: String(text ?? `（${m.type}）`).slice(0, 2000) };
}

export async function collect(e) {
  const uid = e.source.userId;
  const d = describe(e);
  if (!d) return;
  const id = e.webhookEventId || `${uid}_${e.timestamp}`;
  const at = new Date(e.timestamp || Date.now()).toISOString();
  const ref = db().doc('lineContacts/' + uid);
  const old = (await ref.get()).data();
  const name = old?.name || (await displayName(uid).catch(() => '')) || '';
  let img = '';
  if (d.type === 'image') {
    try {
      const buf = await getContent(e.message.id);
      if (buf.length <= IMG_MAX) {
        await db().doc('lineInboxImg/' + e.message.id).set({ data: buf.toString('base64'), at });
        img = e.message.id;
      } else d.text = '（照片太大沒有存，請到 LINE 官方帳號後台看）';
    } catch (err) {
      console.error('收集照片失敗', err.message);
    }
  }
  // LINE 重送同一個事件時不要重複記
  try {
    await db().doc('lineInbox/' + id).create({ uid, name, ...d, img, at });
  } catch (err) {
    if (err.code === 6) return; // ALREADY_EXISTS
    throw err;
  }
  const msg = d.type !== 'follow' && d.type !== 'unfollow';
  await ref.set({
    userId: uid,
    name,
    firstAt: old?.firstAt || at,
    lastAt: at,
    count: FieldValue.increment(msg ? 1 : 0),
    last: msg ? d.text.slice(0, 60) : old?.last || '',
    followed: d.type === 'unfollow' ? false : d.type === 'follow' ? true : old?.followed ?? true,
  }, { merge: true });
}

export async function listContacts() {
  const snap = await db().collection('lineContacts').orderBy('lastAt', 'desc').limit(1000).get();
  return snap.docs.map((x) => x.data());
}

// 一位客人的訊息（舊的在前）；不用複合索引，取回來再排
export async function messagesOf(uid) {
  const snap = await db().collection('lineInbox').where('uid', '==', uid).limit(500).get();
  return snap.docs.map((x) => x.data()).sort((a, b) => a.at.localeCompare(b.at));
}

export async function imageOf(id) {
  return (await db().doc('lineInboxImg/' + id).get()).data()?.data || null;
}
