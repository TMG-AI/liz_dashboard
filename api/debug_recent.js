// Debug endpoint to check recent mentions and their field mapping
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id) return x;
  try { return JSON.parse(String(x)); } catch { return null; }
}

export default async function handler(req, res) {
  try {
    // Get the most recent 20 mentions
    const raw = await redis.zrange(ZSET, 0, 19, { rev: true });
    const items = raw.map(toObj).filter(Boolean);

    // Filter for Meltwater mentions only
    const meltwaterMentions = items.filter(m =>
      m.origin === 'meltwater' ||
      m.section === 'Meltwater' ||
      (Array.isArray(m.matched) && m.matched.includes('meltwater-alert'))
    );

    // Find "Untitled" mentions
    const untitledMentions = meltwaterMentions.filter(m =>
      !m.title ||
      m.title === 'Untitled' ||
      m.title === 'untitled' ||
      m.source === '[object Object]'
    );

    res.status(200).json({
      ok: true,
      total_recent: items.length,
      meltwater_count: meltwaterMentions.length,
      untitled_count: untitledMentions.length,
      recent_meltwater: meltwaterMentions.slice(0, 5).map(m => ({
        id: m.id,
        title: m.title,
        source: m.source,
        link: m.link,
        published: m.published,
        summary: m.summary || 'No summary',
        summary_type: typeof m.summary,
        summary_keys: m.summary && typeof m.summary === 'object' ? Object.keys(m.summary) : null,
        matched: m.matched || []
      })),
      recent_all_sources: items.slice(0, 10).map(m => ({
        id: m.id,
        title: m.title,
        source: m.source,
        origin: m.origin,
        section: m.section,
        summary: m.summary || 'No summary',
        summary_type: typeof m.summary,
        has_summary: !!m.summary,
        published: m.published
      })),
      untitled_examples: untitledMentions.slice(0, 3).map(m => ({
        id: m.id,
        title: m.title,
        source: m.source,
        link: m.link,
        published: m.published,
        full_object: m // Show complete object for debugging
      })),
      generated_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}