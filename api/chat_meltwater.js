// OpenAI Chat API - Ask questions about Meltwater articles only
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";

function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id) return x;
  try {
    return JSON.parse(x);
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { question } = req.body;

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: "Question is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    // Get all articles from last 7 days
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);

    const raw = await redis.zrange(ZSET, sevenDaysAgo, now, { byScore: true });
    const allArticles = raw.map(toObj).filter(Boolean);

    // Filter for ONLY Meltwater articles with searchid 27864701 (AI Digest for Lawyers)
    const meltwaterArticles = allArticles.filter(a =>
      (a.origin === 'meltwater' || a.section === 'Meltwater') &&
      (a.searchid === '27864701' || a.search_id === '27864701')
    );

    console.log(`Meltwater Chat: Loading ${meltwaterArticles.length} Meltwater articles for AI Digest (filtered from ${allArticles.length} total)`);

    // Prepare article context (limit to key info to save tokens)
    const articleContext = meltwaterArticles.map(a => ({
      title: a.title,
      source: a.source,
      published: a.published,
      summary: a.summary?.substring(0, 200) // Limit summary length
    }));

    // Create OpenAI chat completion
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an expert analyst helping with media monitoring from Meltwater (search ID 27864701 - AI Digest for Lawyers). You have access to ${meltwaterArticles.length} recent articles from Meltwater from the past 7 days.

Answer questions about trends, key topics, sentiment, or specific articles from the Meltwater feed.

FORMATTING REQUIREMENTS:
- Do NOT include title headers like "Weekly Summary:" or "Comprehensive Summary" - start directly with the content
- Use **bold text** for key terms and important points
- Use bullet points (- ) for lists only when listing 3+ related items
- Keep paragraphs concise (2-3 sentences max)
- Write in a flowing narrative style, not rigid categories
- Prioritize readability and natural flow over structured formatting

Available Meltwater articles:
${JSON.stringify(articleContext, null, 2)}`
          },
          {
            role: 'user',
            content: question
          }
        ],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    if (!openaiResponse.ok) {
      const error = await openaiResponse.text();
      console.error('OpenAI API error:', openaiResponse.status, error);
      return res.status(500).json({
        error: `OpenAI API error: ${openaiResponse.status}`,
        details: error
      });
    }

    const data = await openaiResponse.json();
    const answer = data.choices[0]?.message?.content || "No response generated";

    res.status(200).json({
      ok: true,
      question,
      answer,
      articles_analyzed: meltwaterArticles.length,
      meltwater_only: true,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Meltwater chat error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
