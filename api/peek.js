import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

export default async function handler(req, res){
  try{
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }
    // latest 10 items, newest first
    const rows = await redis.zrange(ZSET, 0, 9, { rev: true, withScores: true });
    const items = [];
    for (let i = 0; i < rows.length; i += 2) {
      const member = rows[i];
      const score  = rows[i+1];
      let obj = null;
      try { obj = JSON.parse(typeof member === "string" ? member : String(member)); }
      catch { obj = { raw: String(member) }; }
      items.push({ score, item: obj });
    }
    res.status(200).json({ ok:true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
