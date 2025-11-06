import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

function windowToSeconds(w = "24h") {
  const x = String(w).toLowerCase();
  if (x === "7d") return 7 * 24 * 3600;
  if (x === "30d") return 30 * 24 * 3600;
  return 24 * 3600;
}

export default async function handler(req, res){
  try{
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }

    const win = req.query.window || "24h";
    const now = Math.floor(Date.now()/1000);
    const since = now - windowToSeconds(win);

    // Pull by score window
    const rows = await redis.zrange(ZSET, since, now, { byScore: true, withScores: true });

    const sample = [];
    let foundJson = 0;

    for (let i = 0; i < rows.length && sample.length < 10; i += 2) {
      const member = rows[i];
      const score  = rows[i+1];
      let parsed = null;
      try { parsed = JSON.parse(typeof member === "string" ? member : String(member)); foundJson++; }
      catch { parsed = { raw: String(member) }; }
      sample.push({ score, item: parsed });
    }

    res.status(200).json({
      ok: true,
      window: win,
      byScore_count: rows.length / 2,
      found_json: foundJson,
      sample
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
