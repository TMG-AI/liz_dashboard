// Debug endpoint to see all article origins
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id) return x;
  try {
    return JSON.parse(x);
  } catch { return null; }
}

export default async function handler(req, res) {
  try {
    // Get last 7 days of data
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });
    const items = raw.map(toObj).filter(Boolean);

    // Count by origin
    const originCounts = {};
    const samples = {}; // Sample articles for each origin

    for (const m of items) {
      let origin = (m.origin || "").toLowerCase() || "(empty)";

      // Track before any mapping
      const rawOrigin = origin;

      // Apply same mapping as frontend
      if (origin === "newsletter_rss") origin = "newsletter";

      // Skip meltwater
      if (origin === "meltwater") continue;

      // Count
      if (!originCounts[origin]) {
        originCounts[origin] = 0;
        samples[origin] = [];
      }
      originCounts[origin]++;

      // Store sample (first 3)
      if (samples[origin].length < 3) {
        samples[origin].push({
          id: m.id,
          title: m.title?.substring(0, 80),
          raw_origin: rawOrigin,
          mapped_origin: origin,
          section: m.section,
          source: m.source
        });
      }
    }

    // Calculate what should be in each category
    const expected = {
      google_alerts: originCounts.google_alerts || 0,
      newsletter: originCounts.newsletter || 0,
      congress: originCounts.congress || 0,
      rss: originCounts.rss || 0
    };

    // Everything else goes to "other"
    let otherCount = 0;
    const otherOrigins = [];
    for (const [origin, count] of Object.entries(originCounts)) {
      if (!['google_alerts', 'newsletter', 'congress', 'rss'].includes(origin)) {
        otherCount += count;
        otherOrigins.push({ origin, count, samples: samples[origin] });
      }
    }

    const total = Object.values(originCounts).reduce((a, b) => a + b, 0);

    res.status(200).json({
      ok: true,
      total_articles: total,
      expected_breakdown: expected,
      expected_total: expected.google_alerts + expected.newsletter + expected.congress + expected.rss,
      other_count: otherCount,
      other_origins: otherOrigins,
      all_origins: originCounts,
      note: "Articles with origins NOT in [google_alerts, newsletter, congress, rss] fall into 'other'"
    });
  } catch (e) {
    console.error('Debug error:', e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
