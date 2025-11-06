// Store and retrieve client summaries
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const SUMMARIES_ZSET = "client:summaries:z"; // Sorted set by timestamp

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      // Save a new client summary
      const { title, summary, created_at } = req.body;

      if (!title || !summary) {
        return res.status(400).json({ error: "title and summary are required" });
      }

      const timestamp = created_at ? new Date(created_at).getTime() : Date.now();
      const summaryId = `summary_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;

      const summaryObj = {
        id: summaryId,
        title,
        summary,
        created_at: new Date(timestamp).toISOString(),
        timestamp
      };

      // Store in sorted set with timestamp as score
      await redis.zadd(SUMMARIES_ZSET, {
        score: Math.floor(timestamp / 1000),
        member: JSON.stringify(summaryObj)
      });

      return res.status(200).json({
        ok: true,
        message: "Summary saved successfully",
        id: summaryId
      });

    } else if (req.method === "GET") {
      // Get all client summaries (newest first)
      const raw = await redis.zrange(SUMMARIES_ZSET, 0, -1, { rev: true });

      const summaries = raw.map(item => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          return null;
        }
      }).filter(Boolean);

      return res.status(200).json({
        ok: true,
        count: summaries.length,
        summaries
      });

    } else if (req.method === "DELETE") {
      // Delete a specific summary
      const { summary_id } = req.body;

      if (!summary_id) {
        return res.status(400).json({ error: "summary_id is required" });
      }

      // Get all summaries and find the one to delete
      const raw = await redis.zrange(SUMMARIES_ZSET, 0, -1);

      for (const item of raw) {
        try {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.id === summary_id) {
            await redis.zrem(SUMMARIES_ZSET, item);
            return res.status(200).json({
              ok: true,
              message: "Summary deleted successfully"
            });
          }
        } catch {}
      }

      return res.status(404).json({
        ok: false,
        message: "Summary not found"
      });

    } else {
      return res.status(405).json({ error: "Method not allowed" });
    }

  } catch (e) {
    console.error('Client summaries error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
