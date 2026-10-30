// 產生圖文選單圖片（2500×1686）：node scripts/richmenu/render.mjs [garlic|veg]（需要 puppeteer-core 和 Chrome）
//   menu-store.jpg 店家選單（所有人預設）、menu-boss.jpg 老闆選單（JPG：LINE 圖文選單圖片上限 1MB，漸層存 PNG 會太大）
import puppeteer from 'puppeteer-core';
const kind = process.argv[2] === 'veg' ? 'veg' : 'garlic';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
await p.setViewport({ width: 2500, height: 1686 });
for (const m of ['store', 'boss']) {
  const url = new URL('./menu.html', import.meta.url);
  url.search = `?m=${m}&kind=${kind}`;
  await p.goto(url.href, { waitUntil: 'networkidle0' });
  await p.evaluateHandle('document.fonts.ready');
  await p.screenshot({ type: 'jpeg', quality: 88, path: decodeURIComponent(new URL(`./menu-${m}.jpg`, import.meta.url).pathname) });
}
await b.close();
console.log(`已產生 menu-store.jpg、menu-boss.jpg（${kind}）`);
