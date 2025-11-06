// Fix Congress bill URLs to use correct format (senate-resolution not sres-bill, etc.)
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_LINK = "mentions:seen:canon";

// Map bill types to correct URL format
const typeMap = {
  's': 'senate-bill',
  'hr': 'house-bill',
  'sres': 'senate-resolution',
  'hres': 'house-resolution',
  'sjres': 'senate-joint-resolution',
  'hjres': 'house-joint-resolution',
  'sconres': 'senate-concurrent-resolution',
  'hconres': 'house-concurrent-resolution'
};

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.search) url.search = "";
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (u || "").trim();
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST to confirm fix" });
    }

    console.log("Starting fix of Congress bill URLs...");

    // Get all items
    const raw = await redis.zrange(ZSET, 0, -1);
    const items = raw.map(item => {
      try {
        return typeof item === 'string' ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    }).filter(Boolean);

    let fixed = 0;
    const fixedItems = [];

    // Find and fix Congress bills with wrong URL format
    for (let i = 0; i < raw.length; i++) {
      const rawItem = raw[i];
      const item = items[i];

      if (!item) continue;

      // Check if it's a Congress bill with wrong URL format
      if (item.origin === 'congress' && item.link && item.link.includes('-bill/')) {
        // Extract bill type and number from URL
        // Example: https://www.congress.gov/bill/119th-congress/sres-bill/444
        const match = item.link.match(/\/bill\/(\d+)th-congress\/([a-z]+)-bill\/(\d+)/i);

        if (match) {
          const [, congress, type, number] = match;
          const urlType = typeMap[type.toLowerCase()];

          if (urlType) {
            const newUrl = `https://www.congress.gov/bill/${congress}th-congress/${urlType}/${number}`;

            console.log(`Fixing: ${item.title}`);
            console.log(`  Old URL: ${item.link}`);
            console.log(`  New URL: ${newUrl}`);

            // Remove old entry
            await redis.zrem(ZSET, rawItem);

            // Remove old canonical URLs
            const oldCanon = normalizeUrl(item.link);
            await redis.srem(SEEN_LINK, oldCanon);
            await redis.srem(SEEN_LINK, item.link);

            // Update item with new URL
            item.link = newUrl;
            item.canon = normalizeUrl(newUrl);

            // Re-add with new URL
            await redis.zadd(ZSET, {
              score: item.published_ts || Math.floor(Date.now() / 1000),
              member: JSON.stringify(item)
            });

            // Add new canonical URL
            await redis.sadd(SEEN_LINK, item.canon);

            fixed++;
            fixedItems.push({
              id: item.id,
              title: item.title,
              old_url: oldCanon,
              new_url: newUrl
            });
          }
        }
      }
    }

    console.log(`Fix complete: updated ${fixed} Congress bills`);

    res.status(200).json({
      ok: true,
      message: `Fixed ${fixed} Congress bills with incorrect URL format`,
      fixed_count: fixed,
      fixed_items: fixedItems,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error("Fix error:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
