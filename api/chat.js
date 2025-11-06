// OpenAI Chat API - Ask questions about articles
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
    const articles = raw.map(toObj).filter(Boolean);

    console.log(`Chat: Loading ${articles.length} articles for context`);

    // Prepare article context with numbered citations
    const articleContext = articles.map((a, idx) => ({
      id: idx + 1, // Citation number [1], [2], [3], etc.
      title: a.title,
      source: a.source,
      published: a.published,
      origin: a.origin,
      link: a.link,
      summary: a.summary?.substring(0, 200) // Limit summary length
    }));

    // Count articles by origin
    const originCounts = articles.reduce((acc, a) => {
      const origin = a.origin || 'unknown';
      acc[origin] = (acc[origin] || 0) + 1;
      return acc;
    }, {});

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
            content: `You are an expert analyst helping with AI Digest for Lawyers. You have access to ${articles.length} recent articles about AI in legal practice from the past 7 days.

Article breakdown by source:
- Google Alerts: ${originCounts.google_alerts || 0} articles
- Law360: ${originCounts.law360 || 0} articles
- Meltwater: ${originCounts.meltwater || 0} articles
- RSS Feeds: ${originCounts.rss || 0} articles
- Newsletters: ${originCounts.newsletter || 0} articles
${originCounts.newsletter ? '' : '\nNote: There are NO newsletter articles in this dataset - do not mention newsletters in your response.'}

Answer questions about AI legal technology trends, case law, ethical considerations, tool adoption, or specific articles. ONLY discuss sources that have articles available (non-zero count).

CITATION REQUIREMENTS:
- Use inline citations [1], [2], [3] to reference specific articles
- Place citations immediately after statements that reference article content
- Use the article's "id" field from the context as the citation number
- Multiple articles can be cited in one sentence: [1][2][3]
- Every significant claim should have at least one citation

FORMATTING REQUIREMENTS:
- Do NOT include title headers like "Weekly Summary:" or "Comprehensive Summary" - start directly with the content
- Do NOT break content into separate sections by source (Google Alerts, Law360, Meltwater, RSS Feeds, Newsletters) - integrate all sources into unified themes
- Use **bold text** for key terms and important points
- Use bullet points (- ) for lists only when listing 3+ related items
- Keep paragraphs concise (2-3 sentences max)
- Write in a flowing narrative style, not rigid categories
- Prioritize readability and natural flow over structured formatting

Available articles:
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
      articles_analyzed: articles.length,
      sources: articleContext, // Return sources for citation rendering
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
