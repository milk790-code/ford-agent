# ford-agent
台灣福特市場情報雲端代理人。Cloudflare Worker：每週一抓三條乾淨公開來源 → JSON 端點 + Workers AI 視覺辨識端點。
**部署看「部署導航手冊.md」。** 不寫程式也能上線。

## 結構
- `src/index.js` — Worker（scheduled cron + /data + /vision + /refresh + /health）
- `src/scrape_core.js` — 三來源爬蟲核心（政府CSV / PTT搜尋 / U-CAR）
- `scripts/scrape_core.mjs` — 同核心，供本機 `npm run test:scrape` 測試
- `wrangler.toml` — cron、R2(FORD_R2)、AI 綁定
- `.github/workflows/deploy.yml` — push 自動部署
- `.github/workflows/weekly-backup.yml` — GitHub 端每週備援抓取

## 端點
- `GET /data` 最新情報 JSON（工具讀這個）
- `GET /refresh` 手動觸發抓取
- `POST /vision` 圖片辨識 {image,fields?}
- `GET /health` 健康檢查

只接公開來源，不碰反爬系統。金鑰一律走 Secret，不入庫。
