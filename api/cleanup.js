// /api/cleanup.js
// One-time cleanup tool to remove "Untitled" articles and articles with invalid summaries
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const STREAM_ZSET = "mentions:streamed:z";

function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id) return x;
  try { return JSON.parse(String(x)); } catch { return null; }
}

function shouldRemove(mention) {
  // Remove if:
  // 1. Title is "Untitled" or similar
  // 2. Source is "[object Object]"
  // 3. Summary is an object but has no useful text (opening_text, byline, content all null/empty)

  const hasInvalidTitle = !mention.title ||
    mention.title === 'Untitled' ||
    mention.title === 'untitled' ||
    mention.title.trim() === '';

  const hasInvalidSource = !mention.source ||
    mention.source === '[object Object]' ||
    (typeof mention.source === 'string' && mention.source.includes('[object')) ||
    (typeof mention.source === 'string' && mention.source.trim() === '') ||
    typeof mention.source !== 'string';

  const hasInvalidSummary = mention.summary &&
    typeof mention.summary === 'object' &&
    (!mention.summary.opening_text || mention.summary.opening_text === null) &&
    (!mention.summary.byline || mention.summary.byline === null) &&
    (!mention.summary.content || mention.summary.content === null) &&
    (!mention.summary.description || mention.summary.description === null);

  // Only remove if it's a Meltwater article (don't touch RSS feeds)
  const isMeltwater = mention.origin === 'meltwater' ||
    mention.section === 'Meltwater' ||
    (Array.isArray(mention.matched) && mention.matched.includes('meltwater-alert'));

  return isMeltwater && (hasInvalidTitle || hasInvalidSource || hasInvalidSummary);
}

export default async function handler(req, res) {
  try {
    // Safety check - only allow GET requests to prevent accidental runs
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed - use GET' });
    }

    // Get confirmation parameter to prevent accidental cleanup
    const confirm = req.query.confirm === 'yes';
    if (!confirm) {
      return res.status(200).json({
        error: 'Add ?confirm=yes to run cleanup',
        warning: 'This will permanently remove broken articles from Redis',
        example: 'Visit: /api/cleanup?confirm=yes'
      });
    }

    console.log('Starting cleanup of invalid articles...');

    // Fetch all mentions from main set
    const raw = await redis.zrange(ZSET, 0, -1);
    const allMentions = raw.map(toObj).filter(Boolean);

    console.log(`Found ${allMentions.length} total mentions`);

    // Find mentions to remove
    const toRemove = [];
    const toKeep = [];

    for (const mention of allMentions) {
      if (shouldRemove(mention)) {
        toRemove.push(mention);
      } else {
        toKeep.push(mention);
      }
    }

    console.log(`Identified ${toRemove.length} mentions to remove, ${toKeep.length} to keep`);

    // Remove invalid mentions from main set
    let removed = 0;
    for (const mention of toRemove) {
      try {
        const result = await redis.zrem(ZSET, JSON.stringify(mention));
        if (result === 1) removed++;
      } catch (error) {
        console.error('Error removing mention:', mention.id, error);
      }
    }

    // Also clean up the streamed set
    const rawStreamed = await redis.zrange(STREAM_ZSET, 0, -1);
    const streamedMentions = rawStreamed.map(toObj).filter(Boolean);

    let removedStreamed = 0;
    for (const mention of streamedMentions) {
      if (shouldRemove(mention)) {
        try {
          const result = await redis.zrem(STREAM_ZSET, JSON.stringify(mention));
          if (result === 1) removedStreamed++;
        } catch (error) {
          console.error('Error removing streamed mention:', mention.id, error);
        }
      }
    }

    // Clear any corrupted cache as well
    const cacheKeys = [
      'meltwater:api:count:today',
      'meltwater:api:count:24h',
      'meltwater:api:count:today:ratelimited',
      'meltwater:api:count:24h:ratelimited'
    ];

    let clearedCaches = 0;
    for (const key of cacheKeys) {
      try {
        const result = await redis.del(key);
        if (result === 1) clearedCaches++;
      } catch (error) {
        console.error('Error clearing cache:', key, error);
      }
    }

    console.log(`Cleanup complete: removed ${removed} main mentions, ${removedStreamed} streamed mentions, cleared ${clearedCaches} caches`);

    res.status(200).json({
      ok: true,
      cleanup_summary: {
        total_examined: allMentions.length,
        removed_from_main: removed,
        removed_from_stream: removedStreamed,
        remaining: allMentions.length - removed,
        cleared_caches: clearedCaches
      },
      message: 'Cleanup completed successfully',
      next_steps: [
        'New Meltwater webhooks will now use improved title/summary extraction',
        'Refresh your dashboard to see clean results',
        'RSS collection has been disabled (RSS_FEEDS env var removed)'
      ],
      removed_examples: toRemove.slice(0, 5).map(m => ({
        id: m.id,
        title: m.title,
        source: m.source,
        reason: shouldRemove(m) ? 'Invalid title, source, or summary' : 'Unknown'
      }))
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Cleanup failed - check logs'
    });
  }
}