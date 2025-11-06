// /api/ga_webhook.js
import { Redis } from "@upstash/redis";
import { isBlockedDomain, extractDomain } from "./blocked_domains.js";
import { isInternationalArticle, getBlockReason } from "./international_filter.js";

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
function idFromCanonical(canon){ let h=0; for (let i=0;i<canon.length;i++) h=(h*31+canon.charCodeAt(i))>>>0; return `ga_${h.toString(16)}`; }
function toEpoch(d){ const t=Date.parse(d||""); const sec = Math.floor((Number.isFinite(t)?t:Date.now())/1000); return Math.min(sec, Math.floor(Date.now()/1000)); }

export default async function handler(req, res){
  try{
    if (req.method !== "POST") return res.status(405).send("Use POST");

    // Optional shared-secret via ?key=
    if (process.env.GA_WEBHOOK_SECRET) {
      const urlObj = new URL(req.url, "http://localhost");
      const key = (urlObj.searchParams.get("key")||"").trim();
      if (!key || key !== process.env.GA_WEBHOOK_SECRET) return res.status(401).send("bad secret");
    }

    let body = req.body;
    if (typeof body === "string") { try{ body = JSON.parse(body); } catch{ body = {}; } }

    // Expect shape from n8n RSS Read: { title, link, isoDate }
    const title = body.title || "(untitled)";
    const link  = normalizeUrl(body.link || "");
    const ts    = toEpoch(body.isoDate || body.published_at || body.date);

    if (!link) return res.status(200).json({ ok:true, stored:0, note:"missing link" });

    // Filter out blocked domains (MFA sites)
    if (isBlockedDomain(link)) {
      console.log(`[GA Webhook] Blocked domain: "${title}" from ${extractDomain(link)}`);
      return res.status(200).json({ ok:true, stored:0, note:"blocked domain" });
    }

    // Filter out international articles
    if (isInternationalArticle(title, '', link, (new URL(link).hostname))) {
      console.log(`[GA Webhook] Blocked international: "${title}" - ${getBlockReason(title, '', link, (new URL(link).hostname))}`);
      return res.status(200).json({ ok:true, stored:0, note:"international" });
    }

    // de-dupe by canonical URL
    const first = await redis.sadd(SEEN_URL, link);
    if (first !== 1) return res.status(200).json({ ok:true, stored:0, note:"dupe" });

    const mention = {
      id: idFromCanonical(link),
      canon: link,
      section: "Google Alerts",
      origin: "google_alerts",
      provider: "Google Alerts",
      title,
      link,
      source: (new URL(link).hostname),
      matched: ["google-alert"],
      published_ts: ts,
      published: new Date(ts*1000).toISOString()
    };

    await redis.zadd(ZSET, { score: ts, member: JSON.stringify(mention) });
    res.status(200).json({ ok:true, stored:1, sample:{ title, link } });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
