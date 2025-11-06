// /api/dedupes.js
import { Redis } from "@upstash/redis";

const r = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const SEEN_ID = "mentions:seen";
const SEEN_LINK = "mentions:seen:canon";

// Aggregators we prefer to drop if an original exists
const AGG_DOMAINS = new Set(["cryptopanic.com", "www.cryptopanic.com"]);

// ---- helpers ----
function toObj(x) {
  if (!x) return null;
  if (typeof x === "object" && x.id && (x.link || x.canon)) return x;
  try {
    return JSON.parse(typeof x === "string" ? x : x.toString("utf-8"));
  } catch {
    return null;
  }
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    // unwrap Meltwater redirect (&u=real)
    if (/t\.notifications\.meltwater\.com/i.test(url.hostname) && url.searchParams.get("u")) {
      return normalizeUrl(decodeURIComponent(url.searchParams.get("u")));
    }
    url.hash = "";
    [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
      "mc_cid", "mc_eid", "ref", "fbclid", "gclid", "igshid",
    ].forEach((p) => url.searchParams.delete(p));
    if ([...url.searchParams.keys()].length === 0) url.search = "";
    url.hostname = url.hostname.toLowerCase();
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return (u || "").trim();
  }
}

function hostFromUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeTitleKey(t) {
  let s = String(t || "").toLowerCase();
  s = s.replace(/[\u2018\u2019\u201C\u201D]/g, "'").replace(/[\u2013\u2014]/g, "-");
  s = s.split(" - ")[0].split(" — ")[0].split(" | ")[0]; // drop trailing site suffixes
  s = s.replace(/["'“”‘’()[\]]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ---- handler ----
export default async function handler(req, res) {
  try {
    // mode: preview or delete
    const doDelete = String(req.query?.do || "").toLowerCase() === "delete";

    // Load newest ~2000 (descending by score)
    const rawMembers = await r.zrange(ZSET, 0, 2000, { rev: true });

    // Keep both the raw member (exact string for zrem) AND parsed object
    const items = [];
    let parsed_ok = 0, parse_failed = 0;
    for (const raw of rawMembers) {
      const obj = toObj(raw);
      if (obj) {
        // ensure we have fields we need
        const canon = obj.canon || normalizeUrl(obj.link || "");
        const title = obj.title || "";
        items.push({
          raw,        // exact member string for deletion
          obj,
          canon,
          titleKey: normalizeTitleKey(title),
          host: hostFromUrl(canon || obj.link || ""),
          ts: Number(obj.published_ts || 0),
        });
        parsed_ok++;
      } else {
        parse_failed++;
      }
    }

    // Pass 1: strict by canonical URL (keep newest, drop older)
    const seenCanon = new Set();
    const dropRaw = new Set();
    for (const it of items) {
      const canon = it.canon;
      if (!canon) continue;
      const key = canon;
      if (seenCanon.has(key)) {
        dropRaw.add(it.raw); // already saw newer one (rev=true gives newest first)
      } else {
        seenCanon.add(key);
      }
    }

    // Pass 2: title-based with aggregator suppression
    // Group by normalized title
    const byTitle = new Map();
    for (const it of items) {
      if (!it.titleKey) continue;
      if (!byTitle.has(it.titleKey)) byTitle.set(it.titleKey, []);
      byTitle.get(it.titleKey).push(it);
    }

    for (const [key, arr] of byTitle.entries()) {
      // split into non-aggregators vs aggregators
      const nonAgg = [];
      const agg = [];
      for (const it of arr) {
        if (AGG_DOMAINS.has(it.host)) agg.push(it);
        else nonAgg.push(it);
      }

      // Sort each by newest first
      nonAgg.sort((a, b) => b.ts - a.ts);
      agg.sort((a, b) => b.ts - a.ts);

      if (nonAgg.length) {
        // Keep newest non-agg; drop older non-agg
        for (let i = 1; i < nonAgg.length; i++) dropRaw.add(nonAgg[i].raw);
        // Drop all aggregators for the same title
        for (const it of agg) dropRaw.add(it.raw);
      } else if (agg.length > 1) {
        // If only aggregators exist, keep newest aggregator; drop older
        for (let i = 1; i < agg.length; i++) dropRaw.add(agg[i].raw);
      }
    }

    // Delete phase
    let removed = 0;
    if (doDelete && dropRaw.size) {
      for (const raw of dropRaw) {
        try {
          // remove the exact member string
          const r1 = await r.zrem(ZSET, raw);
          // best-effort: also clear SEEN sets for this member
          const obj = toObj(raw) || {}; // raw is a string; try parse again for id/canon
          const id = obj.id;
          const canon = obj.canon || normalizeUrl(obj.link || "");
          if (id) { try { await r.srem(SEEN_ID, id); } catch {}
          }
          if (canon) { try { await r.srem(SEEN_LINK, canon); } catch {} }
          if (r1 === 1) removed++;
        } catch {}
      }
    }

    res.status(200).json({
      ok: true,
      mode: doDelete ? "delete" : "preview",
      scanned: items.length,
      to_remove: dropRaw.size,
      removed,
      parsed_ok,
      parse_failed,
      sample: [...dropRaw].slice(0, 5).map((raw) => {
        const o = toObj(raw) || {};
        return { title: o.title || null, source: o.source || null, link: o.link || null, canon: o.canon || null };
      }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
