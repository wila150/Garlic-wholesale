# 蒜頭行 LINE 叫貨系統

這份是**蒜頭行**專用版本：Firebase 專案 `garlic-wholesale`，網址 https://garlic-wholesale.web.app ，GitHub wila150/Garlic-wholesale。
菜行的版本在 `../Caihang order`，兩份程式已分開（2026-10-31），各改各的；兩家都要的修正要兩邊都改。
目前還沒接上蒜頭行自己的 LINE 官方帳號（之前的測試帳號已改接菜行）。

## 系統是什麼
LINE 叫貨＋後台管理系統：店家在 LINE 官方帳號叫貨（打字、拍照由 AI 整理後確認，或用叫貨單選），老闆和員工在網頁後台處理採買、單價、出貨單、對帳收款、記帳、報表。

- 前端：`public/`，原生 HTML＋JS，不用建置工具。`admin.html` 後台、`index.html` 店家叫貨頁、`sign.html` 確認單簽收、`manual.html` 說明書；共用樣式 `theme.css`、品牌 `brand.js`。
- 後端：Firebase Cloud Functions（`functions/`，Node 22，asia-east1）。`/api/**` 由 Hosting 轉到函式 `api`：
  - `api/webhook.js` LINE webhook、`api/storechat.js` 店家選單功能（照上次叫、我的帳款、回報問題）、`api/bosschat.js` 老闆選單（今日訂單、未收帳款）
  - `api/admin.js` 後台 API、`api/shop.js` 叫貨頁 API、`api/img.js` 推播圖片
  - `lib/shop.js` 訂單／店家／品項／收款、`lib/expense.js` 記帳、`lib/report.js` 報表、`lib/aiorder.js`＋`lib/ai.js` AI 叫貨（NVIDIA）、`lib/dates.js` 截單與配送日、`lib/rules.js` 後台設定
- 資料庫 Firestore；金鑰在 Secret Manager（LINE_CHANNEL_SECRET、LINE_CHANNEL_ACCESS_TOKEN、NVIDIA_API_KEY），**不要印出來、不要進 git**。
- 每個專案的環境變數在 `functions/.env.<專案ID>`（SHOP_KIND、SHOP_NAME、ENGINEER_EMAILS、ADMIN_LINE_USER_IDS、LIFF_ID…）。

## 常用指令
- 部署：`npm run deploy`（只會部署到本資料夾對應的專案）；改前端只要 `--only hosting`，改後端加 `functions:api`
- 部署前會自動跑 `scripts/stamp-version.mjs` 蓋版本號（月日＋第幾次，例如 103101），後台切回 App 時會自動更新
- 本機測試：`npm run emulators`（要 Java），再 `npm run seed` 灌示範資料、`npm run link -- 1` 產生叫貨連結；`functions/.secret.local` 的 LINE token 設成 `dry-run` 時訊息只會印在 log
- LINE 圖文選單：`npm run richmenu`（先畫圖再上傳；圖片用 JPG，LINE 上限 1MB）

## 寫程式的習慣
- 程式註解、說明都用繁體中文，風格照現有的（簡短、說為什麼）
- 改功能時一起更新 `public/manual.html` 說明書
- 表單欄位不要用 `f.elements.item`（`item` 會撞到瀏覽器內建方法），用 `querySelector('[name=…]')`
- 後台在 LINE 內建瀏覽器不能 Google 登入，連結要加 `openExternalBrowser=1`
- LINE quickReply 最多 13 個；回覆免費，推播（push）會用額度，推播給店家的功能要先確認
- 店家看不到任何價格（叫貨頁 API 用白名單欄位）

## 跟使用者溝通
- 一律用繁體中文回覆
- 使用者是這套系統的開發者（學生、接案），客戶是菜行和蒜頭行

## 目前狀況（2026-10-31）
- 打算簡化成三塊：**POS（門市收銀）、LINE 叫菜、記帳**，其他功能（採買、報價組、月結對帳等）先關掉或隱藏
- POS 第一版建議：需要網路、只收現金、出紙本收據、營收進記帳；電子發票、刷卡、離線模式之後再看
- 需求訪談單（17 題）在 ~/Downloads/蒜頭行需求訪談單.pdf，還沒去訪談
- `../Ganbaru29POS` 可能是使用者之前做的 POS，做收銀前可以先看
