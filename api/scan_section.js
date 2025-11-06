import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });

const ZSET = "mentions:z";

export default async function handler(req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit || "500", 10), 2000);
    const rows = await redis.zrevrange(ZSET, 0, limit - 1);
    const counts = {}, samples = {};
    for (const row of rows) {
      let m; try { m = JSON.parse(row); } catch { continue; }
      const sec = m?.section || "Other";
      counts[sec] = (counts[sec] || 0) + 1;
      if (!samples[sec]) samples[sec] = [m];
      else if (samples[sec].length < 3) samples[sec].push(m);
    }
    res.status(200).json({ ok:true, scanned: rows.length, counts, samples });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
