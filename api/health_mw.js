import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }

    const env_ok = Boolean(process.env.KV2_REST_API_URL && process.env.KV2_REST_API_TOKEN);
    const mw_secret_set = Boolean(process.env.MW_WEBHOOK_SECRET);

    let zcount = 0;
    let latest = null;
    let redis_ok = false;

    try {
      zcount = await redis.zcard(ZSET);
      // Read latest without failing health if JSON parse fails
      const latestRaw = await redis.zrange(ZSET, 0, 0, { rev: true });
      if (latestRaw && latestRaw[0]) {
        try {
          const m = JSON.parse(latestRaw[0]);
          latest = {
            id: m.id,
            origin: m.origin,
            source: m.source,
            published_ts: m.published_ts,
            published: m.published,
            title: m.title,
          };
        } catch {
          latest = { raw: String(latestRaw[0]).slice(0, 200) };
        }
      }
      redis_ok = true;
    } catch {
      redis_ok = false;
    }


    res.status(200).json({
      ok: true,
      env_ok,
      mw_secret_set,
      redis_ok,
      zset: { key: ZSET, count: zcount, latest },
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
