// 建立 LINE 圖文選單並設成所有人的預設選單（會刪掉舊的選單）
// LINE_CHANNEL_ACCESS_TOKEN=… node scripts/richmenu/setup.mjs
import fs from 'node:fs';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) throw new Error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
const H = { Authorization: `Bearer ${token}` };
const api = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} ${r.status} ${t}`);
  return t ? JSON.parse(t) : {};
};

// 圖片 2500×1686：左邊大格 1300 寬；右上「拍照叫貨」；右下「我的訂單｜聯絡老闆」
const menu = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: '叫貨選單',
  chatBarText: '叫貨選單',
  areas: [
    { bounds: { x: 0, y: 0, width: 1300, height: 1686 }, action: { type: 'message', label: '我要叫貨', text: '我要叫貨' } },
    { bounds: { x: 1300, y: 0, width: 1200, height: 843 }, action: { type: 'message', label: '拍照叫貨', text: '拍照叫貨' } },
    { bounds: { x: 1300, y: 843, width: 600, height: 843 }, action: { type: 'message', label: '我的訂單', text: '我的訂單' } },
    { bounds: { x: 1900, y: 843, width: 600, height: 843 }, action: { type: 'message', label: '聯絡老闆', text: '聯絡老闆' } },
  ],
};

const old = (await api('https://api.line.me/v2/bot/richmenu/list')).richmenus || [];
const { richMenuId } = await api('https://api.line.me/v2/bot/richmenu', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(menu) });
await api(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/png' },
  body: fs.readFileSync(new URL('./menu.png', import.meta.url)),
});
await api(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
for (const m of old) await api(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
console.log(`圖文選單已建立並設為預設：${richMenuId}（刪除舊選單 ${old.length} 個）`);
