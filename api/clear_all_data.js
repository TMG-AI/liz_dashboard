// Clear all data from Redis
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

// All Redis keys used by the application
const ALL_KEYS = [
  "mentions:z",                    // Main sorted set
  "mentions:seen",                 // Seen IDs set
  "mentions:seen:canon",           // Canonical URLs set
  "mentions:streamed:z",           // Streamed mentions
  "meltwater:stream:daily:*",      // Daily counters (wildcard)
  "meltwater:last_stream_time",    // Last stream time
  "meltwater:api:count:*",         // API count cache (wildcard)
  "flagged_articles:*",            // Flagged articles (wildcard)
  "client_summaries:*",            // Client summaries (wildcard)
];

export default async function handler(req, res) {
  // Require POST with confirmation
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Use POST with ?confirm=YES to clear all data',
      warning: 'This will permanently delete ALL articles, flags, and summaries from Redis'
    });
  }

  const url = new URL(req.url, 'http://localhost');
  const confirm = url.searchParams.get('confirm');

  if (confirm !== 'YES') {
    return res.status(400).json({
      error: 'Add ?confirm=YES to run cleanup',
      warning: 'This will permanently delete ALL articles, flags, and summaries from Redis'
    });
  }

  try {
    console.log('Starting full Redis cleanup...');
    const deleted = [];
    const errors = [];

    // Delete exact keys
    const exactKeys = [
      "mentions:z",
      "mentions:seen",
      "mentions:seen:canon",
      "mentions:streamed:z",
      "meltwater:last_stream_time"
    ];

    for (const key of exactKeys) {
      try {
        await redis.del(key);
        deleted.push(key);
        console.log(`Deleted: ${key}`);
      } catch (error) {
        errors.push({ key, error: error?.message || String(error) });
        console.error(`Error deleting ${key}:`, error);
      }
    }

    // Delete wildcard patterns
    const wildcardPatterns = [
      "meltwater:stream:daily:*",
      "meltwater:api:count:*",
      "flagged_articles:*",
      "client_summaries:*"
    ];

    for (const pattern of wildcardPatterns) {
      try {
        // Get all keys matching pattern
        const keys = await redis.keys(pattern);
        console.log(`Found ${keys.length} keys matching ${pattern}`);

        if (keys.length > 0) {
          // Delete all matching keys
          for (const key of keys) {
            await redis.del(key);
            deleted.push(key);
          }
          console.log(`Deleted ${keys.length} keys matching ${pattern}`);
        }
      } catch (error) {
        errors.push({ pattern, error: error?.message || String(error) });
        console.error(`Error with pattern ${pattern}:`, error);
      }
    }

    console.log(`Cleanup complete: ${deleted.length} keys deleted, ${errors.length} errors`);

    res.status(200).json({
      ok: true,
      deleted_count: deleted.length,
      deleted_keys: deleted,
      errors: errors.length > 0 ? errors : undefined,
      message: 'All data cleared from Redis',
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Cleanup error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
