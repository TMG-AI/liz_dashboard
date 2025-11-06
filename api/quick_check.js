// Quick check endpoint to see what's in Redis
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
    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

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
    const by = {};
    for (const m of items) {
      const origin = (m.origin || "unknown").toLowerCase();
      if (!by[origin]) by[origin] = 0;
      by[origin]++;
    }

    // Get samples
    const samples = items.slice(0, 5).map(m => ({
      title: m.title?.substring(0, 80),
      origin: m.origin,
      published: m.published,
      published_ts: m.published_ts
    }));

    res.status(200).json({
      ok: true,
      total_items: items.length,
      count_by_origin: by,
      samples,
      time_window: {
        from: sevenDaysAgo,
        to: now,
        from_date: new Date(sevenDaysAgo * 1000).toISOString(),
        to_date: new Date(now * 1000).toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
