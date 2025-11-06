// Analyze what data is actually in Redis
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

export default async function handler(req, res) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    // Get all items from last 7 days
    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

    const items = raw.map(item => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    }).filter(Boolean);

    // Analyze by origin
    const byOrigin = {};
    const byDate = {};
    const bySectionAndOrigin = {};

    items.forEach(m => {
      const origin = m.origin || 'unknown';
      const section = m.section || 'unknown';
      const date = m.published ? m.published.split('T')[0] : 'unknown';

      // Count by origin
      byOrigin[origin] = (byOrigin[origin] || 0) + 1;

      // Count by date
      byDate[date] = (byDate[date] || 0) + 1;

      // Count by section + origin
      const key = `${section} (${origin})`;
      bySectionAndOrigin[key] = (bySectionAndOrigin[key] || 0) + 1;
    });

    // Get sample titles by origin
    const samplesByOrigin = {};
    Object.keys(byOrigin).forEach(origin => {
      samplesByOrigin[origin] = items
        .filter(m => m.origin === origin)
        .slice(0, 5)
        .map(m => ({
          title: m.title?.substring(0, 80),
          published: m.published,
          source: m.source
        }));
    });

    // Sort dates
    const datesSorted = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]));

    res.status(200).json({
      ok: true,
      summary: {
        total_items: items.length,
        date_range: {
          oldest: items.length > 0 ? items[items.length - 1].published : null,
          newest: items.length > 0 ? items[0].published : null
        }
      },
      by_origin: byOrigin,
      by_date: Object.fromEntries(datesSorted),
      by_section_and_origin: bySectionAndOrigin,
      samples_by_origin: samplesByOrigin,
      time_window: {
        from_timestamp: sevenDaysAgo,
        to_timestamp: now,
        from_date: new Date(sevenDaysAgo * 1000).toISOString(),
        to_date: new Date(now * 1000).toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
