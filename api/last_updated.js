// /api/last_updated.js
// Returns the most recent collection timestamp
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

export default async function handler(req, res) {
  try {
    // Get the most recent article from Redis to determine last update time
    const recent = await redis.zrange("mentions:z", -1, -1, { rev: true });

    let lastUpdated = null;

    if (recent && recent.length > 0) {
      try {
        const article = JSON.parse(recent[0]);
        // Use received_at if available (for Meltwater), otherwise use current time
        lastUpdated = article.received_at || new Date().toISOString();
      } catch (e) {
        console.error('Error parsing recent article:', e);
      }
    }

    // If we couldn't get a timestamp from articles, use current time
    if (!lastUpdated) {
      lastUpdated = new Date().toISOString();
    }

    res.status(200).json({
      ok: true,
      last_updated: lastUpdated,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('Error getting last updated time:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
