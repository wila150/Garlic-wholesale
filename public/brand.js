// 品牌：店名、標誌（蒜頭／葉子）、配色。同一份程式給不同的店用，打開頁面時跟後端拿這家店的設定
(() => {
  const LOGOS = {
    garlic: '<svg viewBox="0 0 32 32"><path d="M16 2.5c1.3 2.4 1.2 4.7.3 6.6C22 10.4 27.5 14.7 27.5 20.6c0 5.6-5.1 8.9-11.5 8.9S4.5 26.2 4.5 20.6c0-5.9 5.5-10.2 11.2-11.5-.9-1.9-1-4.2.3-6.6z" fill="currentColor"/><path d="M16 11.5c-2.6 2.9-3.6 6.1-3.6 9.3 0 3 1.1 5.5 3.6 7.4m0-16.7c2.6 2.9 3.6 6.1 3.6 9.3 0 3-1.1 5.5-3.6 7.4" stroke="#1F4D3A" stroke-opacity=".55" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>',
    leaf: '<svg viewBox="0 0 32 32"><path d="M26.5 4.5C14 4.5 5.5 11 5.5 20.5c0 2.6.8 4.9 2.1 6.7C10 16.6 17.5 11.9 22 10.5 16 14 11.5 19.5 9.3 28.6c1.9 1 4.1 1.4 6.4 1.4 9.6 0 13.9-9.3 10.8-25.5z" fill="currentColor"/></svg>',
  };
  window.applyBrand = (b) => {
    if (!b) return;
    if (b.logo && LOGOS[b.logo]) document.querySelectorAll('.logo').forEach((el) => { el.innerHTML = LOGOS[b.logo]; });
    if (b.name) document.querySelectorAll('[data-shopname]').forEach((el) => { el.textContent = b.name; });
    // 分頁小圖示、加到手機主畫面的圖示和名稱
    if (b.logo && LOGOS[b.logo]) for (const rel of ['icon', 'apple-touch-icon']) {
      let l = document.querySelector(`link[rel="${rel}"]`);
      if (!l) { l = document.createElement('link'); l.rel = rel; document.head.appendChild(l); }
      l.href = `/icon-${b.logo}.png`;
    }
    if (b.name) {
      let m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
      if (!m) { m = document.createElement('meta'); m.name = 'apple-mobile-web-app-title'; document.head.appendChild(m); }
      m.content = b.name;
    }
    if (b.palette) { document.documentElement.dataset.palette = b.palette; try { localStorage.setItem('palette', b.palette); } catch {} }
    try { localStorage.setItem('brand', JSON.stringify({ logo: b.logo, name: b.name })); } catch {}
  };
  // 先用上次存的，避免閃一下蒜頭再變葉子
  try { const c = JSON.parse(localStorage.getItem('brand') || 'null'); if (c) document.addEventListener('DOMContentLoaded', () => window.applyBrand(c)); } catch {}
  // 不用登入的頁面（登入頁、說明書）自己拿
  if (document.currentScript?.dataset.fetch) fetch('/api/info').then((r) => r.json()).then((b) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.applyBrand(b)); else window.applyBrand(b); }).catch(() => {});
})();
