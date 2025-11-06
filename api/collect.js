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
