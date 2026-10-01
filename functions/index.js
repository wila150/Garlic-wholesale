// Cloud Functions 進入點：所有 /api/* 都進到這裡
//   /api/webhook  LINE webhook
//   /api/shop     店家叫貨頁
//   /api/admin    後台
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import * as webhook from './api/webhook.js';
import * as shop from './api/shop.js';
import * as admin from './api/admin.js';

initializeApp();
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 });

// 金鑰放在 Secret Manager：firebase functions:secrets:set LINE_CHANNEL_SECRET
const secrets = [defineSecret('LINE_CHANNEL_SECRET'), defineSecret('LINE_CHANNEL_ACCESS_TOKEN')];
const routes = { webhook, shop, admin };

export const api = onRequest({ secrets, cors: false }, async (req, res) => {
  const name = req.path.replace(/^\/api\//, '').replace(/^\//, '').split('/')[0];
  const fn = routes[name]?.[req.method];
  if (!fn) return res.status(404).send('Not found');

  // 轉成標準的 Request，api/*.js 就不用管是跑在哪個平台
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  const request = new Request(`${proto}://${host}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.rawBody,
  });

  const r = await fn(request);
  r.headers.forEach((v, k) => res.set(k, v));
  res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
});
