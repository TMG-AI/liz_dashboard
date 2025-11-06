// /api/meltwater_summary.js
// Returns only Meltwater articles with searchid 27864701 (AI Digest for Lawyers)
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

export default async function handler(req, res) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;
    const weekAgo = now - 7 * 24 * 60 * 60;
    const monthAgo = now - 30 * 24 * 60 * 60;

    // Get all mentions from past month
    const raw = await redis.zrange(ZSET, monthAgo, now, { byScore: true });
    const allMentions = raw.map(toObj).filter(Boolean);

    // Filter for Meltwater origin AND searchid 27864701
    const meltwaterMentions = allMentions.filter(m =>
      (m.origin === 'meltwater' || m.section === 'Meltwater') &&
      (m.searchid === '27864701' || m.search_id === '27864701')
    );

    console.log(`Meltwater summary: ${meltwaterMentions.length} articles with searchid 27864701`);

    // Sort by published timestamp (newest first)
    meltwaterMentions.sort((a, b) => (b.published_ts || 0) - (a.published_ts || 0));

    // Calculate time window counts
    const last24h = meltwaterMentions.filter(m => (m.published_ts || 0) >= dayAgo).length;
    const last7d = meltwaterMentions.filter(m => (m.published_ts || 0) >= weekAgo).length;
    const last30d = meltwaterMentions.length;

    res.status(200).json({
      ok: true,
      total: meltwaterMentions.length,
      last24h,
      last7d,
      last30d,
      mentions: meltwaterMentions,
      generated_at: new Date().toISOString(),
      searchid: '27864701'
    });
  } catch (e) {
    console.error('Meltwater summary error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
