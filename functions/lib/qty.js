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
