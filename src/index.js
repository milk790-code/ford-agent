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
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });

// ── 驗證：要求 Authorization: Bearer <env.API_TOKEN> ──
// 回傳 null=放行；否則回傳要直接送回的 Response。
// 未設定 API_TOKEN 時一律拒絕（fail-closed, 503），避免無密鑰時門戶大開。
const requireAuth = (request, env) => {
  if (!env.API_TOKEN)
    return json({ ok: false, error: "伺服器未設定 API_TOKEN，端點已停用" }, 503);
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  if (!token || !timingSafeEqual(token, env.API_TOKEN))
    return json({ ok: false, error: "未授權" }, 401);
  return null;
};

// 常數時間字串比較，降低 token 被時間側錄猜測的風險。
const timingSafeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
};

// ── /vision 基本速率限制（每 IP 滑動視窗，存於 module-scope Map）──
// 注意：Worker 為多 isolate，此為「盡力而為」的輕量保護，非全域強保證。
const RATE_WINDOW_MS = 60_000; // 1 分鐘視窗
const RATE_MAX = 20;           // 每視窗每 IP 最多次數
const rateBuckets = new Map();
const rateLimited = (request) => {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For") ||
    "unknown";
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) {
    rateBuckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(ip, hits);
  // 順手清掉過期 IP，避免 Map 無限長大
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      const kept = v.filter((t) => now - t < RATE_WINDOW_MS);
      if (kept.length) rateBuckets.set(k, kept);
      else rateBuckets.delete(k);
    }
  }
  return false;
};

// base64 輸入大小上限（解碼後位元組數 ≤ 5MB）
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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

    // 手動觸發抓取（部署後先打一次，不必等週一）— 需驗證
    if (url.pathname === "/refresh") {
      const denied = requireAuth(request, env);
      if (denied) return denied;
      const digest = await buildDigest();
      await env.FORD_R2.put("latest.json", JSON.stringify(digest), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, refreshed: digest.generatedAt, summary: digest.summary });
    }

    // 視覺辨識：POST { image: "data:image/...;base64,xxx" 或純 base64, prompt?: "...", fields?: ["底價","籌碼"...] }
    if (url.pathname === "/vision" && request.method === "POST") {
      const denied = requireAuth(request, env);
      if (denied) return denied;
      if (rateLimited(request))
        return json({ ok: false, error: "請求過於頻繁，請稍後再試" }, 429);
      try {
        const body = await request.json();
        let b64 = body.image || "";
        b64 = b64.includes(",") ? b64.split(",")[1] : b64;       // 去掉 data: 前綴
        if (!b64) return json({ ok: false, error: "缺少 image" }, 400);
        // 解碼後位元組數 ≈ base64 長度 * 3/4；先擋掉超大輸入再 decode
        const approxBytes = Math.floor((b64.length * 3) / 4);
        if (approxBytes > MAX_IMAGE_BYTES)
          return json({ ok: false, error: "圖片過大，上限 5MB" }, 413);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        if (bytes.length > MAX_IMAGE_BYTES)
          return json({ ok: false, error: "圖片過大，上限 5MB" }, 413);
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
