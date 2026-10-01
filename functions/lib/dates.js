// 日期一律用台灣時間，格式 YYYY-MM-DD
import { CUTOFF_HOUR, CLOSED_WEEKDAYS } from './config.js';

const TZ = 8 * 3600e3;
const ymd = (d) => d.toISOString().slice(0, 10);

export const today = () => ymd(new Date(Date.now() + TZ));
export const thisMonth = () => today().slice(0, 7);
export const addDays = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
export const weekday = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
export const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// 配送日 D 的截單時刻：D 前一天的 CUTOFF_HOUR 點
export const cutoffOf = (D) => Date.parse(addDays(D, -1) + 'T00:00:00Z') + CUTOFF_HOUR * 3600e3 - TZ;
export const isOpen = (D) => Date.now() < cutoffOf(D);

// 現在可以叫貨的配送日
export function openDate() {
  let D = addDays(today(), 1);
  for (let i = 0; i < 14; i++) {
    if (!CLOSED_WEEKDAYS.includes(weekday(D)) && isOpen(D)) return D;
    D = addDays(D, 1);
  }
  return D;
}

const WD = '日一二三四五六';
export const md = (D) => `${+D.slice(5, 7)}/${+D.slice(8, 10)}`;
export const label = (D) => `${md(D)}（${WD[weekday(D)]}）`;
export const cutoffLabel = (D) => {
  const c = addDays(D, -1);
  return `${c === today() ? '今晚' : md(c)} ${CUTOFF_HOUR}:00`;
};
