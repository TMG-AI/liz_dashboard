import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });

const SEEN_ID   = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok:false, error:"Use POST with ?confirm=YES" });
      return;
    }
    if (req.query.confirm !== "YES") {
      res.status(400).json({ ok:false, error:"Add ?confirm=YES to proceed" });
      return;
    }
    const r1 = await redis.del(SEEN_ID);
    const r2 = await redis.del(SEEN_LINK);
    res.status(200).json({ ok:true, deleted: { [SEEN_ID]: r1, [SEEN_LINK]: r2 } });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
