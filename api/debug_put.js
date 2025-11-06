import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

export default async function handler(req, res){
  try{
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }

    const now = Math.floor(Date.now()/1000);
    const member = JSON.stringify({
      id: "debug_" + now,
      origin: "meltwater",
      section: "Meltwater",
      title: "DEBUG WRITE",
      link: "https://example.com/debug",
      source: "Debug Source",
      published_ts: now,
      published: new Date(now*1000).toISOString(),
      provider_meta: { reach: 123 }
    });

    const wrote = await redis.zadd(ZSET, { score: now, member });
    res.status(200).json({ ok:true, wrote, score: now });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
