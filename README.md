# 蒜頭叫貨系統（LINE 官方帳號 × Firebase）

店家在 LINE 點「我要叫貨」，打開叫貨單選品項和數量（**看不到價格**），截單前都能自己改。後台依角色分權限，用來看採買總表、補當日單價、處理依配送路線排的出貨單、做月結對帳，也在這裡管理品項、店家和帳號。

| 網址 | 用途 |
|---|---|
| `https://garlic-wholesale.web.app/?t=…` | 店家叫貨頁（從 LINE 機器人給的連結開） |
| `https://garlic-wholesale.web.app/admin` | 後台，用 Email 登入 |
| `https://garlic-wholesale.web.app/api/webhook` | 填到 LINE Developers 的 Webhook URL |

## 架構

| 部分 | 用途 |
|---|---|
| Firebase Hosting | `public/`：叫貨頁、後台 |
| Cloud Functions（asia-east1 台灣） | `functions/`：API、LINE webhook |
| Firestore | 所有資料（各集合的說明在 `functions/lib/shop.js` 開頭） |
| Firebase Authentication | 後台帳號 |
| Secret Manager | LINE 金鑰 |

## 後台角色

| 角色 | 可以做 |
|---|---|
| 老闆 | 全部，包含店家開通和帳號管理。用 `OWNER_EMAILS` 指定 |
| 會計 | 單價、對帳、品項、改出貨數量、傳對帳單 |
| 理貨 | 採買總表、出貨單、改數量、提醒叫貨。**看不到單價** |
| 司機 | 只能看採買總表和出貨單 |

老闆登入後，在「帳號」分頁新增員工：填 Email、初始密碼、選角色。

## 第一次上線

### 1. Firebase Console（console.firebase.google.com → garlic-wholesale）
1. **升級 Blaze 方案**：左下角「升級」。Cloud Functions 要呼叫 LINE，一定要用 Blaze，以這個規模費用大多落在免費額度內。可以順便在 Google Cloud 設預算提醒。
2. **Firestore Database** → 建立資料庫：位置選 **asia-east1（台灣）**，模式選「正式版」。
3. **Authentication** → 開始使用 → 登入方式 → 啟用「**電子郵件／密碼**」。
4. **專案設定** → 一般 → 你的應用程式 → 新增「**網頁**」應用程式，名稱隨意。後台登入需要它。

### 2. 電腦上（只要做一次）
```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
cp functions/.env.example functions/.env   # 填 OWNER_EMAILS（你自己的 Email）、SHOP_NAME 等
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase deploy
```

### 3. 老闆帳號
Firebase Console → Authentication → 新增使用者：Email 用 `OWNER_EMAILS` 裡的那個，自己設密碼。之後就能登入 `/admin`。

### 4. LINE 設定
1. **LINE Developers** → Messaging API：Webhook URL 填 `https://garlic-wholesale.web.app/api/webhook`，按 Verify，再打開 **Use webhook**。
2. **官方帳號管理後台** → 回應設定：「聊天」打開、「Webhook」打開、「自動回應訊息」關掉。
3. 用你自己的 LINE 傳「我的ID」給機器人，把回覆的 userId 填到 `functions/.env` 的 `ADMIN_LINE_USER_IDS`，再跑一次 `firebase deploy --only functions`。之後有店家申請開通時，你會收到通知。
4. **圖文選單**：版型選左邊一大格、右邊兩格，動作都選「文字」，分別設成 `我要叫貨`、`我的訂單`、`聯絡老闆`。

## 資料保存與備份

- **資料永久保存，不自動刪除**。依商業會計法，會計憑證至少要保存 5 年，帳簿和報表至少 10 年。這個規模 10 年的資料量也遠低於 Firestore 免費的 1 GB。
- **每日自動備份**（建議設定）：Firebase Console → Firestore → 災害復原 → 建立排程備份，每天一次、保留 14 週。也可以用指令設定：
  ```bash
  gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w --project=garlic-wholesale
  ```
- 匯出 Excel 和自動匯出到 Google 雲端硬碟，會在下一階段加入。

## 叫貨流程和截單

- 每家店每個配送日一張訂單，配送日**前一天 `CUTOFF_HOUR` 點**截單，預設 22:00。截單後叫貨頁會自動切到下一個配送日；`CLOSED_WEEKDAYS` 設定的公休日會跳過。
- 單價：「單價」頁只列出當天有人叫的品項，先帶入上次的價格，確認後套用到當天所有出貨單和對帳。
- 「斤」的品項可以叫幾斤幾兩（1 斤 = 16 兩）；單位可以在「品項」分頁自己新增。

## 本機開發（Firebase 模擬器，不花錢、不動正式資料）

需要 Java 21 以上（模擬器要用）。
```bash
cd functions && npm install && cd ..
# functions/.secret.local 放 LINE_CHANNEL_SECRET=…，以及 LINE_CHANNEL_ACCESS_TOKEN=dry-run（不真的送 LINE）
# functions/.env.local 放 OWNER_EMAILS=owner@test.com
npm run emulators      # 另開一個視窗：
npm run seed           # 寫入示範資料和測試帳號（密碼 test1234）
npm run link -- 4      # 印出第 4 家店的叫貨連結
```
- 後台：http://localhost:5050/admin
- 模擬器管理介面（可以直接看資料庫）：http://127.0.0.1:4000

## 訊息額度

回覆（reply）不算額度，**主動推播（push）會算**，台灣免費方案每月 200 則。目前只有開通通知、提醒叫貨、傳對帳單、開通申請通知會用到推播。之後如果每天推電子收據，70 家店一個月約 2,100 則，就需要付費方案。

## 安全

- 金鑰只放在 Secret Manager 和 `functions/.secret.local`（不進 git），**不要寫進程式碼**。
- Firestore 規則禁止瀏覽器直接讀寫，所有資料都經過 Cloud Functions 檢查權限。
- 叫貨連結 7 天有效，只出現在店家自己的 LINE 對話裡。綁定的帳號在後台「店家」可以隨時解除。
