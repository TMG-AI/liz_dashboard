// Test endpoint to verify what get_mentions returns
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

export default async function handler(req, res) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    // Get last 7 days
    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true, rev: true });

    const items = raw.map(item => {
      try {
        if (typeof item === 'string') {
          return JSON.parse(item);
        }
        return item;
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Count by origin
    const by = { rss: 0, google_alerts: 0, newsletter: 0, congress: 0, other: 0 };

    const originSamples = [];
    for (const m of items) {
      const origin = (m.origin || "").toLowerCase();

      // Collect samples
      if (originSamples.length < 10) {
        originSamples.push({
          title: m.title?.substring(0, 50),
          origin: m.origin,
          origin_lowercase: origin,
          has_property: by.hasOwnProperty(origin)
        });
      }

      if (by.hasOwnProperty(origin)) {
        by[origin]++;
      } else {
        by.other++;
      }
    }

    res.status(200).json({
      ok: true,
      total_items: items.length,
      count_by_origin: by,
      sample_items: originSamples,
      timestamp_check: {
        current: now,
        seven_days_ago: sevenDaysAgo,
        raw_count: raw.length
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
