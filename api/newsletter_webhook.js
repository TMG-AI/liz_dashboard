// /api/newsletter_webhook.js
// Receives filtered newsletter articles from n8n (pre-filtered for AI/legal keywords)
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_URL = "mentions:seen:canon";

function normalizeUrl(u){
  try{
    const url = new URL(u);
    url.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
     "mc_cid","mc_eid","ref","fbclid","gclid","igshid"].forEach(p=>url.searchParams.delete(p));
    if (![...url.searchParams.keys()].length) url.search = "";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString(); if (s.endsWith("/")) s=s.slice(0,-1);
    return s;
  }catch{ return (u||"").trim(); }
}

function idFromCanonical(canon){
  let h=0;
  for (let i=0;i<canon.length;i++) h=(h*31+canon.charCodeAt(i))>>>0;
  return `newsletter_${h.toString(16)}`;
}

function toEpoch(d){
  const t=Date.parse(d||"");
  return Number.isFinite(t) ? Math.floor(t/1000) : Math.floor(Date.now()/1000);
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).send("Use POST");

    // Optional webhook secret via ?key= query parameter
    if (process.env.NEWSLETTER_WEBHOOK_SECRET) {
      const urlObj = new URL(req.url, "http://localhost");
      const key = (urlObj.searchParams.get("key")||"").trim();
      if (!key || key !== process.env.NEWSLETTER_WEBHOOK_SECRET) {
        return res.status(401).send("Unauthorized");
      }
    }

    let body = req.body;
    if (typeof body === "string") {
      try{ body = JSON.parse(body); }
      catch{ body = {}; }
    }

    // Expected fields from n8n:
    // - title: Article title
    // - link: Article URL
    // - published_at / isoDate / date: Publication date
    // - source: Newsletter name (optional)
    // - matched_keyword: The keyword that triggered the filter (optional)
    const title = body.title || body.headline || "(untitled)";
    const rawLink = body.link || body.url || "";
    const ts    = toEpoch(body.published_at || body.isoDate || body.date || body.published);
    const source = body.source || body.newsletter || "Newsletter";
    const matchedKeyword = body.matched_keyword || body.keyword || "";

    // For newsletter articles without individual URLs, generate a unique identifier
    let link;
    let canonicalId;

    if (!rawLink || rawLink === "#" || rawLink.trim() === "") {
      // Generate unique ID based on title + source + timestamp
      const uniqueStr = `${title}_${source}_${ts}`;
      let h = 0;
      for (let i = 0; i < uniqueStr.length; i++) h = (h * 31 + uniqueStr.charCodeAt(i)) >>> 0;
      canonicalId = `newsletter_${h.toString(16)}`;
      link = `https://newsletter.internal/${source.toLowerCase().replace(/\s+/g, '-')}/${canonicalId}`;
    } else {
      link = normalizeUrl(rawLink);
      canonicalId = link;
    }

    // Deduplicate by canonical URL/ID
    const first = await redis.sadd(SEEN_URL, canonicalId);
    if (first !== 1) {
      console.log(`Newsletter webhook: Skipping duplicate - ${title}`);
      return res.status(200).json({ ok:true, stored:0, note:"duplicate" });
    }

    // Build matched array with the keyword that triggered the filter
    const matched = ["newsletter"];
    if (matchedKeyword) {
      matched.push(matchedKeyword.toLowerCase());
    }

    const mention = {
      id: idFromCanonical(canonicalId),
      canon: canonicalId,
      section: "Newsletter",
      origin: "newsletter",
      provider: source,
      title,
      link,
      source,
      matched,
      published_ts: ts,
      published: new Date(ts*1000).toISOString(),
      summary: body.summary || body.description || "",
      reach: 0,
      newsletter_article: !rawLink || rawLink.trim() === "" // Flag to indicate it's a newsletter-only article
    };

    await redis.zadd(ZSET, { score: ts, member: JSON.stringify(mention) });

    console.log(`[Newsletter] Stored: "${title}" from ${source} (matched: ${matchedKeyword || 'N/A'})`);

    res.status(200).json({
      ok: true,
      stored: 1,
      sample: {
        title,
        link,
        source,
        matched_keyword: matchedKeyword
      }
    });
  } catch(e) {
    console.error('Newsletter webhook error:', e);
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
