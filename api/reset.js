import { Redis } from "@upstash/redis";
const r = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });
export default async function handler(req, res) {
  await Promise.all([r.del("mentions:z"), r.del("mentions:seen")]);
  res.status(200).json({ ok:true });
}
