// Cleanup endpoint to remove non-US Meltwater articles
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
  } catch { return null; }
}

// Common non-US source indicators
const NON_US_INDICATORS = [
  // UK sources
  'daily mail', 'the guardian', 'the telegraph', 'the independent', 'bbc',
  'sky news', 'metro.co.uk', 'express.co.uk', 'mirror.co.uk',

  // Australian sources
  '.au', 'sydney morning herald', 'australian financial review', 'news.com.au',

  // Canadian sources
  '.ca', 'cbc', 'globe and mail', 'national post',

  // Indian sources
  'times of india', 'hindu', 'ndtv', 'india today', 'zee news',

  // Asian sources
  'south china morning post', 'scmp.com', 'japan times', 'korea herald',
  'straits times', 'bangkok post',

  // European sources
  'le monde', 'der spiegel', 'el pais', 'corriere', 'die welt',

  // Other international
  'al jazeera', 'russia today', 'rt.com', 'sputnik'
];

function isNonUSSource(article) {
  const source = (article.source || '').toLowerCase();
  const link = (article.link || '').toLowerCase();

  return NON_US_INDICATORS.some(indicator =>
    source.includes(indicator) || link.includes(indicator)
  );
}

export default async function handler(req, res) {
  // Require POST with confirmation
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST with ?confirm=YES' });
  }

  const url = new URL(req.url, 'http://localhost');
  const confirm = url.searchParams.get('confirm');

  if (confirm !== 'YES') {
    return res.status(400).json({
      error: 'Add ?confirm=YES to run cleanup',
      warning: 'This will permanently remove non-US Meltwater articles from Redis'
    });
  }

  try {
    console.log('Starting non-US article cleanup...');

    // Get all Meltwater articles
    const raw = await redis.zrange(ZSET, 0, -1);
    const allArticles = raw.map(toObj).filter(Boolean);

    const meltwaterArticles = allArticles.filter(m =>
      m.origin === 'meltwater' || m.section === 'Meltwater'
    );

    console.log(`Found ${meltwaterArticles.length} Meltwater articles`);

    let removed = 0;
    const removedList = [];

    for (const article of meltwaterArticles) {
      if (isNonUSSource(article)) {
        // Remove from Redis
        const articleJson = JSON.stringify(article);
        await redis.zrem(ZSET, articleJson);

        removed++;
        removedList.push({
          id: article.id,
          title: article.title,
          source: article.source,
          link: article.link
        });

        console.log(`Removed non-US article: "${article.title}" from ${article.source}`);
      }
    }

    console.log(`Cleanup complete: ${removed} non-US articles removed`);

    res.status(200).json({
      ok: true,
      total_meltwater: meltwaterArticles.length,
      removed,
      remaining: meltwaterArticles.length - removed,
      removed_articles: removedList
    });

  } catch (e) {
    console.error('Cleanup error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
