import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

// ET "today" bounds in UTC seconds
function etBoundsToday() {
  const nowUtc = new Date();
  const etNow = new Date(nowUtc.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = etNow.getFullYear(), m = etNow.getMonth(), d = etNow.getDate();
  const offsetMs = etNow.getTime() - nowUtc.getTime();
  const startUtcMs = Date.UTC(y, m, d) - offsetMs;
  return { since: Math.floor(startUtcMs/1000), until: Math.floor(Date.now()/1000) };
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

    const { since, until } = etBoundsToday();
    const rows = await redis.zrange(ZSET, 0, 2000, { rev: true }); // newest first

    const included = [];
    const skipped = [];

    for (const member of rows) {
      const m = parseMember(member);
      if (!m) continue;

      const ts = Number(m?.published_ts ?? 0);
      const inToday = Number.isFinite(ts) && ts >= since && ts <= until;

      const section   = String(m.section || "").toLowerCase().trim();
      const provider  = String(m.provider || "").toLowerCase().trim();
      const rawOrigin = String(m.origin || "").toLowerCase().trim();

      const isMwLike =
        section === "meltwater" ||
        provider === "meltwater" ||
        (Array.isArray(m.matched) && m.matched.includes("meltwater-alert")) ||
        (m?.provider_meta?.permalink && String(m.provider_meta.permalink).includes("meltwater")) ||
        (m?.provider_meta?.links?.app && String(m.provider_meta.links.app).includes("meltwater"));

      const origin = rawOrigin || (isMwLike ? "meltwater" : (["rss","reddit","x"].includes(rawOrigin) ? rawOrigin : "other"));

      const row = {
        id: m.id,
        title: m.title || "(untitled)",
        source: m.source || null,
        link: m.link || m?.provider_meta?.permalink || null,
        origin,
        section: m.section || null,
        provider: m.provider || null,
        published: m.published || null,
        published_ts: ts || null
      };

      if (inToday && (origin === "meltwater" || isMwLike)) {
        included.push(row);
      } else {
        row._why = !inToday ? "not_in_today_window" : (origin === "meltwater" || isMwLike ? "unknown_skip" : "not_meltwater");
        skipped.push(row);
      }
    }

    res.status(200).json({
      ok: true,
      window: "today_ET",
      counts: {
        included: included.length,
        skipped: skipped.length,
      },
      included_preview: included.slice(0, 30),
      skipped_preview: skipped.slice(0, 30)
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
