// /api/law360_collect.js
// Collects Law360 RSS feed articles separately
import { Redis } from "@upstash/redis";
import Parser from "rss-parser";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN
});

const parser = new Parser({
  customFields: {
    item: [
      ['media:group', 'media', { keepArray: false }],
      ['media:description', 'mediaDescription'],
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumb', { keepArray: false }],
    ]
  },
  requestOptions: {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    },
    timeout: 10000
  }
});

const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";
const RETENTION_DAYS = 14; // Keep articles for 14 days

// Parse Law360 feed from environment variable
const LAW360_RSS_FEED = (process.env.LAW360_RSS_FEED || "").trim();

// Helper functions
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
     "mc_cid","mc_eid","ref","fbclid","gclid","igshid"].forEach(p => url.searchParams.delete(p));
    if ([...url.searchParams.keys()].length === 0) url.search = "";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (u || "").trim();
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeHost(h) {
  return (h || "").toLowerCase().replace(/^www\./, "").replace(/^amp\./, "");
}

function displaySource(link, fallback) {
  const h = normalizeHost(hostOf(link));
  return h || (fallback || "Law360");
}

function extractItemLink(e) {
  let raw =
    (e.link && typeof e.link === "object" && e.link.href) ? e.link.href :
    (Array.isArray(e.link) && e.link[0]?.href)            ? e.link[0].href :
    (e.links && e.links[0]?.href)                         ? e.links[0].href :
    (typeof e.link === "string" ? e.link : "") ||
    (typeof e.id === "string" ? e.id : "");

  return (raw || "").trim();
}

function idFromCanonical(c) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return `law360_${h.toString(16)}`;
}

function toEpoch(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

export default async function handler(req, res) {
  try {
    let found = 0, stored = 0, skipped = 0, errors = [];

    // Check if Law360 RSS feed is configured
    if (!LAW360_RSS_FEED) {
      console.log('LAW360_RSS_FEED not configured - skipping Law360 collection');
      return res.status(200).json({
        ok: true,
        message: "Law360 collection disabled - no feed configured",
        found: 0,
        stored: 0,
        skipped: 0,
        errors: [],
        disabled: true,
        generated_at: new Date().toISOString()
      });
    }

    console.log(`Law360 RSS collection starting`);

    try {
      const feed = await parser.parseURL(LAW360_RSS_FEED);
      const feedTitle = feed?.title || "Law360";

      for (const e of feed?.items || []) {
        const title = (e.title || "").trim();
        const sum = e.contentSnippet || e.content || e.summary || e.description || "";
        const link = extractItemLink(e);

        if (!link || !title) {
          skipped++;
          continue;
        }

        found++;

        const canon = normalizeUrl(link);
        if (!canon) {
          skipped++;
          continue;
        }

        // Deduplicate by canonical URL
        const addCanon = await redis.sadd(SEEN_LINK, canon);
        if (addCanon !== 1) {
          skipped++;
          continue; // Already stored
        }

        const mid = idFromCanonical(canon);
        await redis.sadd(SEEN_ID, mid);

        const ts = toEpoch(e.isoDate || e.pubDate || e.published || e.updated);

        const m = {
          id: mid,
          canon,
          section: "Law360",
          title: title || "(untitled)",
          link,
          source: "Law360",
          provider: "Law360",
          summary: sum,
          origin: "law360",
          published_ts: ts,
          published: new Date(ts * 1000).toISOString(),
          reach: 0
        };

        await redis.zadd(ZSET, { score: ts, member: JSON.stringify(m) });

        // Trim articles older than RETENTION_DAYS
        const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
        await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

        stored++;
        console.log(`[Law360] Stored: "${title}"`);
      }
    } catch (err) {
      console.error(`Error fetching Law360 feed:`, err);
      errors.push({ url: LAW360_RSS_FEED, error: err?.message || String(err) });
    }

    console.log(`Law360 collection complete: ${found} articles found, ${stored} stored, ${skipped} skipped`);

    res.status(200).json({
      ok: true,
      found,
      stored,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('Law360 collection error:', e);
    res.status(500).json({
      ok: false,
      error: `Law360 collection failed: ${e?.message || e}`
    });
  }
}
