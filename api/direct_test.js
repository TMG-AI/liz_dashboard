// Direct test of get_mentions logic
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
  }
  catch { return null; }
}

export default async function handler(req, res) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    console.log(`Current timestamp: ${now}`);
    console.log(`Seven days ago: ${sevenDaysAgo}`);
    console.log(`Current date: ${new Date(now * 1000).toISOString()}`);
    console.log(`Seven days ago date: ${new Date(sevenDaysAgo * 1000).toISOString()}`);

    // Use exact same query as get_mentions
    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

    console.log(`Raw items fetched: ${raw.length}`);

    const redisItems = raw.map(toObj).filter(Boolean);
    console.log(`Parsed items: ${redisItems.length}`);

    // Show first 3 items
    const samples = redisItems.slice(0, 3).map(m => ({
      id: m.id,
      title: m.title?.substring(0, 80),
      origin: m.origin,
      published: m.published,
      published_ts: m.published_ts,
      in_range: m.published_ts >= sevenDaysAgo && m.published_ts <= now
    }));

    res.status(200).json({
      ok: true,
      query: {
        now,
        sevenDaysAgo,
        now_date: new Date(now * 1000).toISOString(),
        seven_days_ago_date: new Date(sevenDaysAgo * 1000).toISOString()
      },
      raw_count: raw.length,
      parsed_count: redisItems.length,
      samples,
      note: "This uses the exact same logic as get_mentions.js"
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
