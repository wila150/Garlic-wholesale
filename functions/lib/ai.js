// AI 辨識叫貨：把店家在 LINE 打的字或手寫單照片，對應到品項清單
// 用 NVIDIA（build.nvidia.com）的 OpenAI 相容 API；要換模型或服務，改 AI_MODEL／AI_BASE_URL 就好
import { roundQty } from './qty.js';

const BASE = process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.AI_MODEL || 'z-ai/glm-5.3-flash';

// 看起來像在叫貨：有數字，或「三斤」「半包」這種說法
export const looksLikeOrder = (text) =>
  text.length <= 400 && (/\d/.test(text) || /[一二兩三四五六七八九十半][\s]*(斤|兩|包|箱|袋|盒|公斤|把|顆|罐|件|籃|綑|紮|簍)/.test(text));

function systemPrompt(products) {
  const catalog = products.map((p) => `${p.id}｜${p.name}｜${p.unit}${p.alias ? `｜也寫作：${p.alias}` : ''}`).join('\n');
  return `你是台灣蒜頭批發行的叫貨助理。把客人（餐廳、小吃店）傳來的叫貨內容，對應到下面的品項清單，只輸出 JSON，不要任何解釋。

品項清單（編號｜品名｜單位｜客人常見的其他寫法）：
${catalog}

規則：
- 台灣慣用說法：「去皮」「蒜仁」是蒜仁；「大蒜」「蒜頭」沒說大小就用清單裡第一個蒜頭；「半斤」＝0.5 斤；1 斤＝16 兩，例如「一斤二兩」＝1.125 斤。「斤」「台斤」是同一個（600 公克）；1 公斤＝1000 公克＝約 1.667 台斤，清單單位是斤、客人寫公斤時要換算（例如 3 公斤＝5 斤），清單單位是公斤、客人寫斤時反過來換算。
- 數量沒寫單位時，用該品項的單位。客人寫的單位和清單不同時（例如清單是「包」客人寫「斤」），照清單單位換算不了就放進 unknown。
- 對不到清單的品項放進 unknown，保留客人原本的寫法，不要硬塞到相近的品項。
- 照片：先把每一行字照原樣抄到 lines（看不清楚的字用 ? 代替），再一行一行對應品項。手寫的「斤」常寫成「斤」「f」「厂」，「包」常寫成「包」「勹」「ㄅ」，阿拉伯數字和國字都要認。
- 照片裡的日期、店名、電話不是品項，不要放進 items 或 unknown。
- note 放客人的其他交代（例如送貨時間），沒有就留空字串。

輸出格式：{"lines":["大蒜3","香菜兩把"],"items":[{"pid":"p1","qty":3,"raw":"大蒜3"}],"unknown":["香菜兩把"],"note":""}（打字叫貨時 lines 可以是空陣列）`;
}

// text 或 image（data:image/jpeg;base64,…）擇一
export async function parseOrder({ text, image, products }) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('尚未設定 NVIDIA_API_KEY');
  const on = products.filter((p) => p.on);
  const user = image
    ? [{ type: 'text', text: '這是客人的手寫叫貨單照片，請整理成 JSON。' }, { type: 'image_url', image_url: { url: image } }]
    : text;
  // AI 偶爾回空白或格式跑掉，再試一次
  let j, lastErr;
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(image ? 55000 : 30000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: systemPrompt(on) }, { role: 'user', content: user }],
        temperature: 0,
        max_tokens: 2000,
      }),
    });
    // 金鑰失效、額度用完這種錯，重試也沒用
    if (r.status === 401 || r.status === 403) throw new Error(`AI 金鑰被拒絕（${r.status}）：請到 build.nvidia.com 換新的 API key`);
    if (!r.ok) { lastErr = new Error(`AI ${r.status}: ${(await r.text()).slice(0, 200)}`); continue; }
    const out = (await r.json()).choices?.[0]?.message?.content || '';
    const m = out.match(/\{[\s\S]*\}/);
    try { if (m) j = JSON.parse(m[0]); } catch {}
    if (!j) lastErr = new Error('AI 沒有回傳 JSON：' + out.slice(0, 200));
  }
  if (!j) throw lastErr;

  // 只收清單裡、有上架的品項，同一品項合併
  const pm = new Map(on.map((p) => [p.id, p]));
  const items = [];
  for (const it of Array.isArray(j.items) ? j.items : []) {
    const p = pm.get(it?.pid);
    const qty = roundQty(it?.qty);
    if (!p || !(qty > 0) || qty > 999) { if (it?.raw) (j.unknown ||= []).push(String(it.raw)); continue; }
    const same = items.find((x) => x.pid === p.id);
    if (same) same.qty = roundQty(same.qty + qty);
    else items.push({ pid: p.id, name: p.name, unit: p.unit, qty, raw: String(it.raw || '').slice(0, 40) });
  }
  const unknown = (Array.isArray(j.unknown) ? j.unknown : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 10);
  const lines = (Array.isArray(j.lines) ? j.lines : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 30);
  return { items, unknown, lines, note: String(j.note || '').slice(0, 100), model: MODEL };
}
