// Summarize Selected Articles API
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
    const { article_ids } = req.body;

    if (!article_ids || !Array.isArray(article_ids) || article_ids.length === 0) {
      return res.status(400).json({ error: "article_ids array is required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OpenAI API key not configured" });
    }

    // Get all articles from last 30 days
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

    const raw = await redis.zrange(ZSET, thirtyDaysAgo, now, { byScore: true });
    const allArticles = raw.map(toObj).filter(Boolean);

    // Filter to only selected articles
    const selectedArticles = allArticles.filter(a => article_ids.includes(a.id));

    if (selectedArticles.length === 0) {
      return res.status(404).json({
        error: "No articles found with the provided IDs",
        requested: article_ids.length,
        found: 0
      });
    }

    console.log(`Summarizing ${selectedArticles.length} selected articles (requested: ${article_ids.length})`);

    // Prepare article context with numbered citations
    const articleContext = selectedArticles.map((a, idx) => ({
      citation_id: idx + 1, // Citation number [1], [2], [3], etc.
      article_id: a.id,
      title: a.title,
      source: a.source,
      published: a.published,
      origin: a.origin,
      link: a.link,
      summary: a.summary || ''
    }));

    // Count articles by origin
    const originCounts = selectedArticles.reduce((acc, a) => {
      const origin = a.origin || 'unknown';
      acc[origin] = (acc[origin] || 0) + 1;
      return acc;
    }, {});

    const question = `Analyze these ${selectedArticles.length} selected articles about AI in legal practice. Provide a comprehensive summary focusing on: 1) Major trends and developments, 2) New AI tools and practical applications, 3) Ethical and regulatory considerations, 4) Key insights for legal professionals. Integrate insights from all sources into unified themes.`;

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
            content: `You are an expert analyst for AI in Practice (formerly AI Digest for Lawyers). You have access to ${selectedArticles.length} specifically selected articles about AI in legal practice.

Article breakdown by source:
- Google Alerts: ${originCounts.google_alerts || 0} articles
- Law360: ${originCounts.law360 || 0} articles
- Meltwater: ${originCounts.meltwater || 0} articles
- RSS Feeds: ${originCounts.rss || 0} articles
- Newsletters: ${originCounts.newsletter || 0} articles

Your task is to analyze these articles and provide a comprehensive summary. ONLY discuss sources that have articles available (non-zero count).

CITATION REQUIREMENTS:
- Use inline citations [1], [2], [3] to reference specific articles
- Place citations immediately after statements that reference article content
- Use the article's "citation_id" field from the context as the citation number
- Multiple articles can be cited in one sentence: [1][2][3]
- Every significant claim or fact should have at least one citation

FORMATTING REQUIREMENTS:
- Do NOT include title headers like "Summary:" or "Analysis:" - start directly with the content
- Do NOT break content into separate sections by source - integrate all sources into unified themes
- Use **bold text** for key terms, company names, and important points
- Use bullet points (- ) sparingly, only for lists of 3+ related items
- Keep paragraphs concise (2-3 sentences max)
- Write in a flowing narrative style with natural transitions
- Prioritize readability and insights over rigid structure
- Focus on actionable intelligence for legal professionals

Available articles:
${JSON.stringify(articleContext, null, 2)}`
          },
          {
            role: 'user',
            content: question
          }
        ],
        temperature: 0.7,
        max_tokens: 2500
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
      answer,
      articles_analyzed: selectedArticles.length,
      articles_requested: article_ids.length,
      sources: articleContext, // Return sources for citation rendering
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Summarize selected error:', e);
    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
}
