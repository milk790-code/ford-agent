/**
 * ford-agent 爬蟲核心 — 三條乾淨來源，Worker 與 Node 22 皆可跑（皆有原生 fetch）。
 * 設計原則（依實測修正）：
 *   - PTT car 關鍵字搜尋 = 福特情報主幹（依關鍵字查，必回福特內容；最穩）
 *   - data.gov.tw 開放 CSV = 總市場錨點（政府開放授權；車種別、無廠牌）
 *   - U-CAR 首頁 = 機會性新聞層（當天有福特新聞才貢獻，無則略過、不讓整批失敗）
 * 全程只接公開來源，不碰任何反爬系統、不逆向內部參數。
 */
const UA = "FordMarketAgent/1.0 (+weekly Ford market digest)";
const FORD_KEYS = /福特|Ford|Kuga|Focus|Ranger|Mustang|Territory|Tourneo|Escape/i;

/** 來源1：data.gov.tw 新車領牌數 #30202（總市場，車種別） */
export async function fetchGovRegistrations() {
  const j = await (await fetch("https://data.gov.tw/api/v2/rest/dataset/30202", { headers: { "User-Agent": UA } })).json();
  const csv = (j?.result?.distribution || []).find((d) => /csv/i.test(d.resourceFormat || ""));
  if (!csv) return { source: "data.gov.tw#30202", ok: false, note: "找不到CSV資源" };
  const text = await (await fetch(csv.resourceDownloadUrl, { headers: { "User-Agent": UA } })).text();
  const rows = text.trim().split(/\r?\n/).slice(0, 30).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));
  return { source: "data.gov.tw#30202 新車領牌數(車種別)", ok: true, url: csv.resourceDownloadUrl, header: rows[0], sample: rows.slice(1, 7), note: "政府開放授權；總市場車種別、無廠牌" };
}

/** 來源2：PTT car 搜尋（福特情報主幹，多車款各查一次） */
export async function fetchPtt(keywords = ["Kuga", "Focus", "Ranger", "Territory", "福特菜單"]) {
  const all = []; const seen = new Set();
  for (const kw of keywords) {
    try {
      const html = await (await fetch("https://www.ptt.cc/bbs/car/search?q=" + encodeURIComponent(kw), { headers: { "User-Agent": UA, Cookie: "over18=1" } })).text();
      for (const m of html.matchAll(/<div class="title">\s*<a href="([^"]+)">([^<]+)<\/a>/g)) {
        const url = "https://www.ptt.cc" + m[1]; const title = m[2].trim();
        if (seen.has(url)) continue; seen.add(url);
        all.push({ keyword: kw, title, url, isMenu: /菜單/.test(title) });
      }
    } catch (e) { /* 單一關鍵字失敗不影響其餘 */ }
  }
  const menus = all.filter((x) => x.isMenu);
  return { source: "PTT car 搜尋", ok: true, count: all.length, menus, posts: all.slice(0, 30), note: "公開；福特菜單/心得情報主幹" };
}

/** 來源3：U-CAR 首頁（機會性福特新聞層） */
export async function fetchUcar() {
  const html = await (await fetch("https://news.u-car.com.tw/", { headers: { "User-Agent": UA } })).text();
  const map = new Map();
  for (const m of html.matchAll(/href="(\/\/news\.u-car\.com\.tw\/news\/article\/\d+)"[^>]*>([^<]{4,90})</g)) {
    const url = "https:" + m[1]; const t = m[2].trim();
    if (t && !map.has(url)) map.set(url, t);
  }
  const ford = [...map.entries()].filter(([, t]) => FORD_KEYS.test(t)).map(([url, title]) => ({ title, url }));
  return { source: "U-CAR 新聞首頁", ok: true, scanned: map.size, fordItems: ford, note: ford.length ? "本批有福特新聞" : "本批首頁無福特新聞（正常，改由PTT主幹補）" };
}

/** 整合：產出給工具讀的 digest JSON */
export async function buildDigest() {
  const out = { generatedAt: new Date().toISOString(), schema: "ford-agent/1", sources: {} };
  const jobs = [["gov", fetchGovRegistrations], ["ptt", () => fetchPtt()], ["ucar", fetchUcar]];
  await Promise.all(jobs.map(async ([k, fn]) => {
    try { out.sources[k] = await fn(); } catch (e) { out.sources[k] = { ok: false, error: String(e).slice(0, 140) }; }
  }));
  // 摘要：給工具情報頁直接顯示的精華
  const ptt = out.sources.ptt || {}; const ucar = out.sources.ucar || {};
  out.summary = {
    pttMenus: (ptt.menus || []).slice(0, 8),
    pttCount: ptt.count || 0,
    fordNews: (ucar.fordItems || []).slice(0, 6),
    govOk: !!(out.sources.gov && out.sources.gov.ok),
  };
  return out;
}
