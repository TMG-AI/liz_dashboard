// /api/debug.js
// Helper endpoint to debug Redis data
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

export default async function handler(req, res) {
  try {
    // Get total count
    const totalCount = await redis.zcard(ZSET);

    // Get newest 10 items
    const newest = await redis.zrange(ZSET, 0, 9, { rev: true });
    const newestParsed = newest.map(item => {
      try {
        return JSON.parse(item);
      } catch {
        return item;
      }
    });

    // Count by origin
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);
    const last7Days = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

    const by = {};
    for (const item of last7Days) {
      try {
        const parsed = JSON.parse(item);
        const origin = (parsed.origin || "other").toLowerCase();
        if (!by[origin]) by[origin] = 0;
        by[origin]++;
      } catch {}
    }

    res.status(200).json({
      ok: true,
      total_items_in_redis: totalCount,
      items_last_7_days: last7Days.length,
      count_by_origin: by,
      newest_10_items: newestParsed.map(m => ({
        id: m.id,
        title: m.title?.substring(0, 100),
        origin: m.origin,
        published: m.published,
        published_ts: m.published_ts
      })),
      current_timestamp: now,
      seven_days_ago_timestamp: sevenDaysAgo,
      env_check: {
        congress_api_key: !!process.env.CONGRESS_API_KEY,
        rss_feeds: !!process.env.RSS_FEEDS,
        storage_kv_url: !!process.env.KV2_REST_API_URL,
        storage_kv_token: !!process.env.KV2_REST_API_TOKEN,
        old_kv_url_exists: !!process.env.KV2_REST_API_URL,
        old_kv_token_exists: !!process.env.KV2_REST_API_TOKEN
      }
    });
  } catch (e) {
    console.error("Debug error:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
