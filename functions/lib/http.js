export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export function fail(e) {
  if (e instanceof UserError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: '系統忙碌，請稍後再試' }, 500);
}

export const originOf = (request) =>
  process.env.BASE_URL?.replace(/\/$/, '') || new URL(request.url).origin;

export async function readJSON(request) {
  try { return await request.json(); } catch { throw new UserError('資料格式錯誤'); }
}
