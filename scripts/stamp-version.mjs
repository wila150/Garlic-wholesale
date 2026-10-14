// 部署前自動更新後台版本號：月日＋當天第幾版，例如 10/15 第 2 版＝101502
// firebase.json 的 hosting.predeploy 會跑這支
import fs from 'node:fs';

const file = new URL('../public/admin.html', import.meta.url);
const html = fs.readFileSync(file, 'utf8');
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 10).replace('-', ''); // 台灣時間 MMDD
const cur = html.match(/<small class="ver">版本 ([^<]*)<\/small>/)?.[1] || '';
const n = cur.startsWith(today) && /^\d{6}$/.test(cur) ? Number(cur.slice(4)) + 1 : 1;
const next = today + String(n).padStart(2, '0');
fs.writeFileSync(file, html.replace(/<small class="ver">版本 [^<]*<\/small>/, `<small class="ver">版本 ${next}</small>`));
console.log('後台版本', cur, '→', next);
