// 產生圖文選單圖片（2500×1686）：node scripts/richmenu/render.mjs（需要 puppeteer-core 和 Chrome）
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
await p.setViewport({ width: 2500, height: 1686 });
await p.goto(new URL('./menu.html', import.meta.url).href, { waitUntil: 'networkidle0' });
await p.screenshot({ path: new URL('./menu.png', import.meta.url).pathname.replace(/%20/g, ' ') });
await b.close();
