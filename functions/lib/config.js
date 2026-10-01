// 商店設定。品項、價格、店家在後台改；這裡的設定改完要重新部署。

export const SHOP = {
  name: process.env.SHOP_NAME || '蒜頭行',
  phone: process.env.SHOP_PHONE || '',
  payTerms: process.env.PAY_TERMS || '款項月結，每月 10 日前付清上月貨款。',
  lineUrl: process.env.LINE_ADD_FRIEND_URL || '',
  // 官方帳號 ID（@開頭），從加好友網址取出，用來做「回傳給老闆」的聊天室連結
  basicId: (process.env.LINE_ADD_FRIEND_URL || '').match(/@[\w.-]+/)?.[0] || '',
  liffId: process.env.LIFF_ID || '',
};

// 截單時間：配送日前一天的幾點（24 小時制）
export const CUTOFF_HOUR = Number(process.env.CUTOFF_HOUR || 22);
// 不配送的星期幾，0＝週日，例如 "0" 或 "0,3"
export const CLOSED_WEEKDAYS = (process.env.CLOSED_WEEKDAYS || '').split(',').filter((s) => s.trim() !== '').map(Number);

export const CATEGORIES = ['蒜頭', '蒜仁蒜末', '其他辛香', '加工品'];
// 預設單位，之後在後台「品項」可以自己新增、刪除
// 斤＝台斤（600g，可以叫幾斤幾兩）；件／箱／籃／袋／綑／紮／簍是批發市場常用的包裝單位
export const DEFAULT_UNITS = ['斤', '兩', '公斤', '件', '箱', '籃', '袋', '包', '綑', '紮', '簍', '盒', '罐', '把', '顆'];
// 後來才加進預設的單位：已經存過單位清單的，第一次讀取時自動補上一次（之後刪掉就不會再補）
export const UNITS_VERSION = 2;
export const UNITS_ADDED = { 2: ['件', '籃', '綑', '紮', '簍'] };

// 第一次啟動時寫入的品項（價格是示範用），之後在後台「品項」修改
export const DEFAULT_PRODUCTS = [
  ['蒜頭', '雲林蒜頭（大）', '斤', 120],
  ['蒜頭', '雲林蒜頭（中）', '斤', 100],
  ['蒜頭', '雲林蒜頭 整箱 20 斤', '箱', 1900],
  ['蒜頭', '進口蒜頭', '斤', 70],
  ['蒜仁蒜末', '蒜仁', '斤', 150],
  ['蒜仁蒜末', '蒜仁 真空 1 斤', '包', 160],
  ['蒜仁蒜末', '蒜末', '斤', 160],
  ['蒜仁蒜末', '蒜泥', '包', 90],
  ['其他辛香', '紅蔥頭', '斤', 110],
  ['其他辛香', '蒜苗', '斤', 80],
  ['其他辛香', '老薑', '斤', 60],
  ['其他辛香', '辣椒', '斤', 90],
  ['加工品', '油蔥酥', '斤', 260],
  ['加工品', '蒜酥', '斤', 300],
  ['加工品', '黑蒜', '包', 380],
].map(([cat, name, unit, price], i) => ({ id: 'p' + (i + 1), cat, name, unit, price, on: true }));
