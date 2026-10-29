// 建立 LINE 圖文選單（會刪掉舊的選單）：
//   店家選單：所有人的預設（我要叫貨、拍照叫貨、我的訂單、聯絡老闆）
//   老闆選單：只套用在 ADMIN_LINE_USER_IDS（記帳、還要買、本月支出、開後台、店家模式）
// 先產生圖片：node scripts/richmenu/render.mjs veg
// 再建立：LINE_CHANNEL_ACCESS_TOKEN=… node scripts/richmenu/setup.mjs caihang-order
//   （第二個參數是 Firebase 專案，用來讀 functions/.env.<專案> 的 BASE_URL、ADMIN_LINE_USER_IDS）
import fs from 'node:fs';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) throw new Error('請設定 LINE_CHANNEL_ACCESS_TOKEN');
const project = process.argv[2];
if (!project) throw new Error('請指定 Firebase 專案，例如 node scripts/richmenu/setup.mjs caihang-order');
const env = Object.fromEntries(fs.readFileSync(new URL(`../../functions/.env.${project}`, import.meta.url), 'utf8')
  .split('\n').map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const base = env.BASE_URL || `https://${project}.web.app`;
const admins = (env.ADMIN_LINE_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const H = { Authorization: `Bearer ${token}` };
const api = async (url, opt = {}) => {
  const r = await fetch(url, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${url} ${r.status} ${t}`);
  return t ? JSON.parse(t) : {};
};
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// 圖片 2500×1686：左邊大格 1300 寬；右邊上下兩列，每列 600 寬兩格
const L = { x: 0, y: 0, width: 1300, height: 1686 };
const TR = { x: 1300, y: 0, width: 1200, height: 843 };
const cell = (col, row) => ({ x: 1300 + col * 600, y: row * 843, width: 600, height: 843 });
const msg = (text) => ({ type: 'message', label: text, text });

const menus = {
  store: {
    size: { width: 2500, height: 1686 }, selected: true, name: '店家選單', chatBarText: '叫貨選單',
    areas: [
      { bounds: L, action: msg('我要叫貨') },
      { bounds: TR, action: msg('拍照叫貨') },
      { bounds: cell(0, 1), action: msg('我的訂單') },
      { bounds: cell(1, 1), action: msg('聯絡老闆') },
    ],
  },
  boss: {
    size: { width: 2500, height: 1686 }, selected: true, name: '老闆選單', chatBarText: '老闆選單',
    areas: [
      { bounds: L, action: msg('記帳') },
      { bounds: cell(0, 0), action: msg('還要買') },
      { bounds: cell(1, 0), action: msg('本月支出') },
      { bounds: cell(0, 1), action: { type: 'uri', label: '開後台', uri: `${base}/admin` } },
      // 切到店家選單測試叫貨；要切回來打「老闆選單」
      { bounds: cell(1, 1), action: { type: 'richmenuswitch', label: '店家模式', richMenuAliasId: 'store', data: 'action=menu&to=store' } },
    ],
  },
};

const old = (await api('https://api.line.me/v2/bot/richmenu/list')).richmenus || [];
const oldAliases = (await api('https://api.line.me/v2/bot/richmenu/alias/list')).aliases || [];
const ids = {};
for (const [k, menu] of Object.entries(menus)) {
  const { richMenuId } = await api('https://api.line.me/v2/bot/richmenu', json(menu));
  await api(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: fs.readFileSync(new URL(`./menu-${k}.png`, import.meta.url)),
  });
  ids[k] = richMenuId;
}
// 別名：richmenuswitch 和 webhook 的「老闆選單」靠這個找到選單
for (const k of Object.keys(ids)) {
  if (oldAliases.some((a) => a.richMenuAliasId === k)) await api(`https://api.line.me/v2/bot/richmenu/alias/${k}`, json({ richMenuId: ids[k] }));
  else await api('https://api.line.me/v2/bot/richmenu/alias', json({ richMenuAliasId: k, richMenuId: ids[k] }));
}
await api(`https://api.line.me/v2/bot/user/all/richmenu/${ids.store}`, { method: 'POST' });
if (admins.length) await api('https://api.line.me/v2/bot/richmenu/bulk/link', json({ richMenuId: ids.boss, userIds: admins }));
for (const m of old) await api(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, { method: 'DELETE' });
console.log(`店家選單（預設）：${ids.store}\n老闆選單：${ids.boss}，套用到 ${admins.length} 個老闆 LINE\n刪除舊選單 ${old.length} 個`);
