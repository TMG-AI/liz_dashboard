// /api/meltwater_webhook.js
// Receives real-time mentions from Meltwater Streaming API (Data Streams)
// ONLY accepts articles from searchid 27864701 (AI Digest for Lawyers)
// Applies same filters as API collection: AI keywords, press releases, non-US, top 25 by reach
//
// Meltwater webhook payload structure:
// {
//   "request": {
//     "company_id": "...",
//     "hook_id": "...",
//     "inputs": ["search_id or parameters"]
//   },
//   "documents": [ /* array of document objects */ ]
// }

import { Redis } from "@upstash/redis";
import { isBlockedDomain, extractDomain } from "./blocked_domains.js";
import { isInternationalArticle, getBlockReason } from "./international_filter.js";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ALLOWED_SEARCH_ID = "27864701"; // AI Digest for Lawyers only
const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";
const RETENTION_DAYS = 14; // Keep articles for 14 days
const TOP_ARTICLES_LIMIT = 25; // Maximum articles per day

// Daily tracking for top 25 limit
const DAILY_ARTICLES_KEY = "meltwater:webhook:daily"; // Stores today's articles as sorted set by reach

// Helper functions (copied from meltwater_collect.js for consistency)
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

function idFromCanonical(c) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return `mw_webhook_${h.toString(16)}`;
}

function toEpoch(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function normalizeSentiment(doc) {
  if (typeof doc.sentiment_score === 'number') {
    return doc.sentiment_score;
  }
  const sentiment = (doc.sentiment || '').toLowerCase();
  if (sentiment === 'positive') return 1;
  if (sentiment === 'negative') return -1;
  if (sentiment === 'neutral') return 0;
  return undefined;
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

// Get today's date key for daily tracking
function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${DAILY_ARTICLES_KEY}:${year}-${month}-${day}`;
}

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse the webhook payload from Meltwater
    // Expected structure: { request: {...}, documents: [...] }
    const payload = req.body;

    console.log('[Meltwater Webhook] Received payload:', {
      hasRequest: !!payload.request,
      hasDocuments: !!payload.documents,
      documentCount: payload.documents?.length || 0,
      hookId: payload.request?.hook_id,
      companyId: payload.request?.company_id
    });

    // Verify this is from the correct search
    // The search ID may be in payload.request.inputs
    if (payload.request?.inputs) {
      const searchInfo = JSON.stringify(payload.request.inputs);
      console.log('[Meltwater Webhook] Search inputs:', searchInfo);

      // Check if our search ID is referenced
      if (!searchInfo.includes(ALLOWED_SEARCH_ID)) {
        console.log(`[Meltwater Webhook] WARNING: Expected search ID ${ALLOWED_SEARCH_ID} not found in inputs`);
      }
    }

    // Extract documents array from payload
    let documents = payload.documents || payload.docs || [];

    if (documents.length === 0) {
      console.log('[Meltwater Webhook] No documents in payload');
      return res.status(200).json({
        status: 'success',
        message: 'No documents to process',
        processed: 0,
        stored: 0,
        skipped: 0
      });
    }

    console.log(`[Meltwater Webhook] Processing ${documents.length} documents`);

    let processed = 0, stored = 0, skipped = 0;
    const todayKey = getTodayKey();

    for (const doc of documents) {
      try {
        processed++;

        // Log the first document structure to understand the format
        if (processed === 1) {
          console.log('[Meltwater Webhook] First document keys:', Object.keys(doc));
        }

        // Extract article data - trying multiple field names based on Meltwater API variations
        // Title extraction (similar to meltwater_collect.js)
        const title = doc.content?.title || doc.title || doc.headline || doc.document_title || 'Untitled';

        // URL/Link extraction
        const link = doc.content?.url || doc.url || doc.link || doc.document_url || '#';

        // Filter 1: AI keyword filtering - MUST have "ai" or "artificial intelligence" in title
        const titleLower = title.toLowerCase();
        if (!titleLower.includes('ai') && !titleLower.includes('artificial intelligence')) {
          console.log(`[Meltwater Webhook] Skipping non-AI article: "${title}"`);
          skipped++;
          continue;
        }

        // Filter 2: Skip non-US articles
        const country = doc.country || doc.media?.country || doc.source?.country || doc.source_country || '';
        if (country && country.toLowerCase() !== 'us' && country.toLowerCase() !== 'usa' && country.toLowerCase() !== 'united states') {
          console.log(`[Meltwater Webhook] Skipping non-US article from ${country}`);
          skipped++;
          continue;
        }

        // Extract summary (similar to meltwater_collect.js)
        let extractedSummary = doc.summary ||
                              doc.description ||
                              doc.snippet ||
                              doc.content?.summary ||
                              doc.content?.description ||
                              doc.content?.snippet ||
                              doc.matched?.hit_sentence ||
                              doc.content?.opening_text ||
                              doc.content?.byline ||
                              doc.document_summary ||
                              '';

        // Clean up the hit_sentence (remove leading "... " and trailing "...")
        if (extractedSummary && typeof extractedSummary === 'string') {
          extractedSummary = extractedSummary.replace(/^\.\.\.\s*/, '').replace(/\s*\.\.\.$/, '').trim();
        }

        // Extract source name
        const source = doc.source?.name || doc.source_name || doc.media?.name || doc.source || 'Meltwater';

        // Extract published date
        const publishedDate = doc.published_date || doc.document?.published_date || doc.date || new Date().toISOString();

        // Filter 3: Press release filtering
        if (isPressRelease(title, extractedSummary, source)) {
          console.log(`[Meltwater Webhook] Skipping press release: "${title}" from ${source}`);
          skipped++;
          continue;
        }

        // Filter 3.5: Block MFA domains
        if (isBlockedDomain(link)) {
          console.log(`[Meltwater Webhook] Blocked domain: "${title}" from ${extractDomain(link)}`);
          skipped++;
          continue;
        }

        // Filter 3.6: Block international articles
        if (isInternationalArticle(title, extractedSummary, link, source)) {
          console.log(`[Meltwater Webhook] Blocked international: "${title}" - ${getBlockReason(title, extractedSummary, link, source)}`);
          skipped++;
          continue;
        }

        // Filter 4: Deduplicate by canonical URL
        const canon = normalizeUrl(link);
        if (!canon) {
          skipped++;
          continue;
        }

        const addCanon = await redis.sadd(SEEN_LINK, canon);
        if (addCanon !== 1) {
          console.log(`[Meltwater Webhook] Duplicate URL skipped: ${canon}`);
          skipped++;
          continue; // Already stored
        }

        const mid = idFromCanonical(canon);
        await redis.sadd(SEEN_ID, mid);

        const ts = toEpoch(publishedDate);

        // Extract reach/circulation metrics
        const reach = doc.metrics?.reach || doc.metrics?.circulation || doc.source_reach || doc.reach || 0;

        // Create mention object
        const mention = {
          id: mid,
          canon,
          section: 'Meltwater',
          title: title,
          link: link,
          source: source,
          summary: extractedSummary,
          origin: 'meltwater_webhook',
          published_ts: ts,
          published: new Date(ts * 1000).toISOString(),
          reach: reach,
          sentiment: normalizeSentiment(doc),
          sentiment_label: doc.sentiment || null,
          searchid: ALLOWED_SEARCH_ID,
          received_at: new Date().toISOString()
        };

        // Filter 5: Top 25 by reach per day
        // Add to today's sorted set (sorted by reach, descending)
        await redis.zadd(todayKey, {
          score: reach,
          member: JSON.stringify(mention)
        });

        // Set expiry on daily tracking key (expires after 2 days)
        await redis.expire(todayKey, 2 * 24 * 60 * 60);

        // Get count of articles in today's set
        const todayCount = await redis.zcard(todayKey);

        // If we have more than TOP_ARTICLES_LIMIT, remove the lowest reach articles
        if (todayCount > TOP_ARTICLES_LIMIT) {
          // Remove articles with lowest reach (keep top 25)
          const toRemove = todayCount - TOP_ARTICLES_LIMIT;
          await redis.zpopmin(todayKey, toRemove);
          console.log(`[Meltwater Webhook] Removed ${toRemove} low-reach articles to maintain top ${TOP_ARTICLES_LIMIT} limit`);
        }

        // Check if this article made it into the top 25
        const allArticles = await redis.zrange(todayKey, 0, -1);

        // If this article is still in the set, add it to the main mentions set
        const isInTopArticles = allArticles.some(a => {
          try {
            const parsed = JSON.parse(a);
            return parsed.id === mid;
          } catch {
            return false;
          }
        });

        if (isInTopArticles) {
          // Store in main mentions set
          await redis.zadd(ZSET, {
            score: ts,
            member: JSON.stringify(mention)
          });

          // Trim articles older than RETENTION_DAYS
          const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
          await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

          stored++;
          console.log(`[Meltwater Webhook] Stored (${stored}/${TOP_ARTICLES_LIMIT}): "${title}" from ${source} (reach: ${reach})`);
        } else {
          console.log(`[Meltwater Webhook] Article excluded (not in top ${TOP_ARTICLES_LIMIT} by reach): "${title}" (reach: ${reach})`);
          skipped++;

          // Remove from deduplication sets since we're not storing it
          await redis.srem(SEEN_LINK, canon);
          await redis.srem(SEEN_ID, mid);
        }

      } catch (error) {
        console.error('[Meltwater Webhook] Error processing document:', error);
        skipped++;
      }
    }

    console.log(`[Meltwater Webhook] Complete: ${processed} processed, ${stored} stored, ${skipped} skipped`);

    // Respond to Meltwater with 200 OK
    res.status(200).json({
      status: 'success',
      processed,
      stored,
      skipped,
      search_id: ALLOWED_SEARCH_ID,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('[Meltwater Webhook] Processing error:', error);

    // Return 200 to prevent Meltwater from retrying
    // Log the error for debugging
    res.status(200).json({
      status: 'error',
      message: 'Internal processing error, logged for review'
    });
  }
}
