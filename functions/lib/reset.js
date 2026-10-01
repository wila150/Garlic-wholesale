// 重置測試資料（只有工程師能用）：清掉訂單和帳務，保留品項、店家、LINE 綁定、帳號和設定
import { getFirestore } from 'firebase-admin/firestore';

export const RESET_COLLECTIONS = ['orders', 'signatures', 'monthly', 'paid', 'dayPrices', 'costs', 'aiDrafts', 'aiJobs'];

export async function resetTestData() {
  const db = getFirestore();
  const deleted = {};
  for (const name of RESET_COLLECTIONS) {
    const ref = db.collection(name);
    deleted[name] = (await ref.count().get()).data().count;
    await db.recursiveDelete(ref);
  }
  return deleted;
}
