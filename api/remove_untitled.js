// /api/remove_untitled.js
// Remove Meltwater articles with "Untitled" title or missing summaries
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
  // Only process Meltwater articles
  const isMeltwater = 
    mention.origin === 'meltwater' ||
    mention.section === 'Meltwater' ||
    (mention.id && mention.id.startsWith('mw_'));
  
  if (!isMeltwater) return false;

  // Remove if title is "Untitled"
  const hasInvalidTitle = 
    !mention.title ||
    mention.title === 'Untitled' ||
    mention.title === 'untitled' ||
    mention.title.trim() === '';

  // Remove if summary is an object or missing
  const hasInvalidSummary = 
    !mention.summary ||
    (typeof mention.summary === 'object') ||
    (typeof mention.summary === 'string' && mention.summary.trim() === '');

  return hasInvalidTitle || hasInvalidSummary;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Use GET' });
    }

    // Safety check - require confirmation
    const confirm = req.query.confirm === 'yes';
    
    if (!confirm) {
      // Preview mode - show what would be removed
      const raw = await redis.zrange(ZSET, 0, -1);
      const allMentions = raw.map(toObj).filter(Boolean);
      
      const toRemove = allMentions.filter(shouldRemove);
      const toKeep = allMentions.filter(m => !shouldRemove(m));
      
      // Categorize what will be removed
      const meltwaterTotal = allMentions.filter(m => 
        m.origin === 'meltwater' || m.section === 'Meltwater'
      ).length;
      
      const untitledCount = toRemove.filter(m => 
        !m.title || m.title === 'Untitled'
      ).length;
      
      const noSummaryCount = toRemove.filter(m => 
        !m.summary || typeof m.summary === 'object'
      ).length;

      return res.status(200).json({
        preview: true,
        warning: 'Add ?confirm=yes to actually remove these articles',
        stats: {
          total_articles: allMentions.length,
          total_meltwater: meltwaterTotal,
          to_remove: toRemove.length,
          to_keep: toKeep.length,
          untitled: untitledCount,
          missing_summary: noSummaryCount
        },
        sample_to_remove: toRemove.slice(0, 5).map(m => ({
          id: m.id,
          title: m.title || '(no title)',
          source: m.source,
          has_summary: !!m.summary,
          summary_type: typeof m.summary,
          published: m.published
        })),
        sample_to_keep: toKeep.filter(m => 
          m.origin === 'meltwater' || m.section === 'Meltwater'
        ).slice(0, 3).map(m => ({
          id: m.id,
          title: m.title,
          source: m.source,
          has_summary: !!m.summary
        })),
        instruction: 'Visit /api/remove_untitled?confirm=yes to proceed'
      });
    }

    // Confirmed - actually remove the articles
    console.log('Starting removal of Untitled Meltwater articles...');

    const raw = await redis.zrange(ZSET, 0, -1);
    const allMentions = raw.map(toObj).filter(Boolean);
    
    const toRemove = allMentions.filter(shouldRemove);
    
    console.log(`Found ${toRemove.length} articles to remove`);

    let removedFromMain = 0;
    let removedFromStream = 0;

    // Remove from main set
    for (const mention of toRemove) {
      try {
        const result = await redis.zrem(ZSET, JSON.stringify(mention));
        if (result === 1) removedFromMain++;
      } catch (error) {
        console.error('Error removing from main set:', mention.id, error);
      }
    }

    // Also remove from streamed set
    const rawStreamed = await redis.zrange(STREAM_ZSET, 0, -1);
    const streamedMentions = rawStreamed.map(toObj).filter(Boolean);

    for (const mention of streamedMentions) {
      if (shouldRemove(mention)) {
        try {
          const result = await redis.zrem(STREAM_ZSET, JSON.stringify(mention));
          if (result === 1) removedFromStream++;
        } catch (error) {
          console.error('Error removing from stream set:', mention.id, error);
        }
      }
    }

    console.log(`Removal complete: ${removedFromMain} from main, ${removedFromStream} from stream`);

    res.status(200).json({
      ok: true,
      removed: {
        from_main_set: removedFromMain,
        from_stream_set: removedFromStream,
        total: removedFromMain + removedFromStream
      },
      remaining_articles: allMentions.length - removedFromMain,
      message: 'Untitled Meltwater articles removed successfully',
      next_steps: [
        'New Meltwater webhooks will now have proper titles and summaries',
        'Refresh your dashboard to see the cleaned data',
        'Old articles with proper titles have been kept'
      ]
    });

  } catch (error) {
    console.error('Removal error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
