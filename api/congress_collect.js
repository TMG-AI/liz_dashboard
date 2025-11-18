// /api/congress_collect.js
// Tracks HR 3838 (119th Congress) with milestone tracking
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";
const RETENTION_DAYS = 14;

// Tracked bill configuration
const TRACKED_BILL = {
  congress: "119",
  type: "hr",
  number: "3838"
};

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

// Detect milestones from actions
function detectMilestones(actions) {
  const milestones = {
    conference_committee: false,
    conference_report_filed: false,
    house_vote_scheduled: false,
    house_vote_completed: false,
    senate_vote_scheduled: false,
    senate_vote_completed: false,
    sent_to_president: false,
    signed_into_law: false
  };

  if (!actions || !Array.isArray(actions)) return milestones;

  for (const action of actions) {
    const text = (action.text || "").toLowerCase();

    // Conference committee
    if (text.includes("conference committee") || text.includes("conferees appointed")) {
      milestones.conference_committee = true;
    }

    // Conference report filed
    if (text.includes("conference report filed") || text.includes("conference report submitted")) {
      milestones.conference_report_filed = true;
    }

    // House vote scheduled
    if (text.includes("house") && (text.includes("scheduled") || text.includes("rule provides"))) {
      milestones.house_vote_scheduled = true;
    }

    // House vote completed
    if (text.includes("house") && (text.includes("passed") || text.includes("agreed to") || text.includes("on passage"))) {
      milestones.house_vote_completed = true;
    }

    // Senate vote scheduled
    if (text.includes("senate") && text.includes("scheduled")) {
      milestones.senate_vote_scheduled = true;
    }

    // Senate vote completed
    if (text.includes("senate") && (text.includes("passed") || text.includes("agreed to"))) {
      milestones.senate_vote_completed = true;
    }

    // Sent to President
    if (text.includes("presented to president") || text.includes("sent to president")) {
      milestones.sent_to_president = true;
    }

    // Signed into law
    if (text.includes("signed by president") || text.includes("became public law")) {
      milestones.signed_into_law = true;
    }
  }

  return milestones;
}

// Fetch bill details
async function fetchBillDetails(congress, type, number, apiKey) {
  try {
    const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}?api_key=${apiKey}&format=json`;

    const response = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`Bill API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.bill || null;
  } catch (error) {
    console.error("Error fetching bill details:", error);
    return null;
  }
}

// Fetch amendments
async function fetchAmendments(congress, type, number, apiKey) {
  try {
    const url = `https://api.congress.gov/v3/bill/${congress}/${type}/${number}/amendments?api_key=${apiKey}&format=json`;

    const response = await fetch(url, {
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.log(`Amendments API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.amendments || [];
  } catch (error) {
    console.error("Error fetching amendments:", error);
    return [];
  }
}

export default async function handler(req, res) {
  try {
    const apiKey = process.env.CONGRESS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "CONGRESS_API_KEY not configured"
      });
    }

    const { congress, type, number } = TRACKED_BILL;
    const billId = `${type.toUpperCase()} ${number}`;

    console.log(`Fetching bill: ${billId} (${congress}th Congress)`);

    // Fetch bill details
    const bill = await fetchBillDetails(congress, type, number, apiKey);

    if (!bill) {
      return res.status(500).json({
        ok: false,
        error: "Failed to fetch bill details"
      });
    }

    // Fetch amendments
    const amendments = await fetchAmendments(congress, type, number, apiKey);
    console.log(`Found ${amendments.length} amendments`);

    // Build bill URL
    const billUrl = `https://www.congress.gov/bill/${congress}th-congress/house-bill/${number}`;
    const canon = normalizeUrl(billUrl);

    // Detect milestones from actions
    const milestones = detectMilestones(bill.actions?.actions || []);

    // Get latest action
    const latestAction = bill.latestAction?.text || "No recent action";
    const actionDate = bill.latestAction?.actionDate || new Date().toISOString();
    const ts = toEpoch(actionDate);

    // Build milestone summary
    const milestoneList = [];
    if (milestones.conference_committee) milestoneList.push("✓ Conference Committee");
    if (milestones.conference_report_filed) milestoneList.push("✓ Conference Report Filed");
    if (milestones.house_vote_completed) milestoneList.push("✓ House Vote");
    if (milestones.senate_vote_completed) milestoneList.push("✓ Senate Vote");
    if (milestones.sent_to_president) milestoneList.push("✓ Sent to President");
    if (milestones.signed_into_law) milestoneList.push("✓ SIGNED INTO LAW");

    const summary = `${bill.title || ""}

Latest Action (${actionDate}): ${latestAction}

Milestones: ${milestoneList.length > 0 ? milestoneList.join(" | ") : "No milestones reached yet"}

Amendments: ${amendments.length}`;

    // Check if already stored (update if exists)
    const mid = idFromCanonical(canon);

    // Build mention object
    const m = {
      id: mid,
      canon,
      section: "Congress.gov",
      title: `${billId}: ${bill.title || ""}`,
      link: billUrl,
      source: "Congress.gov",
      matched: ["congress", "hr3838"],
      summary: summary,
      origin: "congress",
      published_ts: ts,
      published: new Date(ts * 1000).toISOString(),
      // Additional metadata
      bill_number: billId,
      congress_number: congress,
      milestones: milestones,
      amendments_count: amendments.length,
      latest_action: latestAction,
      latest_action_date: actionDate
    };

    // Store in Redis (using zadd which will update if exists)
    await redis.sadd(SEEN_ID, mid);
    await redis.sadd(SEEN_LINK, canon);
    await redis.zadd(ZSET, { score: ts, member: JSON.stringify(m) });

    // Trim old articles
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (RETENTION_DAYS * 24 * 60 * 60);
    await redis.zremrangebyscore(ZSET, '-inf', cutoffTimestamp);

    console.log(`Bill ${billId} updated successfully`);

    res.status(200).json({
      ok: true,
      bill: billId,
      congress: congress,
      milestones: milestones,
      amendments_count: amendments.length,
      latest_action: latestAction,
      latest_action_date: actionDate,
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
