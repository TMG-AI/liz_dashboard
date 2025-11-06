// Show ALL articles grouped by origin to identify Coinbase data
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

    // Get all items from last 7 days
    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

    const items = raw.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Group by origin
    const byOrigin = {};

    for (const item of items) {
      const origin = item.origin || 'NO_ORIGIN';
      if (!byOrigin[origin]) {
        byOrigin[origin] = {
          count: 0,
          samples: []
        };
      }
      byOrigin[origin].count++;

      // Keep first 5 samples
      if (byOrigin[origin].samples.length < 5) {
        byOrigin[origin].samples.push({
          title: item.title?.substring(0, 100),
          source: item.source,
          published: item.published,
          section: item.section
        });
      }
    }

    res.status(200).json({
      ok: true,
      total_items: items.length,
      origins: byOrigin,
      summary: Object.entries(byOrigin).map(([origin, data]) => ({
        origin,
        count: data.count
      })).sort((a, b) => b.count - a.count)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
