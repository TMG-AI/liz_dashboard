import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

function etBoundsToday() {
  const nowUtc = new Date();
  const etNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = etNow.getFullYear(), m = etNow.getMonth(), d = etNow.getDate();
  const offsetMs = etNow.getTime() - nowUtc.getTime();
  const startUtcMs = Date.UTC(y, m, d) - offsetMs;
  return { since: Math.floor(startUtcMs/1000), until: Math.floor(Date.now()/1000) };
}
function windowToRange(win = "24h") {
  const now = Math.floor(Date.now()/1000);
  const w = String(win).toLowerCase();
  if (w === "today" || w === "today_et") return etBoundsToday();
  if (w === "7d")  return { since: now - 7*24*3600,  until: now };
  if (w === "30d") return { since: now - 30*24*3600, until: now };
  return { since: now - 24*3600, until: now };
}
function parseMember(member) {
  if (member == null) return null;
  if (typeof member === "object") return member;
  if (typeof member === "string") { try { return JSON.parse(member); } catch { return null; } }
  try { return JSON.parse(String(member)); } catch { return null; }
}

export default async function handler(req, res){
  try{
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }

    const win    = String(req.query.window || "24h");
    const { since, until } = windowToRange(win);
    const want   = String(req.query.origin || "all").toLowerCase(); // meltwater|rss|reddit|x|all
    const limit  = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);

    // fetch newest first; filter by published_ts
    const rows = await redis.zrange(ZSET, 0, 2000, { rev: true });

    const items = [];
    for (const member of rows) {
      const m = parseMember(member);
      if (!m) continue;

      const ts = Number(m?.published_ts || 0);
      if (!Number.isFinite(ts) || ts < since || ts > until) continue;

      const section   = String(m.section || "").toLowerCase().trim();
      const provider  = String(m.provider || "").toLowerCase().trim();
      const rawOrigin = String(m.origin || "").toLowerCase().trim();
      const isMwLike =
        section === "meltwater" ||
        provider === "meltwater" ||
        (Array.isArray(m.matched) && m.matched.includes("meltwater-alert")) ||
        (m?.provider_meta?.permalink && String(m.provider_meta.permalink).includes("meltwater")) ||
        (m?.provider_meta?.links?.app && String(m.provider_meta.links.app).includes("meltwater"));

      let origin = rawOrigin || (isMwLike ? "meltwater" : "");
      if (origin === "twitter" || origin === "tweet" || origin === "twitter/x") origin = "x";
      if (!["meltwater","rss","reddit","x"].includes(origin)) origin = "other";

      if (want !== "all" && origin !== want) continue;

      const link = m.link || m?.provider_meta?.permalink || null;

      items.push({
        id: m.id,
        origin,
        source: m.source || null,
        title: m.title || "(untitled)",
        link,
        reach: m?.provider_meta?.reach ?? null,
        published_ts: ts,
        published: m.published || null
      });

      if (items.length >= limit) break;
    }

    res.status(200).json({
      ok: true,
      window: win,
      origin: want,
      count: items.length,
      items,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
