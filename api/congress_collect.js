// /api/congress_collect.js
// Collects federal legislation from Congress.gov API with China/Chinese keywords
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";
const RETENTION_DAYS = 14; // Keep articles for 14 days

// Helper functions
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.search) url.search = "";
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (u || "").trim();
  }
}

function idFromCanonical(c) {
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return `congress_${h.toString(16)}`;
}

function toEpoch(d) {
  const t = Date.parse(d);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
}

function matchesKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes("china") || lower.includes("chinese");
}

// Fetch bills from Congress.gov API
async function fetchBills(congress = "119", limit = 250) {
  const apiKey = process.env.CONGRESS_API_KEY;

  if (!apiKey) {
    console.error("CONGRESS_API_KEY not configured");
    return { bills: [], error: "API key not configured" };
  }

  try {
    // Calculate date 7 days ago
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fromDateTime = sevenDaysAgo.toISOString().split('.')[0] + "Z";

    // Fetch bills with updates in the last 7 days
    const url = `https://api.congress.gov/v3/bill/${congress}?limit=${limit}&fromDateTime=${fromDateTime}&api_key=${apiKey}&format=json`;

    console.log(`Fetching Congress bills from: ${fromDateTime}`);

    const response = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Congress API error: ${response.status}`, errorText);
      return { bills: [], error: `API error: ${response.status}` };
    }

    const data = await response.json();
    return { bills: data.bills || [], error: null };
  } catch (error) {
    console.error("Error fetching from Congress.gov:", error);
    return { bills: [], error: error.message };
  }
}

export default async function handler(req, res) {
  try {
    let found = 0, stored = 0, errors = [];

    const congress = process.env.CONGRESS_NUMBER || "119"; // Default to 119th Congress
    const { bills, error } = await fetchBills(congress, 250);

    if (error) {
      errors.push({ source: "Congress.gov", error });
    }

    console.log(`Fetched ${bills.length} bills from Congress.gov`);

    for (const bill of bills) {
      try {
        // Extract bill details
        const title = bill.title || "";
        const number = bill.number || "";
        const type = bill.type || "";
        const billId = `${type}${number}`;

        // Get latest action summary (acts as description)
        const latestAction = bill.latestAction?.text || "";

        // Check if title or latest action contains China/Chinese keywords
        const titleMatch = matchesKeywords(title);
        const actionMatch = matchesKeywords(latestAction);

        if (!titleMatch && !actionMatch) {
          continue; // Skip bills that don't match keywords
        }

        found++;

        // Build bill URL - use congress.gov public URL (not API URL)
        // Map bill types to correct URL format
        const typeMap = {
          's': 'senate-bill',
          'hr': 'house-bill',
          'sres': 'senate-resolution',
          'hres': 'house-resolution',
          'sjres': 'senate-joint-resolution',
          'hjres': 'house-joint-resolution',
          'sconres': 'senate-concurrent-resolution',
          'hconres': 'house-concurrent-resolution'
        };
        const urlType = typeMap[type.toLowerCase()] || `${type.toLowerCase()}-bill`;
        const billUrl = `https://www.congress.gov/bill/${congress}th-congress/${urlType}/${number}`;
        const canon = normalizeUrl(billUrl);

        // Check if already seen
        const addCanon = await redis.sadd(SEEN_LINK, canon);
        if (addCanon !== 1) continue; // Already stored

        const mid = idFromCanonical(canon);
        await redis.sadd(SEEN_ID, mid);

        // Get update date (use latestAction date or updateDate)
        const updateDate = bill.latestAction?.actionDate || bill.updateDate || new Date().toISOString();
        const ts = toEpoch(updateDate);

        // Build mention object
        const m = {
          id: mid,
          canon,
          section: "Federal Legislation",
          title: `${billId}: ${title}`,
          link: billUrl,
          source: "Congress.gov",
          matched: ["china", "chinese", "congress"],
          summary: latestAction,
          origin: "congress",
          published_ts: ts,
          published: new Date(ts * 1000).toISOString(),
          // Additional metadata
          bill_number: billId,
          congress_number: congress,
          bill_type: type,
          introduced_date: bill.introducedDate || null,
          latest_action_date: bill.latestAction?.actionDate || null
        };

        // Store in Redis
        await redis.zadd(ZSET, { score: ts, member: JSON.stringify(m) });

        // Trim articles older than RETENTION_DAYS
        const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
        await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

        stored++;
      } catch (err) {
        console.error(`Error processing bill ${bill.number}:`, err);
        errors.push({ bill: bill.number, error: err?.message || String(err) });
      }
    }

    console.log(`Congress collection complete: ${found} matched, ${stored} stored`);

    res.status(200).json({
      ok: true,
      source: "Congress.gov",
      congress,
      total_bills: bills.length,
      matched: found,
      stored,
      errors: errors.length > 0 ? errors : undefined,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error("Congress collection error:", e);
    res.status(500).json({
      ok: false,
      error: `Congress collection failed: ${e?.message || e}`
    });
  }
}
