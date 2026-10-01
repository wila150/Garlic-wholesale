// 本機測試用：產生叫貨連結，不用透過 LINE
// npm run link -- 1        → 示範資料第 1 家店
// npm run link -- Uxxxx    → 指定 LINE userId
import fs from 'node:fs';
import { sign } from '../functions/lib/token.js';

// 和模擬器用同一個 LINE_CHANNEL_SECRET，簽出來的連結才會通過
const secret = fs.readFileSync(new URL('../functions/.secret.local', import.meta.url), 'utf8').match(/^LINE_CHANNEL_SECRET=(.*)$/m)?.[1];
if (secret) process.env.LINE_CHANNEL_SECRET = secret;
const a = process.argv[2] || '1';
const uid = a.startsWith('U') ? a : `Utest${String(a).padStart(28, '0')}`;
console.log(`http://localhost:5050/?t=${sign(uid)}`);
