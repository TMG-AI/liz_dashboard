// /api/webhook_status.js
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

export default async function handler(req, res) {
  const todayKey = getTodayKey();
  const totalKey = 'meltwater:stream:count';
  
  const [todayCount, totalCount, lastStream] = await Promise.all([
    redis.get(todayKey),
    redis.get(totalKey),
    redis.get('meltwater:last_stream_time')
  ]);
  
  res.status(200).json({
    status: 'active',
    today_streamed: parseInt(todayCount || 0),
    total_streamed: parseInt(totalCount || 0),
    last_received: lastStream || 'never',
    webhook_url: 'https://coinbase-pr-alerter.vercel.app/api/meltwater_webhook'
  });
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `meltwater:stream:daily:${year}-${month}-${day}`;
}
