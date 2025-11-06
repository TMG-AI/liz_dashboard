// /api/newsletter_rss_collect.js
// Collects newsletter RSS feeds and filters for AI/legal keywords
import { Redis } from "@upstash/redis";
import Parser from "rss-parser";
import { isBlockedDomain, extractDomain } from "./blocked_domains.js";
import { isInternationalArticle, getBlockReason } from "./international_filter.js";

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

// Newsletter-specific keywords (AI focus only)
const AI_KEYWORDS = [
  "artificial intelligence",
  "generative ai",
  "ai",
  "chatgpt",
  "claude",
  "microsoft copilot",
  "copilot",
  "harvey",
  "harvey ai",
  "cocounsel",
  "lexis+ ai",
  "westlaw precision ai",
  "machine learning",
  "large language model",
  "llm"
];

// Parse feeds from environment variable (comma or semicolon separated)
const NEWSLETTER_RSS_FEEDS = (process.env.NEWSLETTER_RSS_FEEDS || "")
  .split(/[,;]/)
  .map(s => s.trim())
  .filter(Boolean);

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
  return h || (fallback || "");
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

function matchesAIKeywords(text) {
  const t = (text || "").toLowerCase();
  const matched = [];

  for (const keyword of AI_KEYWORDS) {
    // Use word boundary regex to avoid false positives like "China" matching "ai"
    // Escape special regex characters in the keyword
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedKeyword}\\b`, 'i');

    if (regex.test(text)) {
      matched.push(keyword);
    }
  }

  return matched;
}

function idFromCanonical(c) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return `newsletter_rss_${h.toString(16)}`;
}

function toEpoch(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

// Filter out press releases
function isPressRelease(title, summary, source) {
  const text = `${title} ${summary} ${source}`.toLowerCase();
  const pressReleaseKeywords = [
    'prnewswire', 'pr newswire', 'business wire', 'businesswire',
    'pr web', 'prweb', 'globenewswire', 'globe newswire',
    'accesswire', 'press release', 'news release'
  ];
  return pressReleaseKeywords.some(keyword => text.includes(keyword));
}

export default async function handler(req, res) {
  try {
    let found = 0, stored = 0, skipped = 0, errors = [];

    // Check if newsletter RSS feeds are configured
    if (!NEWSLETTER_RSS_FEEDS.length) {
      console.log('NEWSLETTER_RSS_FEEDS not configured - skipping newsletter RSS collection');
      return res.status(200).json({
        ok: true,
        message: "Newsletter RSS collection disabled - no feeds configured",
        found: 0,
        stored: 0,
        skipped: 0,
        errors: [],
        disabled: true,
        generated_at: new Date().toISOString()
      });
    }

    console.log(`Newsletter RSS collection starting: ${NEWSLETTER_RSS_FEEDS.length} feeds, filtering for AI keywords`);

    for (const url of NEWSLETTER_RSS_FEEDS) {
      try {
        const feed = await parser.parseURL(url);
        const feedTitle = feed?.title || url;

        for (const e of feed?.items || []) {
          const title = (e.title || "").trim();
          const sum = e.contentSnippet || e.content || e.summary || e.description || "";
          const link = extractItemLink(e);

          // Filter out press releases FIRST
          if (isPressRelease(title, sum, feedTitle)) {
            console.log(`[Newsletter RSS] Skipping press release: "${title}" from ${feedTitle}`);
            skipped++;
            continue;
          }

          // Filter out blocked domains (MFA sites)
          if (isBlockedDomain(link)) {
            console.log(`[Newsletter RSS] Skipping blocked domain: "${title}" from ${extractDomain(link)}`);
            skipped++;
            continue;
          }

          // Filter out international articles
          if (isInternationalArticle(title, sum, link, feedTitle)) {
            console.log(`[Newsletter RSS] Skipping international: "${title}" - ${getBlockReason(title, sum, link, feedTitle)}`);
            skipped++;
            continue;
          }

          // Filter for AI keywords in title or content
          const matched = matchesAIKeywords(`${title}\n${sum}\n${feedTitle}`);

          if (!matched.length) {
            skipped++;
            continue; // Skip articles without AI keywords
          }

          found++;

          // Handle articles without links
          let canon;
          let finalLink;

          if (!link || link === "#" || link.trim() === "") {
            // Generate unique ID for newsletter articles without links
            const ts = toEpoch(e.isoDate || e.pubDate || e.published || e.updated);
            const uniqueStr = `${title}_${feedTitle}_${ts}`;
            let h = 0;
            for (let i = 0; i < uniqueStr.length; i++) h = (h * 31 + uniqueStr.charCodeAt(i)) >>> 0;
            canon = `newsletter_rss_${h.toString(16)}`;
            finalLink = `https://newsletter.internal/${normalizeHost(feedTitle).replace(/\s+/g, '-')}/${canon}`;
          } else {
            canon = normalizeUrl(link);
            finalLink = link;
          }

          // Deduplicate by canonical URL/ID
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
            section: "Newsletter",
            title: title || "(untitled)",
            link: finalLink,
            source: feedTitle, // Use newsletter name directly as source
            provider: feedTitle,
            summary: sum,
            origin: "newsletter", // Use consistent "newsletter" origin (not "newsletter_rss")
            published_ts: ts,
            published: new Date(ts * 1000).toISOString(),
            reach: 0,
            newsletter_article: !link || link.trim() === "" // Flag for articles without individual URLs
          };

          await redis.zadd(ZSET, { score: ts, member: JSON.stringify(m) });

          // Trim articles older than RETENTION_DAYS
          const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
          await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

          stored++;
          console.log(`[Newsletter RSS] Stored: "${title}" from ${feedTitle} (matched: ${matched.join(", ")})`);
        }
      } catch (err) {
        console.error(`Error fetching ${url}:`, err);
        errors.push({ url, error: err?.message || String(err) });
      }
    }

    console.log(`Newsletter RSS collection complete: ${found} AI articles found, ${stored} stored, ${skipped} skipped`);

    res.status(200).json({
      ok: true,
      feeds: NEWSLETTER_RSS_FEEDS.length,
      found,
      stored,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('Newsletter RSS collection error:', e);
    res.status(500).json({
      ok: false,
      error: `Newsletter RSS collection failed: ${e?.message || e}`
    });
  }
}
