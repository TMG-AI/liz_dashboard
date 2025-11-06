// /api/ingest_google_alerts.js
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN
});

const ZSET = "mentions:z";
const SEEN_URL = "mentions:seen:canon";

// PASTE YOUR GOOGLE ALERTS RSS LINKS HERE
const GA_FEEDS = [
  "https://www.google.com/alerts/feeds/05287989213493614626/8513419346303824894",
];

function normalizeUrl(u){
  try{
    const url = new URL(u);
    url.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
     "mc_cid","mc_eid","ref","fbclid","gclid","igshid"].forEach(p=>url.searchParams.delete(p));
    if (![...url.searchParams.keys()].length) url.search="";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0,-1);
    return s;
  }catch{ return (u||"").trim(); }
}

function idFromCanonical(canon){ let h=0; for (let i=0;i<canon.length;i++) h=(h*31+canon.charCodeAt(i))>>>0; return `ga_${h.toString(16)}`; }
function toEpoch(d){ const t = Date.parse(d||""); return Math.floor((Number.isFinite(t)?t:Date.now())/1000); }

function between(xml, tag){
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re); if (!m) return "";
  return m[1].replace(/<!\[CDATA\[|\]\]>/g,"").trim();
}

function parseItems(xml){
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks){
    const title = between(b, "title");
    const link  = between(b, "link");
    const pub   = between(b, "pubDate") || between(b, "dc:date") || new Date().toISOString();
    if (!title && !link) continue;
    items.push({ title, link, pub });
  }
  return items;
}

export default async function handler(req, res){
  try{
    if (!GA_FEEDS.length){
      return res.status(200).json({ ok:false, error:"Add your Google Alerts RSS URLs to GA_FEEDS[]" });
    }

    let scanned = 0, stored = 0, skipped_existing = 0;
    for (const feed of GA_FEEDS){
      const r = await fetch(feed, { cache: "no-store" });
      if (!r.ok){
        // 401/403 usually means the feed is private (requires login)
        continue;
      }
      const xml = await r.text();
      const items = parseItems(xml);
      scanned += items.length;

      for (const it of items){
        const canon = normalizeUrl(it.link || it.title);
        if (!canon) continue;

        const first = await redis.sadd(SEEN_URL, canon);
        if (first !== 1) { skipped_existing++; continue; }

        const ts = toEpoch(it.pub);
        const id = idFromCanonical(canon);
        let host = "";
        try { host = new URL(it.link).hostname.toLowerCase(); } catch {}

        const mention = {
          id,
          canon,
          section: "Other",
          origin: "google_alerts",
          provider: "Google Alerts",
          title: it.title || "(untitled)",
          link: it.link || null,
          source: host || "Google Alert",
          matched: ["google-alert"],
          published_ts: ts,
          published: new Date(ts*1000).toISOString()
        };

        await redis.zadd(ZSET, { score: ts, member: JSON.stringify(mention) });
        stored++;
      }
    }

    res.status(200).json({ ok:true, scanned, stored, skipped_existing });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
