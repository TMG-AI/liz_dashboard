// One-time cleanup to remove duplicate Congress bills with API URLs
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_LINK = "mentions:seen:canon";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST to confirm cleanup" });
    }

    console.log("Starting cleanup of duplicate Congress bills...");

    // Get all items
    const raw = await redis.zrange(ZSET, 0, -1);
    const items = raw.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    }).filter(Boolean);

    let removed = 0;
    const removedItems = [];

    // Find and remove items with api.congress.gov URLs
    for (const rawItem of raw) {
      try {
        const item = typeof rawItem === 'string' ? JSON.parse(rawItem) : rawItem;

        // Check if it's a Congress bill with API URL
        if (item.origin === 'congress' && item.link && item.link.includes('api.congress.gov')) {
          console.log(`Removing duplicate bill: ${item.title}`);
          console.log(`  Old URL: ${item.link}`);

          // Remove from sorted set
          await redis.zrem(ZSET, rawItem);

          // Remove from seen links if present
          const canonUrl = item.link.split('?')[0]; // Remove query params for canonical
          await redis.srem(SEEN_LINK, canonUrl);
          await redis.srem(SEEN_LINK, item.link);

          removed++;
          removedItems.push({
            id: item.id,
            title: item.title,
            link: item.link
          });
        }
      } catch (e) {
        console.error('Error processing item:', e);
      }
    }

    console.log(`Cleanup complete: removed ${removed} duplicate bills`);

    res.status(200).json({
      ok: true,
      message: `Removed ${removed} duplicate Congress bills with API URLs`,
      removed_count: removed,
      removed_items: removedItems,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error("Cleanup error:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
