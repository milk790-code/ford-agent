/**
 * ford-agent — Cloudflare Worker
 * 功能三合一（同一朵雲、零 Anthropic 金鑰）：
 *   1) 每週一 Cron 自動抓三條乾淨來源 → 整理 JSON 存 R2
 *   2) GET /data    → 回傳最新 digest JSON（給單檔工具情報頁 fetch，已開 CORS）
 *   3) POST /vision → 收一張 base64 圖，用 Cloudflare Workers AI(Llama 3.2 Vision)辨識 → 回傳文字/欄位
 * 遵守 Cloudflare Workers Best Practices：compatibility_date 最新、nodejs_compat、
 *   無 module-level 可變狀態、所有 Promise 皆 await/waitUntil、Web Crypto 取代 Math.random。
 * 只接公開來源，不碰任何反爬系統。
 */
import { buildDigest } from "./scrape_core.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

export default {
  /** 每週一 09:00(台灣) 自動執行：抓資料、寫 R2 */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const digest = await buildDigest();
      await env.FORD_R2.put("latest.json", JSON.stringify(digest), {
        httpMetadata: { contentType: "application/json" },
      });
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // 健康檢查
    if (url.pathname === "/" || url.pathname === "/health")
      return json({ ok: true, service: "ford-agent", endpoints: ["/data", "/vision", "/refresh"], time: new Date().toISOString() });

    // 給工具讀的最新情報 JSON
    if (url.pathname === "/data") {
      const obj = await env.FORD_R2.get("latest.json");
      if (!obj) return json({ ok: false, note: "尚無資料，請先觸發 /refresh 或等週一 Cron" }, 404);
      return new Response(obj.body, { headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
    }

    // 手動觸發抓取（部署後先打一次，不必等週一）
    if (url.pathname === "/refresh") {
      const digest = await buildDigest();
      await env.FORD_R2.put("latest.json", JSON.stringify(digest), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, refreshed: digest.generatedAt, summary: digest.summary });
    }

    // 視覺辨識：POST { image: "data:image/...;base64,xxx" 或純 base64, prompt?: "...", fields?: ["底價","籌碼"...] }
    if (url.pathname === "/vision" && request.method === "POST") {
      try {
        const body = await request.json();
        let b64 = body.image || "";
        b64 = b64.includes(",") ? b64.split(",")[1] : b64;       // 去掉 data: 前綴
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : null;
        const ask = body.prompt || (fields
          ? `這是一張汽車銷售政策表或菜單的照片。請辨識其中文字，並盡量抽出這些欄位的數字或內容：${fields.join("、")}。用繁體中文，以「欄位：值」逐行輸出；看不清楚的欄位標「(不確定)」，絕不臆造數字。`
          : "請用繁體中文辨識這張圖片中的所有文字，逐行輸出；數字務必精確，看不清楚標「(不確定)」，不要臆造。");

        // ── 預設：Cloudflare Workers AI，零外部金鑰 ──
        // 升級開關：若在 Cloudflare 後台設了環境變數 VISION_PROVIDER=anthropic + 密鑰 ANTHROPIC_API_KEY，改走前沿模型
        if (env.VISION_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({
              model: env.VISION_MODEL || "claude-sonnet-4-6",
              max_tokens: 1500,
              messages: [{ role: "user", content: [
                { type: "image", source: { type: "base64", media_type: body.mime || "image/jpeg", data: b64 } },
                { type: "text", text: ask },
              ] }],
            }),
          });
          const j = await r.json();
          const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
          return json({ ok: true, provider: "anthropic", text });
        }

        // 預設路徑：Workers AI Llama 3.2 11B Vision（走 env.AI 綁定）
        const out = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          image: [...bytes],
          prompt: ask,
          max_tokens: 1500,
        });
        return json({ ok: true, provider: "workers-ai", text: out.response || out.description || "" });
      } catch (e) {
        return json({ ok: false, error: String(e).slice(0, 200) }, 500);
      }
    }

    return json({ ok: false, note: "未知路徑" }, 404);
  },
};
