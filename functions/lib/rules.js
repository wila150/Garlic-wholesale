// 營業規則（後台「設定」可以改）：截單時間、公休日、店家自己補單
//   settings/rules { cutoff: '22:00', closed: [0], addon: true, addonUntil: '12:00' }
// 每個請求開頭呼叫 loadRules()，讀到的規則套進 dates.js（快取 30 秒）
import { getFirestore } from 'firebase-admin/firestore';
import { CUTOFF_HOUR, CLOSED_WEEKDAYS } from './config.js';
import { setRules, getRulesNow } from './dates.js';
import { UserError } from './http.js';

export const DEFAULT_RULES = {
  cutoff: `${String(CUTOFF_HOUR).padStart(2, '0')}:00`, // 配送日前一天幾點截單
  closed: CLOSED_WEEKDAYS, // 不配送的星期幾（0＝週日）
  addon: true, // 截單後店家可以自己補單
  addonUntil: '12:00', // 配送當天幾點前可以補單
};

let cachedAt = 0;
export async function loadRules() {
  if (Date.now() - cachedAt < 30e3) return getRulesNow();
  const saved = (await getFirestore().doc('settings/rules').get()).data() || {};
  setRules({ ...DEFAULT_RULES, ...saved });
  cachedAt = Date.now();
  return getRulesNow();
}

const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export async function saveRules(input) {
  const r = {
    cutoff: String(input.cutoff || ''),
    closed: [...new Set((Array.isArray(input.closed) ? input.closed : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort(),
    addon: !!input.addon,
    addonUntil: String(input.addonUntil || ''),
  };
  if (!isTime(r.cutoff)) throw new UserError('截單時間格式不對，例如 22:00');
  if (!isTime(r.addonUntil)) throw new UserError('補單截止時間格式不對，例如 12:00');
  if (r.closed.length === 7) throw new UserError('不能每天都公休');
  await getFirestore().doc('settings/rules').set(r);
  setRules(r);
  cachedAt = Date.now();
  return r;
}
