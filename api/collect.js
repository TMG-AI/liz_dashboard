import { Redis } from "@upstash/redis";
import Parser from "rss-parser";
import { Resend } from "resend";
import { isBlockedDomain, extractDomain } from "./blocked_domains.js";
import { isInternationalArticle, getBlockReason } from "./international_filter.js";

// ---- clients ----
const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN
});

// Enable YouTube/media fields & add requestOptions for UA
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

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ---- storage keys ----
const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";
const RETENTION_DAYS = 14; // Keep articles for 14 days

// ---- config ----
// Support both old RSS_FEEDS variable and new entity-specific feeds
const RSS_FEEDS = (process.env.RSS_FEEDS || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);

// Entity-specific RSS feeds
const ENTITY_FEEDS = {
  'delta_air_lines': process.env.RSS_FEED_DELTA_AIR_LINES,
  'guardant_health': process.env.RSS_FEED_GUARDANT_HEALTH,
  'albemarle': process.env.RSS_FEED_ALBEMARLE,
  'adelanto_healthcare': process.env.RSS_FEED_ADELANTO_HEALTHCARE,
  'carlos_zafarini': process.env.RSS_FEED_CARLOS_ZAFARINI,
  'stubhub': process.env.RSS_FEED_STUBHUB
};

// Build feed list with entity tags
const ALL_FEEDS = [];

// Add entity-specific feeds
for (const [entity, url] of Object.entries(ENTITY_FEEDS)) {
  if (url && url.trim()) {
    ALL_FEEDS.push({ url: url.trim(), origin: entity, section: entity.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
  }
}

// Add legacy RSS_FEEDS with default origin
for (const url of RSS_FEEDS) {
  ALL_FEEDS.push({ url, origin: 'google_alerts', section: 'Google Alerts' });
}

// ---- helpers ----
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
function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }
function normalizeHost(h) { return (h || "").toLowerCase().replace(/^www\./, "").replace(/^amp\./, ""); }
function unwrapGoogleAlert(u) {
  try {
    const url = new URL(u);
    if (url.hostname.endsWith("google.com") && url.pathname === "/url") {
      return url.searchParams.get("q") || url.searchParams.get("url") || u;
    }
    return u;
  } catch { return u; }
}
function displaySource(link, fallback) { const h = normalizeHost(hostOf(link)); return h || (fallback || ""); }
function buildYouTubeWatchUrl(s) {
  s = (s || "").trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  return s;
}
function extractItemLink(e) {
  let raw =
    (e.link && typeof e.link === "object" && e.link.href) ? e.link.href :
    (Array.isArray(e.link) && e.link[0]?.href)            ? e.link[0].href :
    (e.links && e.links[0]?.href)                         ? e.links[0].href :
    (typeof e.link === "string" ? e.link : "") ||
    (typeof e.id === "string" ? e.id : "");

  raw = unwrapGoogleAlert(raw);

  const ytId =
    e["yt:videoId"] ||
    e.videoId ||
    (typeof e.id === "string" && e.id.startsWith("yt:video:") ? e.id.split("yt:video:")[1] : "");

  if (!/^https?:\/\//i.test(raw) && ytId) raw = buildYouTubeWatchUrl(ytId);
  else {
    const h = hostOf(raw);
    if (h.includes("youtube.com") || h.includes("youtu.be")) raw = buildYouTubeWatchUrl(raw);
  }
  return (raw || "").trim();
}
function idFromCanonical(c) { let h=0; for (let i=0;i<c.length;i++) h=(h*31+c.charCodeAt(i))>>>0; return `m_${h.toString(16)}`; }
function toEpoch(d){ const t=Date.parse(d); return Number.isFinite(t)?Math.floor(t/1000):Math.floor(Date.now()/1000); }

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

// Normalize text for similarity comparison
function normalizeText(text) {
  const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'has', 'have', 'had', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can'];

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !stopWords.includes(word))
    .join(' ');
}

// Calculate similarity between two texts
function textSimilarity(text1, text2) {
  const words1 = new Set(text1.split(' '));
  const words2 = new Set(text2.split(' '));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

// Check if a similar story already exists
async function isDuplicateStory(title, summary, origin) {
  try {
    const normalizedContent = normalizeText(`${title} ${summary}`);

    // Get articles from the last 48 hours for this entity
    const twoDaysAgo = Math.floor(Date.now() / 1000) - (48 * 60 * 60);
    const recentArticles = await redis.zrange(ZSET, twoDaysAgo, '+inf', { byScore: true });

    for (const articleJson of recentArticles) {
      try {
        const article = JSON.parse(articleJson);

        // Only compare within the same entity
        if (article.origin !== origin) continue;

        const existingContent = normalizeText(`${article.title} ${article.summary || ''}`);
        const similarity = textSimilarity(normalizedContent, existingContent);

        // If 60% or more of key words match, consider it a duplicate story
        if (similarity >= 0.6) {
          console.log(`Duplicate story detected: "${title}" similar to "${article.title}" (${Math.round(similarity * 100)}% match)`);
          return true;
        }
      } catch (e) {
        continue;
      }
    }

    return false;
  } catch (error) {
    console.error('Error checking duplicate story:', error);
    return false;
  }
}
const ENABLE_SENTIMENT = (process.env.ENABLE_SENTIMENT || "").toLowerCase() === "true";
const POS = ["win","surge","rally","gain","positive","bull","record","secure","approve","partnership"];
const NEG = ["hack","breach","lawsuit","fine","down","drop","negative","bear","investigate","halt","outage","delay","ban"];
function sentimentScore(text){
  const t = (text||"").toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s += 1;
  for (const w of NEG) if (t.includes(w)) s -= 1;
  return s;
}
async function sendEmail(m){
  if(!resend || !process.env.ALERT_EMAIL_FROM || !process.env.ALERT_EMAIL_TO) return;
  const to = process.env.ALERT_EMAIL_TO.split(",").map(s=>s.trim()).filter(Boolean);
  if(!to.length) return;
  await resend.emails.send({
    from: process.env.ALERT_EMAIL_FROM,
    to,
    subject: `[URGENT] ${m.title}`,
    html: `<p><b>${m.title}</b></p>
           <p>Source: ${m.source} · ${m.published}</p>
           <p>Section: ${m.section}</p>
           <p><a href="${m.link}">Open article</a></p>`
  });
}

// Entity-specific content filters
function shouldFilterArticle(origin, title, summary, source, link) {
  const text = `${title} ${summary}`.toLowerCase();
  const titleLower = title.toLowerCase();

  // === UNIVERSAL FILTERS (All entities) ===

  // Filter: Syndicated "Earnings Snapshot" articles (AP wire spam)
  if (title.includes('Earnings Snapshot') || title.includes('Q3 Earnings Snapshot') ||
      title.includes('Q4 Earnings Snapshot') || title.includes('Q1 Earnings Snapshot') ||
      title.includes('Q2 Earnings Snapshot')) {
    console.log(`Filtering syndicated earnings snapshot: "${title}"`);
    return true;
  }

  // Filter: Opinion/Editorial pieces
  const opinionIndicators = [
    'opinion:', 'op-ed:', 'commentary:', 'editorial:', 'column:',
    'guest column', 'my view:', 'viewpoint:', 'perspective:',
    'letter to', 'letters:', 'i believe', 'in my opinion',
    'we need to', 'it\'s time to', 'why we should', 'why we must'
  ];
  const opinionUrlPatterns = ['/opinion/', '/commentary/', '/op-ed/', '/editorial/', '/columns/'];

  const hasOpinionMarker = opinionIndicators.some(indicator => titleLower.includes(indicator));
  const isOpinionUrl = link && opinionUrlPatterns.some(pattern => link.toLowerCase().includes(pattern));

  if (hasOpinionMarker || isOpinionUrl) {
    console.log(`Filtering opinion piece: "${title}"`);
    return true;
  }

  // Filter: Shopping/Product listings
  const shoppingKeywords = [
    'on sale for', 'buy now and save', 'limited time offer',
    'shop the collection', 'shop now', 'save up to',
    'discount code', 'promo code', 'coupon code',
    'free shipping', 'best deals', 'price drop'
  ];
  const hasPriceInTitle = /\$\d+(\.\d{2})?/.test(titleLower);
  const hasShopping = shoppingKeywords.some(keyword => text.includes(keyword));

  if (hasShopping || hasPriceInTitle) {
    console.log(`Filtering shopping/product listing: "${title}"`);
    return true;
  }

  // Filter: Stock price/trading articles
  const stockPriceKeywords = [
    'stock price', 'share price', 'stock rises', 'stock falls', 'stock drops',
    'shares rise', 'shares fall', 'shares drop', 'stock jumps', 'stock climbs',
    'trading at', 'trades at', 'market cap', 'stock market', 'wall street',
    'stock analyst', 'price target', 'earnings per share', 'eps', 'stock ticker',
    'nasdaq', 'nyse', 'dow jones', 'stock rallies', 'stock plunges',
    'investors', 'shareholders', 'stock performance', 'quarterly earnings',
    'stock rating', 'buy rating', 'sell rating', 'hold rating',
    'pre-market', 'after-hours trading', 'stock watch', 'market watch'
  ];

  // Title-based stock indicators
  const stockFocusedInTitle = [
    'stock up', 'stock down', 'shares up', 'shares down',
    'gains on', 'drops on', 'stock cheap', 'stock expensive',
    'stock performs', 'stock move', 'stock climbs', 'stock falls',
    'stock outlook', 'stock forecast', 'stock analysis', 'stock valuation'
  ].some(phrase => titleLower.includes(phrase));

  // Financial news sources (stock spam sites)
  const financialSources = [
    'morningstar', 'seekingalpha', 'marketwatch', 'barrons',
    'motley fool', 'zacks', 'tipranks', 'gurufocus'
  ];

  const hasStockKeywords = stockPriceKeywords.some(keyword => text.includes(keyword));
  const isFinancialSource = source && financialSources.some(src => source.toLowerCase().includes(src));

  if (hasStockKeywords || stockFocusedInTitle || (hasStockKeywords && isFinancialSource)) {
    console.log(`Filtering stock price article for ${origin}: "${title}"`);
    return true;
  }

  // === ENTITY-SPECIFIC FILTERS ===

  // Delta Air Lines: Exclude airplane incidents, routes, airport/TSA news, generic airline industry
  if (origin === 'delta_air_lines') {
    const incidentKeywords = [
      'incident', 'crash', 'emergency', 'accident', 'diverted', 'grounded',
      'delayed', 'cancellation', 'mechanical issue', 'safety concern',
      'investigation', 'turbulence', 'forced landing', 'engine failure',
      'medical emergency', 'unruly passenger'
    ];

    const routeKeywords = [
      'new route', 'adds service', 'launches flight', 'new destination',
      'expands service', 'adds flight', 'inaugural flight', 'direct flight to',
      'nonstop service', 'new nonstop', 'will fly to', 'service to',
      'announces route', 'route from', 'route to', 'flights to',
      'flights from', 'adding flights', 'new flights', 'begins service',
      'starts service', 'route expansion', 'flight schedule', 'new service to',
      'increases flights', 'increases service', 'adds daily flight',
      'cuts service', 'ends operations at', 'exits market', 'suspends flights'
    ];

    // Airport/TSA security (not Delta business news)
    const airportSecurityKeywords = [
      'tsa investigating', 'tsa finds', 'tsa discovered', 'tsa checkpoint',
      'security checkpoint', 'airport security', 'screeners found',
      'went through security', 'hazardous item', 'weapon found', 'security breach'
    ];

    // Generic airline industry news (not Delta-specific)
    const genericAirlineKeywords = [
      'airlines will not have to', 'airlines must', 'airlines face',
      'airline industry', 'aviation industry', 'carriers including',
      'among airlines', 'airlines like delta', 'delta and other airlines',
      'major airlines', 'u.s. airlines', 'domestic carriers'
    ];

    // FAA/regulatory news that's generic (not Delta-specific)
    const faaGenericKeywords = [
      'faa ends', 'faa lifts', 'faa issues', 'faa requires',
      'flight restriction order', 'airspace restriction', 'faa rule'
    ];

    const hasIncident = incidentKeywords.some(keyword => text.includes(keyword));
    const hasRoute = routeKeywords.some(keyword => text.includes(keyword));
    const hasAirportSecurity = airportSecurityKeywords.some(keyword => text.includes(keyword));
    const hasGenericAirline = genericAirlineKeywords.some(keyword => text.includes(keyword));
    const hasFAAGeneric = faaGenericKeywords.some(keyword => text.includes(keyword));

    if (hasIncident || hasRoute || hasAirportSecurity || hasGenericAirline || hasFAAGeneric) {
      console.log(`Filtering Delta article: "${title}"`);
      return true;
    }
  }

  // Guardant Health: Accept all news
  if (origin === 'guardant_health') {
    return false; // Accept all
  }

  // Albemarle: Only news about Albemarle Corporation (not geographic locations)
  if (origin === 'albemarle') {
    // Filter geographic false positives FIRST
    const geographicKeywords = [
      'albemarle county', 'albemarle, nc', 'albemarle north carolina',
      'city of albemarle', 'charlottesville', 'albemarle sound',
      'albemarle road', 'albemarle st', 'albemarle street', 'albemarle ave',
      'zoning', 'rezoning', 'land use', 'parcel', 'planning board'
    ];

    const isGeographic = geographicKeywords.some(keyword => text.includes(keyword));
    if (isGeographic) {
      console.log(`Filtering Albemarle geographic article: "${title}"`);
      return true;
    }

    // Must mention corporation/business indicators
    const isCorporation = text.includes('corporation') ||
                         text.includes('corp.') ||
                         text.includes('company') ||
                         text.includes('albemarle corp') ||
                         text.includes(' alb ') || // Stock ticker (with spaces)
                         text.includes('lithium') ||
                         text.includes('chemical') ||
                         text.includes('kings mountain') || // Mine location
                         (text.includes('charlotte') && text.includes('based')); // HQ

    if (!isCorporation) {
      console.log(`Filtering Albemarle non-corporate article: "${title}"`);
      return true;
    }
  }

  // StubHub: Exclude ticket buying guides and event-focused articles
  if (origin === 'stubhub') {
    const ticketBuyingKeywords = [
      'how to get tickets',
      'how to buy',
      'where to buy tickets',
      'ticket guide',
      'buying guide',
      'purchase tickets',
      'get your tickets',
      'buy tickets',
      'tickets available',
      'on sale now',
      'tickets on sale',
      'cheapest tickets',
      'best way to get',
      'how to find tickets'
    ];

    const isTicketGuide = ticketBuyingKeywords.some(keyword => text.includes(keyword));
    if (isTicketGuide) {
      console.log(`Filtering StubHub ticket buying guide: "${title}"`);
      return true;
    }

    // Event-focused content indicators (sports/concerts)
    const eventFocusedKeywords = [
      // Sports event indicators
      'game preview', 'game recap', 'match preview', 'match recap',
      'starting lineup', 'injury report', 'game day', 'matchup',
      'vs.', 'vs ', ' v ', ' @ ', // Common game notation (Lakers vs Celtics)
      'score', 'final score', 'box score', 'play-by-play',
      'postgame', 'pregame', 'halftime', 'overtime',
      'wins', 'loses', 'defeats', 'beats', 'victory', 'defeated',
      'touchdown', 'home run', 'goal', 'basket', 'points scored',
      'playoff', 'championship game', 'world series', 'super bowl',
      'nba game', 'nfl game', 'mlb game', 'nhl game', 'mls game',
      'sports event', 'sporting event', 'game tonight', 'game tomorrow',
      'season opener', 'season finale', 'game highlights', 'game results',
      'team wins', 'team loses', 'game score', 'final result',

      // Concert/music event indicators
      'concert review', 'concert recap', 'setlist',
      'performs at', 'performed at', 'performance at',
      'takes the stage', 'opening act', 'headliner',
      'tour stops', 'tour date', 'concert venue',
      'live performance', 'live show', 'sold out show',
      'encore', 'acoustic set', 'concert tonight', 'concert tomorrow',
      'show tonight', 'show tomorrow', 'music event',

      // General event coverage
      'event recap', 'event review', 'event highlights',
      'what happened at', 'photos from', 'watch highlights',
      'event coverage', 'event results', 'event tonight'
    ];

    // StubHub business indicators (keep these articles)
    // NOTE: Do NOT include just "stubhub" - all articles mention it!
    const businessKeywords = [
      'stubhub fees', 'stubhub pricing', 'service charge', 'platform',
      'marketplace', 'resale', 'secondary market',
      'ticket platform', 'ticket marketplace', 'dynamic pricing',
      'all-in pricing', 'transparency', 'price guarantee',
      'ticket protection', 'fanprotect', 'customer service',
      'refund policy', 'ticket delivery', 'mobile tickets',
      'stubhub ceo', 'stubhub lawsuit', 'stubhub settlement',
      'stubhub acquisition', 'stubhub merger', 'stubhub revenue',
      'stubhub investigation', 'stubhub probe', 'watchdog', 'antitrust'
    ];

    const isEventFocused = eventFocusedKeywords.some(keyword => text.includes(keyword));
    const isBusinessNews = businessKeywords.some(keyword => text.includes(keyword));

    // Filter if it's event-focused AND NOT business news
    if (isEventFocused && !isBusinessNews) {
      console.log(`Filtering StubHub event-focused article: "${title}"`);
      return true;
    }
  }

  // All other entities: accept all
  return false;
}

// ---- handler ----
export default async function handler(req, res) {
  try {
    let found = 0, stored = 0, emailed = 0, errors = [];

    // Check if RSS feeds are configured
    if (!ALL_FEEDS.length) {
      console.log('No RSS feeds configured - skipping RSS collection');
      res.status(200).json({
        ok: true,
        message: "RSS collection disabled - no feeds configured",
        found: 0,
        stored: 0,
        emailed: 0,
        errors: [],
        rss_disabled: true,
        generated_at: new Date().toISOString()
      });
      return;
    }

    // No keyword filtering - RSS feeds are entity-specific
    console.log(`RSS collection starting: ${ALL_FEEDS.length} feeds (${Object.keys(ENTITY_FEEDS).filter(k => ENTITY_FEEDS[k]).length} entities), no keyword filtering`);

    for (const feedConfig of ALL_FEEDS) {
      const { url, origin, section } = feedConfig;
      try {
        const feed = await parser.parseURL(url);
        const feedTitle = feed?.title || url;

        for (const e of feed?.items || []) {
          const title = (e.title || "").trim();
          const ytDesc = e.mediaDescription || e?.media?.description || e?.mediaContent?.description || "";
          const sum = ytDesc || e.contentSnippet || e.content || e.summary || "";
          const link = extractItemLink(e);
          const source = displaySource(link, feedTitle);

          // Filter out press releases
          if (isPressRelease(title, sum, source)) {
            console.log(`Skipping press release: "${title}" from ${source}`);
            continue;
          }

          // Filter out blocked domains (MFA sites)
          if (isBlockedDomain(link)) {
            console.log(`Skipping blocked domain: "${title}" from ${extractDomain(link)}`);
            continue;
          }

          // Filter out international articles
          if (isInternationalArticle(title, sum, link, source)) {
            console.log(`Skipping international article: "${title}" - ${getBlockReason(title, sum, link, source)}`);
            continue;
          }

          // Apply entity-specific filters
          if (shouldFilterArticle(origin, title, sum, source, link)) {
            console.log(`Skipping filtered article for ${origin}: "${title}"`);
            continue;
          }

          // Check for duplicate stories (same story from different sources)
          if (await isDuplicateStory(title, sum, origin)) {
            console.log(`Skipping duplicate story for ${origin}: "${title}"`);
            found++; // Count it as found but don't store
            continue;
          }

          // No keyword filtering - accept all articles from Google Alerts RSS
          const canon = normalizeUrl(link || title);
          if (!canon) continue;

          const addCanon = await redis.sadd(SEEN_LINK, canon);
          if (addCanon !== 1) continue;

          const mid = idFromCanonical(canon);
          await redis.sadd(SEEN_ID, mid);

          const ts = toEpoch(e.isoDate || e.pubDate || e.published || e.updated);

          const m = {
            id: mid,
            canon,
            section: section,
            title: title || "(untitled)",
            link,
            source,
            summary: sum,
            origin: origin,
            published_ts: ts,
            published: new Date(ts * 1000).toISOString()
          };

          if (ENABLE_SENTIMENT) m.sentiment = sentimentScore(`${title} ${sum}`);
          await redis.zadd(ZSET, { score: ts, member: JSON.stringify(m) });

          // Trim articles older than RETENTION_DAYS
          const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
          await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

          found++; stored++;
        }
      } catch (err) {
        errors.push({ url, error: err?.message || String(err) });
      }
    }
    res.status(200).json({ ok:true, feeds: ALL_FEEDS.length, found, stored, emailed, errors, entities_configured: Object.keys(ENTITY_FEEDS).filter(k => ENTITY_FEEDS[k]).length });
  } catch (e) {
    res.status(500).json({ ok:false, error:`collect failed: ${e?.message || e}` });
  }
}
