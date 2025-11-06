// /api/restore.js
// Restore and fix Meltwater articles that were incorrectly removed
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

function fixMention(mention) {
  // Fix title extraction - get real title from summary.title if main title is "Untitled"
  let fixedTitle = mention.title;
  if (!fixedTitle || fixedTitle === 'Untitled' || fixedTitle === 'untitled') {
    if (mention.summary && typeof mention.summary === 'object' && mention.summary.title) {
      fixedTitle = mention.summary.title;
    }
  }

  // Fix summary extraction - convert object summary to text
  let fixedSummary = mention.summary;
  if (mention.summary && typeof mention.summary === 'object') {
    fixedSummary = mention.summary.opening_text ||
                   mention.summary.byline ||
                   mention.summary.content ||
                   mention.summary.description ||
                   '';
  }

  // Fix source if it's an object
  let fixedSource = mention.source;
  if (typeof mention.source !== 'string') {
    fixedSource = 'Meltwater';
  }

  return {
    ...mention,
    title: fixedTitle || 'Untitled',
    summary: fixedSummary || '',
    source: fixedSource
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed - use GET' });
    }

    const confirm = req.query.confirm === 'yes';
    if (!confirm) {
      return res.status(200).json({
        message: 'Add ?confirm=yes to restore and fix broken articles',
        warning: 'This will restore Meltwater articles from stream set and fix their titles/summaries',
        example: 'Visit: /api/restore?confirm=yes'
      });
    }

    console.log('Starting restoration of Meltwater articles...');

    // Get articles from the streamed set that might have been removed
    const rawStreamed = await redis.zrange(STREAM_ZSET, 0, -1);
    const streamedMentions = rawStreamed.map(toObj).filter(Boolean);

    console.log(`Found ${streamedMentions.length} streamed articles`);

    // Get current main set to avoid duplicates
    const rawMain = await redis.zrange(ZSET, 0, -1);
    const mainMentions = rawMain.map(toObj).filter(Boolean);
    const mainIds = new Set(mainMentions.map(m => m.id));

    console.log(`Found ${mainMentions.length} articles in main set`);

    // Find streamed articles that are NOT in main set (were deleted)
    const toRestore = streamedMentions.filter(m => !mainIds.has(m.id));

    console.log(`Found ${toRestore.length} articles to potentially restore`);

    let restored = 0;
    const restoredArticles = [];

    for (const mention of toRestore) {
      try {
        // Fix the article
        const fixed = fixMention(mention);

        // Only restore if it's actually a legitimate article (has a proper title now)
        if (fixed.title && fixed.title !== 'Untitled' && fixed.title.length > 3) {
          // Add back to main set with original timestamp
          await redis.zadd(ZSET, {
            score: mention.published_ts || Math.floor(Date.now() / 1000),
            member: JSON.stringify(fixed)
          });

          restored++;
          restoredArticles.push({
            id: fixed.id,
            title: fixed.title,
            source: fixed.source,
            link: fixed.link,
            original_title: mention.title,
            has_summary: !!fixed.summary
          });

          console.log(`Restored: ${fixed.title}`);
        }
      } catch (error) {
        console.error('Error restoring article:', mention.id, error);
      }
    }

    console.log(`Restoration complete: restored ${restored} articles`);

    res.status(200).json({
      ok: true,
      restoration_summary: {
        total_streamed: streamedMentions.length,
        total_main_before: mainMentions.length,
        candidates_for_restore: toRestore.length,
        actually_restored: restored
      },
      restored_articles: restoredArticles,
      message: `Successfully restored ${restored} legitimate articles with proper titles`,
      next_steps: [
        'Refresh your dashboard to see the restored articles',
        'New Meltwater webhooks will use improved extraction to prevent this issue'
      ]
    });

  } catch (error) {
    console.error('Restoration error:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      message: 'Restoration failed - check logs'
    });
  }
}