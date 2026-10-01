// 後台帳號與權限：用 Google 帳號登入（Firebase Authentication）
// 老闆在 OWNER_EMAILS 指定；其他人由老闆在「帳號」分頁用 Email 授權，存在 users/{email}
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { UserError } from './http.js';

export const ROLES = {
  owner: '老闆',
  accounting: '會計',
  warehouse: '理貨',
  driver: '司機',
};

// 每個角色能做的事
const CAN = {
  owner: ['*'],
  accounting: ['view', 'bills', 'prices', 'editOrders', 'deleteOrders', 'products', 'remind', 'statement', 'sign'],
  warehouse: ['view', 'editOrders', 'remind', 'sign'],
  driver: ['view', 'sign'],
};
export const can = (role, what) => !!CAN[role] && (CAN[role].includes('*') || CAN[role].includes(what));

const ownerEmails = () => (process.env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// 工程師：測試期間可以用「重置測試資料」，在 ENGINEER_EMAILS 指定，其他人看不到
const engineerEmails = () => (process.env.ENGINEER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const userDoc = (email) => getFirestore().doc('users/' + email);
const normEmail = (e) => String(e || '').trim().toLowerCase();

// 驗證登入，回傳 { email, name, role }
export async function signedIn(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!token) throw new UserError('請先登入', 401);
  let user;
  try { user = await getAuth().verifyIdToken(token); } catch { throw new UserError('登入已過期，請重新登入', 401); }
  const email = normEmail(user.email);
  if (!email || !user.email_verified) throw new UserError('這個帳號的 Email 沒有驗證，請用 Google 帳號登入', 403);
  const doc = (await userDoc(email).get()).data();
  const role = ownerEmails().includes(email) ? 'owner' : doc?.disabled ? null : doc?.role;
  if (!role) throw new UserError(`${email} 沒有後台權限，請老闆到「帳號」加入這個 Email`, 403);
  return { email, name: doc?.name || user.name || email, role, engineer: engineerEmails().includes(email) };
}

export function need(me, what) {
  if (!can(me.role, what)) throw new UserError(`「${ROLES[me.role]}」沒有這個權限`, 403);
}

/* ---------- 帳號管理（老闆） ---------- */
export async function listUsers() {
  const snap = await getFirestore().collection('users').get();
  const owners = ownerEmails();
  const list = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
  for (const e of owners) if (!list.some((u) => u.email === e)) list.push({ email: e, name: '', role: 'owner' });
  return list
    .map((u) => ({ ...u, fixed: owners.includes(u.email), role: owners.includes(u.email) ? 'owner' : u.role }))
    .sort((a, b) => Object.keys(ROLES).indexOf(a.role) - Object.keys(ROLES).indexOf(b.role));
}

export async function addUser({ email, name, role }) {
  email = normEmail(email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new UserError('Email 格式不對');
  if (!ROLES[role]) throw new UserError('請選角色');
  if (ownerEmails().includes(email)) throw new UserError('這是老闆的 Email，已經有全部權限');
  await userDoc(email).set({ name: String(name || '').trim().slice(0, 20), role, disabled: false });
  return listUsers();
}

export async function updateUser({ email, role, disabled }) {
  email = normEmail(email);
  if (ownerEmails().includes(email)) throw new UserError('老闆帳號的權限是固定的（在 OWNER_EMAILS 設定）');
  const ref = userDoc(email);
  if (!(await ref.get()).exists) throw new UserError('找不到這個帳號', 404);
  const patch = {};
  if (role !== undefined) { if (!ROLES[role]) throw new UserError('角色不正確'); patch.role = role; }
  if (disabled !== undefined) patch.disabled = !!disabled;
  await ref.update(patch);
  return listUsers();
}

export async function removeUser({ email }) {
  email = normEmail(email);
  if (ownerEmails().includes(email)) throw new UserError('老闆帳號不能刪除（在 OWNER_EMAILS 設定）');
  await userDoc(email).delete();
  return listUsers();
}
