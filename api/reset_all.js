// DANGER: Clears ALL data from Redis - complete reset
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

export default async function handler(req, res) {
  try {
    // Only allow POST requests for safety
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Use POST to confirm reset"
      });
    }

    console.log("RESET: Starting complete Redis cleanup...");

    // Delete all mention-related keys
    const keysToDelete = [
      "mentions:z",                    // Main sorted set
      "mentions:seen",                 // Seen IDs
      "mentions:seen:canon",           // Canonical URLs
      "mentions:streamed:z",           // Meltwater streaming
      "meltwater:last_stream_time",   // Meltwater timestamp
    ];

    const results = {};

    for (const key of keysToDelete) {
      try {
        const deleted = await redis.del(key);
        results[key] = deleted > 0 ? "deleted" : "not_found";
        console.log(`RESET: ${key} - ${results[key]}`);
      } catch (e) {
        results[key] = `error: ${e.message}`;
        console.error(`RESET: Failed to delete ${key}:`, e);
      }
    }

    // Also clear any meltwater cache keys
    try {
      const meltwaterKeys = await redis.keys("meltwater:*");
      console.log(`RESET: Found ${meltwaterKeys.length} meltwater cache keys`);

      for (const key of meltwaterKeys) {
        await redis.del(key);
        results[key] = "deleted";
      }
    } catch (e) {
      console.log("RESET: Could not scan for meltwater keys:", e.message);
    }

    // Verify cleanup
    const finalCount = await redis.zcard("mentions:z");
    const seenCount = await redis.scard("mentions:seen:canon");

    res.status(200).json({
      ok: true,
      message: "Redis completely reset - all data cleared",
      deleted_keys: results,
      verification: {
        mentions_remaining: finalCount,
        seen_urls_remaining: seenCount,
        note: "Both should be 0 for a clean reset"
      },
      next_steps: [
        "1. Visit /api/collect to fetch new Google Alerts",
        "2. Visit /api/congress_collect to fetch new Congress bills",
        "3. Refresh dashboard - should show only new data"
      ],
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error("RESET ERROR:", e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
