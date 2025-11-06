import { Redis } from "@upstash/redis";

const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";
const SEEN_MW  = "mentions:seen:mw";
const SEEN_URL = "mentions:seen:canon";

export default async function handler(req, res){
  try{
    if (req.method !== 'POST') { res.status(405).json({ok:false, error:'POST only'}); return; }
    const token = req.headers['x-admin-token'] || req.query.token;
    if (!token || token !== process.env.ADMIN_TOKEN) { res.status(401).json({ok:false, error:'bad token'}); return; }

    const end = Math.floor(Date.now()/1000);
    const start = end - 7*24*3600; // scan last 7 days
    const raw = await redis.zrange(ZSET, start, end, { byScore: true });
    const keep = [];
    const remove = [];

    for (const s of raw){
      let m; try { m = JSON.parse(s); } catch { m = null; }
      const isMock = !m
        || String(m.id||'').startsWith('debug_')
        || (m.source||'').includes('Example News')
        || (m.link||'').includes('example.com');
      (isMock ? remove : keep).push(s);
    }

    let zRemoved = 0;
    if (remove.length){
      // Upstash supports multiple zrem calls; do in chunks
      const chunk = 64;
      for (let i=0;i<remove.length;i+=chunk){
        const batch = remove.slice(i, i+chunk);
        zRemoved += await redis.zrem(ZSET, ...batch);
      }
    }

    // Optionally clear seen sets so real items aren’t blocked by prior tests
    const clearSeen = (req.query.clear_seen === '1');
    let seenCleared = false;
    if (clearSeen){
      await redis.del(SEEN_MW);
      await redis.del(SEEN_URL);
      seenCleared = true;
    }

    res.status(200).json({ ok:true, scanned: raw.length, removed: zRemoved, seenCleared });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
