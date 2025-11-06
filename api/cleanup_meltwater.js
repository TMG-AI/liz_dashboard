import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_LINK = "mentions:seen:canon";
const SEEN_ID = "mentions:seen";

const CORRECT_SEARCH_ID = "27864701"; // AI Digest for Lawyers

export default async function handler(req, res) {
  try {
    // Get articles from last 30 days
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

    const allArticles = await redis.zrange(ZSET, thirtyDaysAgo, now, { byScore: true });

    let scanned = 0;
    let removed = 0;
    let meltwaterCount = 0;
    const toRemove = [];
    const urlsToRemove = [];
    const idsToRemove = [];
    const wrongSearchIds = {};

    for (const articleData of allArticles) {
      scanned++;
      let article;

      // Handle both objects and JSON strings
      if (typeof articleData === 'object' && articleData !== null) {
        article = articleData;
      } else {
        try {
          article = JSON.parse(articleData);
        } catch {
          continue;
        }
      }

      // Only check Meltwater articles
      const origin = (article.origin || "").toLowerCase();
      if (origin !== "meltwater") {
        continue;
      }

      meltwaterCount++;

      // Check search ID
      const searchId = article.searchid || article.search_id;

      // Remove if wrong search ID OR no search ID
      if (!searchId || searchId !== CORRECT_SEARCH_ID) {
        const wrongId = searchId || "no_searchid";
        wrongSearchIds[wrongId] = (wrongSearchIds[wrongId] || 0) + 1;

        toRemove.push(JSON.stringify(article));
        if (article.canon) urlsToRemove.push(article.canon);
        if (article.id) idsToRemove.push(article.id);
        removed++;
      }
    }

    // Remove articles from sorted set
    if (toRemove.length > 0) {
      for (let i = 0; i < toRemove.length; i += 100) {
        const batch = toRemove.slice(i, i + 100);
        await redis.zrem(ZSET, ...batch);
      }
    }

    // Remove from seen sets
    if (urlsToRemove.length > 0) {
      for (let i = 0; i < urlsToRemove.length; i += 100) {
        const batch = urlsToRemove.slice(i, i + 100);
        await redis.srem(SEEN_LINK, ...batch);
      }
    }

    if (idsToRemove.length > 0) {
      for (let i = 0; i < idsToRemove.length; i += 100) {
        const batch = idsToRemove.slice(i, i + 100);
        await redis.srem(SEEN_ID, ...batch);
      }
    }

    res.status(200).json({
      ok: true,
      scanned,
      meltwaterCount,
      removed,
      kept: meltwaterCount - removed,
      wrongSearchIds,
      message: `Removed ${removed} Meltwater articles with wrong search ID from ${meltwaterCount} total Meltwater articles`,
      correctSearchId: CORRECT_SEARCH_ID
    });

  } catch (e) {
    console.error('Meltwater cleanup error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
