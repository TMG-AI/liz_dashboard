// /api/summary.js
// FIXED: Combines historical API count + new streaming webhooks
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const STREAM_ZSET = "mentions:streamed:z";

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `meltwater:stream:daily:${year}-${month}-${day}`;
}

/* --- time windows (ET "today") --- */
function rangeTodayET() {
  const now = new Date();
  const nowET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const startET = new Date(nowET.getFullYear(), nowET.getMonth(), nowET.getDate(), 0, 0, 0, 0);
  const delta = nowET.getTime() - now.getTime();
  const start = Math.floor((startET.getTime() - delta) / 1000);
  const end = start + 24 * 60 * 60;
  return [start, end];
}

function range24h() {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 24 * 60 * 60;
  return [start, end];
}

/* --- helpers --- */
function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id) return x;
  try { return JSON.parse(String(x)); } catch { return null; }
}

function detectOrigin(m) {
  // Check explicit origin field first
  if (m && typeof m.origin === "string" && m.origin && m.origin !== "") {
    return m.origin;
  }

  // Check for Newsletter indicators
  if (
    m?.section === "Newsletter" ||
    (Array.isArray(m?.matched) && m.matched.includes("newsletter")) ||
    (m?.id && m.id.startsWith("newsletter_"))
  ) {
    return "newsletter";
  }

  // Check for Meltwater indicators
  const prov = (m?.provider || "").toLowerCase();
  if (
    prov.includes("meltwater") ||
    m?.section === "Meltwater" ||
    (Array.isArray(m?.matched) && m.matched.includes("meltwater-alert")) ||
    (m?.id && m.id.startsWith("mw_stream_"))
  ) {
    return "meltwater";
  }

  // Check for Congress indicators
  if (
    m?.section === "Congress" ||
    (m?.id && m.id.startsWith("congress_"))
  ) {
    return "congress";
  }

  // Default to google_alerts for all other articles
  return "google_alerts";
}

// Get count of NEW streamed Meltwater mentions
async function getStreamedMeltwaterCount(window) {
  try {
    if (window === "today") {
      // Get today's counter directly from Redis
      const todayKey = getTodayKey();
      const count = await redis.get(todayKey);
      console.log(`Streamed Meltwater count for today: ${count || 0}`);
      return parseInt(count || 0);
    } else {
      // For 24h window, count from the streamed set
      const now = Math.floor(Date.now() / 1000);
      const dayAgo = now - (24 * 60 * 60);
      
      // Get streamed mentions from the last 24 hours
      const streamedMentions = await redis.zrange(
        STREAM_ZSET,
        dayAgo,
        now,
        { byScore: true }
      );
      
      console.log(`Streamed Meltwater count (24h): ${streamedMentions.length}`);
      return streamedMentions.length;
    }
  } catch (error) {
    console.error('Error getting streamed count:', error);
    return 0;
  }
}

// Get HISTORICAL count from Meltwater API (with caching to prevent rate limits)
async function getMeltwaterCountFromAPI(window) {
  const MELTWATER_API_KEY = process.env.MELTWATER_API_KEY;
  const SEARCH_ID = '27864701'; // AI Digest for Lawyers

  if (!MELTWATER_API_KEY) {
    console.log('No Meltwater API key - will count from Redis');
    return { success: false, count: 0 };
  }

  // Check cache first (15 minute cache to prevent rate limiting)
  const cacheKey = `meltwater:api:count:${window}`;
  console.log(`Checking cache with key: ${cacheKey}`);

  try {
    const cached = await redis.get(cacheKey);
    console.log(`Cache result for ${cacheKey}:`, cached ? 'HIT' : 'MISS');

    if (cached) {
      try {
        // Handle case where cache might be an object instead of JSON string
        let cachedData;
        if (typeof cached === 'string') {
          cachedData = JSON.parse(cached);
        } else if (typeof cached === 'object' && cached !== null) {
          cachedData = cached; // Already an object
        } else {
          throw new Error(`Invalid cache type: ${typeof cached}`);
        }

        // Validate cache structure
        if (typeof cachedData.count !== 'number' || typeof cachedData.timestamp !== 'number') {
          throw new Error('Invalid cache structure');
        }

        const ageMinutes = Math.floor((Date.now() - cachedData.timestamp) / 1000 / 60);
        console.log(`Using cached Meltwater count: ${cachedData.count} (cached ${ageMinutes} minutes ago)`);
        return { success: true, count: cachedData.count, cached: true };
      } catch (parseError) {
        console.log('Cache parse error - clearing invalid cache:', parseError.message, 'Raw cache value:', typeof cached, cached);
        await redis.del(cacheKey); // Clear invalid cache
      }
    }

    // Check if we're in a rate limit cooldown period
    const rateLimitCache = await redis.get(`${cacheKey}:ratelimited`);
    console.log(`Rate limit cache for ${cacheKey}:ratelimited:`, rateLimitCache ? 'EXISTS' : 'NONE');

    if (rateLimitCache) {
      const rateLimitData = JSON.parse(rateLimitCache);
      const cooldownMinutes = Math.floor((Date.now() - rateLimitData.timestamp) / 1000 / 60);
      console.log(`Still in rate limit cooldown period (${cooldownMinutes} minutes ago) - skipping API call`);
      return { success: false, count: 0, rateLimited: true };
    }
  } catch (e) {
    console.log('Cache read error:', e.message, '- proceeding with API call');
  }

  // Re-enabled API calls with caching - rate limits should have reset

  try {
    const now = new Date();
    let startDate, endDate;
    
    if (window === "today") {
      const todayET = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
      todayET.setHours(0, 0, 0, 0);
      startDate = todayET.toISOString().split('.')[0];
      endDate = now.toISOString().split('.')[0];
    } else {
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split('.')[0];
      endDate = now.toISOString().split('.')[0];
    }

    console.log(`Getting Meltwater count from API: ${startDate} to ${endDate}`);

    const response = await fetch(`https://api.meltwater.com/v3/search/${SEARCH_ID}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'apikey': MELTWATER_API_KEY
      },
      body: JSON.stringify({
        start: startDate,
        end: endDate,
        tz: "America/New_York",
        sort_by: "date",
        sort_order: "desc",
        template: {
          name: "api.json"
        },
        page_size: 100
      })
    });

    // Handle rate limiting
    if (response.status === 429) {
      console.log('Meltwater API rate limited - caching failure for 30 minutes');

      // Cache the rate limit status to prevent repeated calls
      try {
        const rateLimitCache = {
          rateLimited: true,
          timestamp: Date.now()
        };
        await redis.setex(`${cacheKey}:ratelimited`, 30 * 60, JSON.stringify(rateLimitCache)); // 30 minute cooldown
      } catch (e) {
        console.log('Failed to cache rate limit status');
      }

      return { success: false, count: 0, rateLimited: true };
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Meltwater API error:', response.status, errorText);
      return { success: false, count: 0 };
    }

    const data = await response.json();

    // Debug API response structure
    console.log('Meltwater API response structure:', {
      hasResults: !!data.results,
      hasDocuments: !!data.documents,
      hasData: !!data.data,
      isArray: Array.isArray(data),
      topLevelKeys: Object.keys(data || {}),
      resultsLength: data.results?.length,
      documentsLength: data.documents?.length,
      dataLength: data.data?.length,
      resultKeys: data.result ? Object.keys(data.result) : null,
      resultDocuments: data.result?.documents?.length,
      resultDocumentCount: data.result?.document_count
    });

    let articles = [];
    if (data.result && Array.isArray(data.result.documents)) {
      // Meltwater API v3 structure: data.result.documents
      articles = data.result.documents;
    } else if (data.result && typeof data.result.document_count === 'number') {
      // If result has document_count but no documents array, use count directly
      console.log(`Meltwater API shows ${data.result.document_count} articles available`);
      return { success: true, count: data.result.document_count };
    } else if (data.results) {
      articles = data.results;
    } else if (data.documents) {
      articles = data.documents;
    } else if (Array.isArray(data)) {
      articles = data;
    } else if (data.data && Array.isArray(data.data)) {
      articles = data.data;
    }

    console.log(`Meltwater API returned ${articles.length} articles`);

    // Cache the result for 15 minutes to prevent rate limiting
    try {
      const cacheData = {
        count: articles.length,
        timestamp: Date.now()
      };
      await redis.setex(cacheKey, 15 * 60, JSON.stringify(cacheData)); // 15 minute cache
      console.log('Cached Meltwater API result for 15 minutes');
    } catch (e) {
      console.log('Failed to cache result:', e.message);
    }

    return { success: true, count: articles.length };
  } catch (error) {
    console.error('Error fetching Meltwater count:', error);
    return { success: false, count: 0 };
  }
}

export default async function handler(req, res) {
  try {
    const win = (req.query?.window || req.query?.w || "today").toString();
    const [start, end] = win === "24h" ? range24h() : rangeTodayET();

    // Fetch ALL from Redis
    const raw = await redis.zrange(ZSET, 0, 5000, { rev: true });
    const items = raw.map(toObj).filter(Boolean);
    console.log(`Total items in Redis: ${items.length}`);

    // Filter to time window
    const inWin = items.filter((m) => {
      const ts = Number(m?.published_ts ?? NaN);
      return Number.isFinite(ts) ? ts >= start && ts < end : true;
    });

    // Initialize counts
    const by = { meltwater: 0, google_alerts: 0, rss: 0, newsletter: 0, other: 0 };
    let meltwaterCountFromRedis = 0;

    // Count items from Redis by origin (except Meltwater - we'll calculate that separately)
    for (const m of inWin) {
      const o = detectOrigin(m);
      if (o === "meltwater") {
        meltwaterCountFromRedis++;
      } else if (by.hasOwnProperty(o)) {
        by[o] += 1;
      } else {
        by.other += 1;
      }
    }

    console.log(`Meltwater items in Redis cache: ${meltwaterCountFromRedis}`);

    // Get BOTH streaming count AND API count for Meltwater
    const streamedCount = await getStreamedMeltwaterCount(win);
    const { success: apiSuccess, count: apiCount, rateLimited } = await getMeltwaterCountFromAPI(win);

    // Calculate total Meltwater count (combining historical + new)
    if (apiSuccess && apiCount > 0) {
      // API worked - use API count as baseline + any new streamed
      by.meltwater = apiCount + streamedCount;
      console.log(`Meltwater total: ${apiCount} (API) + ${streamedCount} (streamed) = ${by.meltwater}`);
    } else if (rateLimited) {
      // API is rate limited - use Redis cache as baseline + streamed
      by.meltwater = meltwaterCountFromRedis + streamedCount;
      console.log(`Meltwater total (rate limited): ${meltwaterCountFromRedis} (Redis) + ${streamedCount} (streamed) = ${by.meltwater}`);
    } else if (streamedCount > 0) {
      // API failed but we have streaming - use Redis as baseline
      by.meltwater = meltwaterCountFromRedis + streamedCount;
      console.log(`Meltwater total: ${meltwaterCountFromRedis} (Redis) + ${streamedCount} (streamed) = ${by.meltwater}`);
    } else {
      // No streaming, API failed - just use Redis cache
      by.meltwater = meltwaterCountFromRedis;
      console.log(`Meltwater total: ${meltwaterCountFromRedis} (Redis cache only)`);
    }

    // Calculate grand total (EXCLUDE Meltwater - it has its own page)
    const total = by.google_alerts + by.rss + by.newsletter + by.other;

    // Include streaming status in response
    const realtimeStats = {
      streaming_active: streamedCount > 0,
      last_streamed: await redis.get('meltwater:last_stream_time') || null,
      total_streamed_today: streamedCount,
      api_count: apiSuccess ? apiCount : null,
      cache_count: meltwaterCountFromRedis,
      data_source: apiSuccess ? 'api+streaming' : (rateLimited ? 'cache+streaming' : 'cache'),
      rate_limited: rateLimited || false
    };

    res.status(200).json({
      ok: true,
      window: win === "24h" ? "24h" : "today",
      totals: { 
        all: total, 
        by_origin: by 
      },
      realtime: realtimeStats,
      top_publishers: [],
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Summary error:', e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
