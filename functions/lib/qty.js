// 數量顯示：單位是「斤」時用台斤／兩（1 斤 = 16 兩），其他單位顯示小數
// public/index.html 和 public/admin.html 各有一份一樣的 qtyText，改這裡要一起改
export function qtyText(q, unit) {
  q = Number(q) || 0;
  if (unit === '斤' && !Number.isInteger(q)) {
    let jin = Math.floor(q);
    let liang = Math.round((q - jin) * 16);
    if (liang === 16) { jin++; liang = 0; }
    if (Math.abs(jin + liang / 16 - q) < 0.001) return `${jin ? jin + '斤' : ''}${liang ? liang + '兩' : ''}` || '0斤';
  }
  return `${Number.isInteger(q) ? q : +q.toFixed(2)} ${unit}`;
}

// 數量存到小數第 4 位（1 兩 = 0.0625 斤）
export const roundQty = (q) => Math.round(Number(q) * 10000) / 10000;

// 分裝方式：店家交代一包裝多少，例如「1斤+4兩+3兩」「半斤×2+3包」（沒寫份量的「3包」是一包 1 個單位）
// 回傳 [{ q: 每包份量（品項的單位）, n: 包數 }]，看不懂回傳 null；public/admin.html 有一份一樣的，改這裡要一起改
const BAG_JIN = { 斤: 1, 台斤: 1, 兩: 1 / 16, 公斤: 1 / 0.6 };
function bagAmount(s, unit) {
  s = s.replace(/半斤/g, '0.5斤').replace(/半/g, '0.5');
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const m = s.match(/^(?:(\d+(?:\.\d+)?)(斤|台斤|公斤))?(?:(\d+(?:\.\d+)?)兩)?$/);
  if (m && (m[1] || m[3])) {
    const jin = (m[1] ? +m[1] * BAG_JIN[m[2]] : 0) + (m[3] ? +m[3] / 16 : 0);
    return BAG_JIN[unit] ? jin / BAG_JIN[unit] : null;
  }
  const u = s.match(/^(\d+(?:\.\d+)?)(\S+)$/);
  return u && u[2] === unit ? +u[1] : null;
}
export function parseBags(text, unit) {
  const out = [];
  for (let t of String(text ?? '').replace(/\s+/g, '').replace(/[＋、,，]/g, '+').split('+')) {
    if (!t) continue;
    let n = 1, m;
    if ((m = t.match(/^(.+?)[×xX*＊](\d+)(包|袋)?$/))) { t = m[1]; n = +m[2]; }
    else if ((m = t.match(/^(\d+)(包|袋)$/))) { t = '1'; n = +m[1]; }
    const q = bagAmount(t, unit);
    if (!(q > 0) || !(n > 0 && n < 1000)) return null;
    const same = out.find((b) => Math.abs(b.q - q) < 1e-6);
    if (same) same.n += n; else out.push({ q: roundQty(q), n });
  }
  return out.length ? out : null;
}
export const bagsTotal = (bags) => roundQty((bags || []).reduce((a, b) => a + b.q * b.n, 0));
const bagQ = (q, unit) => (unit === '斤' && q === 0.5 ? '半斤' : qtyText(q, unit).replace(' ', ''));
export const bagsText = (bags, unit) => (bags || []).map((b) => `${bagQ(b.q, unit)}${b.n > 1 ? `×${b.n}` : ''}`).join('+');

// 分裝方式要剛好等於叫的量才算數（對不上就當作沒交代，免得照錯的裝）
export function bagsOf(v, unit, qty) {
  const b = Array.isArray(v) ? v.filter((x) => x?.q > 0 && x?.n > 0).map((x) => ({ q: roundQty(x.q), n: Math.floor(x.n) })) : parseBags(v, unit);
  return b?.length && Math.abs(bagsTotal(b) - qty) < 0.001 && !(b.length === 1 && b[0].n === 1) ? b : null;
}
