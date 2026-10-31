// 從 ERP 匯入品項：讀「貨品編號名稱對照表」（ERP 匯出的 .txt，Big5 由瀏覽器先轉成文字）
//   品項上記 erp: { 單位: 貨品編號 }，例如蒜頭 { 斤: 'AA1', 公斤: 'AA1Aa' }，之後匯出給 ERP 用
//   「蒜頭1(公斤)」這種同一樣東西用公斤賣的編號，併到「蒜頭1」底下，不另開一個品項
import { getFirestore } from 'firebase-admin/firestore';
import { getProducts, getUnits, getCategories } from './shop.js';
import { UserError } from './http.js';
import { UNITS_VERSION } from './config.js';

const db = () => getFirestore();
const UNIT = { 台斤: '斤' };
const KG = /\(公斤\)$/;
const baseName = (n) => n.replace(KG, '').replace(/1$/, '');
const rid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 一行一個貨品：類別編號 類別名稱 貨品編號 貨品名稱 [規格] 計稅 課稅別（有的貨品沒有類別）
export function parseErp(text) {
  const rows = [];
  let lastCat = '';
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4 || !/稅$/.test(t.at(-1)) || !/^[YN]$/.test(t.at(-2))) continue;
    const b = t.slice(0, -2);
    const withCat = b.length >= 4 || (b.length === 3 && /類$/.test(b[1]));
    const [cat, code, name, spec] = withCat ? [b[1], b[2], b[3], b[4]] : ['', b[0], b[1], b[2]];
    if (!code || !name) continue;
    if (cat) lastCat = cat;
    rows.push({ cat, fileCat: lastCat, code, name, spec: spec || '' });
  }
  if (!rows.length) throw new UserError('看不到貨品，請選 ERP 匯出的「貨品編號名稱對照表」');
  return rows;
}

// 算出匯入後的品項清單；dry＝只看會改什麼。不動單價；offOthers＝ERP 沒有的品項下架；
// dropOld＝只留 ERP 的：ERP 沒有的品項和原本的分類一起刪掉
export async function importErp(text, { dry = true, offOthers = false, dropOld = false } = {}) {
  const rows = parseErp(text);
  const [products, units, cats] = await Promise.all([getProducts(), getUnits(), getCategories()]);
  const list = structuredClone(products);
  const byCode = new Map(), byName = new Map(list.map((p) => [p.name, p]));
  for (const p of list) for (const c of Object.values(p.erp || {})) byCode.set(c, p);
  const touched = new Set(), added = [], updated = [], newUnits = [], newCats = [];
  const need = (arr, have, x) => { if (x && !have.includes(x) && !arr.includes(x)) arr.push(x); };
  const mark = (p, isNew) => { if (!touched.has(p.id)) { touched.add(p.id); (isNew ? added : updated).push(p.name); } };

  // 先放一般品項，再把「(公斤)」併到同名品項底下
  const kg = rows.filter((r) => KG.test(r.name)), main = rows.filter((r) => !KG.test(r.name));
  for (const r of main) {
    const unit = UNIT[r.spec] || r.spec || '斤', cat = r.cat || r.fileCat;
    need(newUnits, units, unit); need(newCats, cats, cat);
    let p = byCode.get(r.code) || byName.get(r.name);
    const isNew = !p;
    if (!p) { p = { id: rid(), name: r.name, cat, unit, on: true, price: 0, cost: null, priceDate: '', alias: [], packs: [], liang: true }; list.push(p); byName.set(p.name, p); }
    else { p.cat = cat; if (!p.erp?.[p.unit]) p.unit = unit; }
    p.erp = { ...p.erp, [p.unit]: r.code };
    byCode.set(r.code, p);
    mark(p, isNew);
  }
  for (const r of kg) {
    const cat = r.cat || r.fileCat, b = baseName(r.name);
    // 同分類、名字一樣（不算後面的 1）而且還沒有公斤編號的；沒有類別的貨品（例如 C001）就不限分類
    const cand = list.filter((p) => baseName(p.name) === b && p.erp && !p.erp['公斤'] && p.unit !== '公斤');
    let p = byCode.get(r.code) || cand.find((x) => x.cat === cat) || (!r.cat && cand[0]);
    const isNew = !p;
    if (!p) {
      need(newUnits, units, '公斤'); need(newCats, cats, cat);
      p = { id: rid(), name: r.name, cat, unit: '公斤', on: true, price: 0, cost: null, priceDate: '', alias: [], packs: [], liang: true };
      list.push(p);
    }
    p.erp = { ...p.erp, 公斤: r.code };
    byCode.set(r.code, p);
    mark(p, isNew);
  }
  const others = list.filter((p) => !touched.has(p.id));
  const erpCats = [...new Set(rows.map((r) => r.cat || r.fileCat).filter(Boolean))];
  const oldCats = cats.filter((c) => !erpCats.includes(c));
  const off = !dropOld && offOthers ? others.filter((p) => p.on).map((p) => p.name) : [];
  for (const p of list) if (off.includes(p.name)) p.on = false;
  const items = dropOld ? list.filter((p) => touched.has(p.id)) : list;
  const catList = dropOld ? erpCats : [...cats, ...newCats];
  const res = { count: rows.length, added, updated, off, newUnits, newCats, others: others.map((p) => p.name), oldCats, removed: dropOld ? others.map((p) => p.name) : [] };
  if (dry) return res;
  // 單位、分類一起補上，品項才不會被存成第一個單位或分類
  await db().runTransaction(async (tx) => {
    if (newUnits.length) tx.set(db().doc('settings/units'), { items: [...units, ...newUnits], v: UNITS_VERSION });
    if (newCats.length || dropOld) tx.set(db().doc('settings/categories'), { items: catList });
    tx.set(db().doc('settings/products'), { items });
  });
  return { ...res, products: items };
}
