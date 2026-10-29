// 產生圖文選單圖片（2500×1686）：node scripts/richmenu/render.mjs [garlic|veg]（需要 puppeteer-core 和 Chrome）
//   menu-store.png 店家選單（所有人預設）、menu-boss.png 老闆選單
import puppeteer from 'puppeteer-core';
const kind = process.argv[2] === 'veg' ? 'veg' : 'garlic';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
await p.setViewport({ width: 2500, height: 1686 });
for (const m of ['store', 'boss']) {
  const url = new URL('./menu.html', import.meta.url);
  url.search = `?m=${m}&kind=${kind}`;
  await p.goto(url.href, { waitUntil: 'networkidle0' });
  await p.screenshot({ path: new URL(`./menu-${m}.png`, import.meta.url).pathname.replace(/%20/g, ' ') });
}
await b.close();
console.log(`已產生 menu-store.png、menu-boss.png（${kind}）`);
