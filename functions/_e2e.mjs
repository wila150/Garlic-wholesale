import fs from 'node:fs';
import crypto from 'node:crypto';
const sec = fs.readFileSync('.secret.local','utf8');
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
process.env.LINE_CHANNEL_SECRET = sec.match(/^LINE_CHANNEL_SECRET=(.*)$/m)[1];
process.env.NVIDIA_API_KEY = sec.match(/^NVIDIA_API_KEY=(.*)$/m)[1];
process.env.LINE_CHANNEL_ACCESS_TOKEN='dry-run';
const { initializeApp } = await import('firebase-admin/app'); initializeApp({ projectId: 'garlic-wholesale' });
const { getFirestore } = await import('firebase-admin/firestore'); const db = getFirestore();
const shop = await import('./lib/shop.js');
const { confirmDraft } = await import('./lib/aiorder.js');
const { parseOrder } = await import('./lib/ai.js');
const { openDate } = await import('./lib/dates.js');
const { sign } = await import('./lib/token.js');
const uid = (n) => `Utest${String(n).padStart(28, '0')}`;
const D = openDate(); const ok=(c,m)=>console.log(c?'✅':'❌', m);
const qtyOf=(o,pid)=>o?.items.find(i=>i.pid===pid)?.qty||0;

// T1 確認送出連按
let before = qtyOf(await shop.getOrder(D,'s1'),'p5');
await db.doc('aiDrafts/t1').set({ id:'t1', storeId:'s1', storeName:'阿美麵店', userId:uid(1), date:D, type:'text', text:'蒜仁2', items:[{pid:'p5',name:'蒜仁',unit:'斤',qty:2}], unknown:[], note:'', status:'pending', createdAt:new Date().toISOString() });
const rr = await Promise.all([1,2,3].map(()=>confirmDraft(uid(1),'t1','http://localhost:5050')));
let after = qtyOf(await shop.getOrder(D,'s1'),'p5');
ok(after-before===2, `T1 確認送出連按 3 下：蒜仁 ${before} → ${after}（應該只加 2）；回覆：${rr.map(r=>r.altText||r.text).join(' | ')}`);

// T2 同時改單
const o2 = await shop.getOrder(D,'s2'); const [a,b] = o2.items;
await Promise.all([ shop.setShip('s2',D,a.pid,a.qty+1,'理貨'), shop.setQty('s2',D,b.pid,b.qty+3,'會計'), shop.saveOrder('s2',D,(old)=>[...old.items.map(i=>({pid:i.pid,qty:i.qty})),{pid:'p13',qty:1}],'後台','老闆') ]);
const o2b = await shop.getOrder(D,'s2');
ok(o2b.items.find(i=>i.pid===a.pid)?.ship===a.qty+1 && qtyOf(o2b,b.pid)===b.qty+3 && qtyOf(o2b,'p13')===1, `T2 三個人同時改單：${a.name} 實出 ${o2b.items.find(i=>i.pid===a.pid)?.ship}、${b.name} ${qtyOf(o2b,b.pid)}、油蔥酥 ${qtyOf(o2b,'p13')}`);

// T5 存品項不清掉別名
await shop.addAlias({ text:'白蒜', pid:'p1' });
const prods = await shop.getProducts();
await shop.saveProducts(prods.map(({alias,...p})=>p)); // 模擬舊畫面沒送 alias
const p1 = (await shop.getProducts()).find(p=>p.id==='p1');
ok(shop.aliasList(p1.alias).includes('白蒜'), `T5 存品項後別名還在：${JSON.stringify(p1.alias)}`);
let dup=''; try{ await shop.addAlias({ text:'白蒜', pid:'p2' }); }catch(e){dup=e.message}
ok(!!dup, `T5b 同一叫法不能對到兩個品項：${dup}`);

// T4 教 AI：通用叫法 + 這家店專屬
const products = await shop.getProducts();
await shop.addAlias({ text:'大的', pid:'p2', storeId:'s1' });
const sa = await shop.getStoreAliases('s1');
const r4 = await parseOrder({ text:'白蒜2斤、大的3斤', products, storeAliases: sa });
ok(r4.items.some(i=>i.pid==='p1'&&i.qty===2) && r4.items.some(i=>i.pid==='p2'&&i.qty===3), `T4 AI 認得叫法：${r4.items.map(i=>i.name+i.qty).join('、')}；看不懂：${r4.unknown.join('、')||'無'}`);
const r4b = await parseOrder({ text:'大的3斤', products, storeAliases: [] });
console.log('   （沒有店家專屬叫法時「大的3斤」→', r4b.items.map(i=>i.name+i.qty).join('、')||'無', '／看不懂：', r4b.unknown.join('、')||'無', '）');

// T7 補單 bug：截單前老闆就確認了
await db.doc(`signatures/${D}_s3`).set({ date:D, storeId:'s3', seq:1, key:'s3', by:'後台', at:new Date().toISOString() });
const t3 = sign(uid(3));
const g = await (await fetch(`http://localhost:5050/api/shop?t=${t3}`)).json();
ok(g.addon?.mainLocked && g.addon.date===D, `T7 已確認後叫貨頁開放補單：${JSON.stringify({date:g.addon?.date,until:g.addon?.until,mainLocked:g.addon?.mainLocked})}`);
const post = (body)=>fetch('http://localhost:5050/api/shop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:t3,...body})}).then(async r=>({s:r.status,j:await r.json()}));
const pa = await post({ date:D, mode:'addon', items:[{pid:'p9',qty:2}] });
const po = await post({ date:D, items:[{pid:'p9',qty:2}] });
ok(pa.s===200 && pa.j.order, `T7b 店家補單成功（另開一張）；改原本的單被擋：${po.s} ${po.j.error}`);
const slips = await shop.slipsOfDay('s3', D);
console.log('   巷口便當這天的單：', slips.map(o=>`#${o.seq||1}${o.addon?'(店家補單)':''} ${o.items.map(i=>i.name+i.qty).join('、')}`).join(' ／ '));

// T3 LINE 重送同一則訊息
const body = JSON.stringify({ destination:'x', events:[{ type:'message', webhookEventId:'evtDUP1', deliveryContext:{isRedelivery:false}, replyToken:'rt', source:{type:'user',userId:uid(4)}, timestamp:Date.now(), mode:'active', message:{type:'text',id:'m1',text:'白蒜2斤'} }] });
const sig = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
await Promise.all([1,2].map(()=>fetch('http://localhost:5050/api/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-line-signature':sig},body})));
await new Promise(r=>setTimeout(r,25000));
const drafts = (await db.collection('aiDrafts').where('storeId','==','s4').get()).docs.map(d=>d.data());
ok(drafts.length===1, `T3 LINE 重送 2 次只辨識 1 次：aiDrafts ${drafts.length} 筆；結果 ${drafts.map(d=>d.status+' '+d.items.map(i=>i.name+i.qty).join('、')).join(' | ')}`);
process.exit(0);
