import { Redis } from "@upstash/redis";
const r = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
export default async function handler(req, res) {
  const zlen = await r.zcard("mentions:z");
  const seen = await r.scard("mentions:seen");
  res.status(200).json({ zlen, seen });
}
