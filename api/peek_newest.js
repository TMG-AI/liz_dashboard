import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
const ZSET = "mentions:z";

function parseMember(member) {
  if (member == null) return null;
  if (typeof member === "object") return member;          // already an object
  if (typeof member === "string") {
    try { return JSON.parse(member); } catch { return { raw: member }; }
  }
  return { raw: String(member) };
}

export default async function handler(req, res){
  try{
    if (req.method !== "GET") { res.status(405).send("Use GET"); return; }

    // Newest 10 members (no scores)
    const rows = await redis.zrange(ZSET, 0, 9, { rev: true });

    const items = [];
    let found_json = 0;

    for (const member of rows) {
      const parsed = parseMember(member);
      if (parsed && !parsed.raw) found_json++;
      items.push({ item: parsed });
    }

    res.status(200).json({ ok: true, count: rows.length, found_json, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
