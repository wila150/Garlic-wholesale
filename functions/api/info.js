// 公開的店家基本資料（店名、標誌、配色），給登入頁、說明書這些還沒登入的頁面用。不含任何價格或客人資料
import { SHOP } from '../lib/config.js';
import { json } from '../lib/http.js';
import { getRulesNow } from '../lib/dates.js';

export async function GET() {
  return json({ name: SHOP.name, logo: SHOP.logo, palette: getRulesNow().palette });
}
