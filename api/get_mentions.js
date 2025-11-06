// /api/get_mentions.js
// PROPERLY FIXED: Deduplicates and falls back to Redis if API fails
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
  }
  catch { return null; }
}

async function getMeltwaterFromAPI() {
  const MELTWATER_API_KEY = process.env.MELTWATER_API_KEY;
  const SEARCH_ID = '27864701'; // AI Digest for Lawyers
  
  if (!MELTWATER_API_KEY) {
    console.log('No Meltwater API key - will use Redis data only');
    return { success: false, articles: [] };
  }

  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const startDate = yesterday.toISOString().split('.')[0];
    const endDate = now.toISOString().split('.')[0];

    console.log(`Fetching Meltwater from ${startDate} to ${endDate}`);

    const meltwaterResponse = await fetch(`https://api.meltwater.com/v3/search/${SEARCH_ID}`, {
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
        }
      })
    });

    if (!meltwaterResponse.ok) {
      const errorText = await meltwaterResponse.text();
      console.error('Meltwater API error:', meltwaterResponse.status, errorText);
      return { success: false, articles: [] };
    }

    const meltwaterData = await meltwaterResponse.json();
    console.log('Meltwater API response received');
    
    // Extract articles from various possible response structures
    let articles = [];
    if (meltwaterData.results) {
      articles = meltwaterData.results;
    } else if (meltwaterData.documents) {
      articles = meltwaterData.documents;
    } else if (Array.isArray(meltwaterData)) {
      articles = meltwaterData;
    } else if (meltwaterData.data && Array.isArray(meltwaterData.data)) {
      articles = meltwaterData.data;
    }

    console.log(`Found ${articles.length} articles from Meltwater API`);

    // Transform to match your data format
    const transformed = articles.map(article => ({
      id: `mw_api_${article.id || article.document_id || Date.now()}_${Math.random()}`,
      title: article.title || article.headline || 'Untitled',
      link: article.url || article.link || article.permalink || '#',
      source: article.source_name || article.source || article.media_name || 'Meltwater',
      section: 'Meltwater',
      origin: 'meltwater',
      published: article.published_date || article.date || article.published_at || new Date().toISOString(),
      published_ts: article.published_timestamp || 
                    (article.published_date ? Math.floor(Date.parse(article.published_date) / 1000) : Math.floor(Date.now() / 1000)),
      matched: extractKeywords(article),
      reach: article.reach || article.circulation || article.audience || 0,
      sentiment: normalizeSentiment(article),
      sentiment_label: article.sentiment || article.sentiment_label || null,
      from_api: true // Mark as from API for deduplication
    }));

    return { success: true, articles: transformed };
  } catch (error) {
    console.error('Error fetching from Meltwater API:', error);
    return { success: false, articles: [] };
  }
}

function normalizeSentiment(article) {
  if (typeof article.sentiment_score === 'number') {
    return article.sentiment_score;
  }
  const sentiment = (article.sentiment || '').toLowerCase();
  if (sentiment === 'positive') return 1;
  if (sentiment === 'negative') return -1;
  if (sentiment === 'neutral') return 0;
  return undefined;
}

function extractKeywords(article) {
  const keywords = [];
  if (article.source_type) keywords.push(article.source_type);
  if (article.sentiment) keywords.push(`sentiment-${article.sentiment.toLowerCase()}`);
  if (article.country) keywords.push(article.country);
  if (article.tags && Array.isArray(article.tags)) keywords.push(...article.tags);
  
  const title = (article.title || '').toLowerCase();
  const coinbaseKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency', 'coinbase'];
  coinbaseKeywords.forEach(keyword => {
    if (title.includes(keyword)) keywords.push(keyword);
  });
  
  return [...new Set(keywords)];
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "300", 10)));
    const origin = (url.searchParams.get("origin") || "").toLowerCase().trim();
    const section = (url.searchParams.get("section") || "").trim();
    const q = (url.searchParams.get("q") || "").toLowerCase().trim();

    // 1. Get data from last 7 days from Redis
    let redisItems = [];
    try {
      const now = Math.floor(Date.now() / 1000);
      const sevenDaysAgo = now - (7 * 24 * 60 * 60); // 7 days in seconds

      console.log(`Fetching from Redis: ${sevenDaysAgo} to ${now}`);

      // Use zrange with byScore option to get items from last 7 days
      const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });

      console.log(`Raw items fetched: ${raw.length}`);
      console.log(`Raw item type: ${typeof raw[0]}`);
      console.log(`First raw item sample: ${JSON.stringify(raw[0])?.substring(0, 200)}`);

      redisItems = raw.map(toObj).filter(Boolean);
      console.log(`Parsed items: ${redisItems.length}`);
      console.log(`First parsed item: ${JSON.stringify(redisItems[0])?.substring(0, 200)}`);
    } catch (redisError) {
      console.error("Redis fetch error:", redisError);
    }

    // 2. Use Redis data only (includes real-time streaming Meltwater data)
    // No API calls needed since webhooks provide real-time data
    console.log('Using data from last 7 days from Redis');
    let finalItems = redisItems;

    // 3. Apply filters
    if (origin) {
      finalItems = finalItems.filter(m => (m.origin || "").toLowerCase() === origin);
    }
    if (section) {
      finalItems = finalItems.filter(m => (m.section || "") === section);
    }
    if (q) {
      finalItems = finalItems.filter(m => 
        (m.title || "").toLowerCase().includes(q) || 
        (m.source || "").toLowerCase().includes(q) ||
        (m.matched || []).some(tag => tag.toLowerCase().includes(q))
      );
    }

    // 4. Deduplicate by ID AND by title+summary (keep first occurrence)
    const seenIds = new Set();
    const seenTitleSummary = new Set();
    finalItems = finalItems.filter(m => {
      // Check ID deduplication
      if (m.id && seenIds.has(m.id)) return false;
      if (m.id) seenIds.add(m.id);

      // Check title+summary deduplication (even if source is different)
      const title = (m.title || '').trim().toLowerCase();
      const summary = (m.summary || '').trim().toLowerCase();
      if (title && summary) {
        const key = `${title}|||${summary}`;
        if (seenTitleSummary.has(key)) {
          console.log(`Filtering duplicate: "${m.title}" from ${m.source}`);
          return false;
        }
        seenTitleSummary.add(key);
      }

      return true;
    });

    // 5. Sort by date (newest first) - fix sort order
    finalItems.sort((a, b) => {
      const tsA = a.published_ts || 0;
      const tsB = b.published_ts || 0;
      return tsB - tsA;  // Newest first
    });

    // 6. Apply limit and clean up response
    const out = finalItems.slice(0, limit).map(m => ({
      id: m.id,
      title: m.title || "(untitled)",
      link: m.link || null,
      source: m.source || "",
      section: m.section || "",
      origin: m.origin || "",
      matched: Array.isArray(m.matched) ? m.matched : [],
      published: m.published || (m.published_ts ? new Date(m.published_ts * 1000).toISOString() : null),
      published_ts: typeof m.published_ts === "number" ? m.published_ts : (m.published ? Math.floor(Date.parse(m.published) / 1000) : 0),
      summary: m.summary || "",
      reach: m.reach || 0,
      sentiment: m.sentiment,
      sentiment_label: m.sentiment_label || null
    }));

    console.log(`Returning ${out.length} total items`);
    res.status(200).json(out);
  } catch (e) {
    console.error('Handler error:', e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
