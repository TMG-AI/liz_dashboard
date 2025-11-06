// /api/ingest_ga_email.js
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN
});

const ZSET     = "mentions:z";
const SEEN_URL = "mentions:seen:canon";

// ---- helpers ----
function normalizeUrl(u){
  try{
    const url = new URL(u);
    url.hash = "";
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","utm_id",
     "mc_cid","mc_eid","ref","fbclid","gclid","igshid"].forEach(p=>url.searchParams.delete(p));
    if (![...url.searchParams.keys()].length) url.search = "";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0,-1);
    return s;
  }catch{ return (u||"").trim(); }
}
function idFromCanonical(canon){ let h=0; for(let i=0;i<canon.length;i++) h=(h*31+canon.charCodeAt(i))>>>0; return `ga_${h.toString(16)}`; }
function toEpoch(d){ const t = Date.parse(d||""); return Math.floor((Number.isFinite(t)?t:Date.now())/1000); }
function hostFromUrl(u){ try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }
function firstUrl(s){
  const m = String(s||"").match(/https?:\/\/[^\s"')<>]+/i);
  return m ? m[0] : "";
}

// ---- handler ----
export default async function handler(req, res){
  try{
    if (req.method !== "POST") { res.status(405).send("Use POST"); return; }

    // one secret: header x-ga-secret OR ?key=
    const SECRET = ((process.env.GA_EMAIL_SECRET || "") + "").trim();
    if (SECRET){
      const u = new URL(req.url, "http://localhost");
      const q = ((u.searchParams.get("key") || "") + "").trim();
      const h = ((req.headers["x-ga-secret"] || "") + "").trim();
      const got = h || q;
      if (!got || got !== SECRET) { res.status(401).send("bad secret"); return; }
    }

    // tolerant JSON parse
    let body = req.body;
    if (typeof body === "string"){
      let s = body.trim();
      if (s.startsWith("=")) s = s.slice(1);
      if (s.startsWith('"') && s.endsWith('"')) { try { s = JSON.parse(s); } catch {} }
      if (typeof s === "string") { try { body = JSON.parse(s); } catch { body = {}; } }
      else body = s;
    }

    // accept single or array
    const items = Array.isArray(body) ? body
      : Array.isArray(body?.results) ? body.results
      : body?.item ? [body.item]
      : body ? [body] : [];

    if (!items.length) { res.status(200).json({ ok:true, stored:0, note:"no items" }); return; }

    let stored = 0, skipped = 0, scanned = 0;
    for (const it of items){
      scanned++;

      const title = it.title || it.subject || "(untitled)";
      const link  = normalizeUrl(it.link || firstUrl(it.html || it.text || it.body || ""));
      const pubISO= it.published || it.date || new Date().toISOString();
      const src   = it.source || hostFromUrl(link) || "Google Alert";

      const canon = normalizeUrl(link || title);
      if (!canon) { skipped++; continue; }

      const first = await redis.sadd(SEEN_URL, canon);
      if (first !== 1) { skipped++; continue; }

      const ts = toEpoch(pubISO);
      const id = idFromCanonical(canon);

      const mention = {
        id, canon,
        section: "Other",
        origin: "google_alerts",
        provider: "Google Alerts",
        title, link: link || null, source: src,
        matched: ["google-alert"],
        published_ts: ts,
        published: new Date(ts*1000).toISOString()
      };

      await redis.zadd(ZSET, { score: ts, member: JSON.stringify(mention) });
      stored++;
    }

    res.status(200).json({ ok:true, scanned, stored, skipped });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
