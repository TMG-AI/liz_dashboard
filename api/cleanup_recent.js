// /api/cleanup_recent.js
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

const ZSET = "mentions:z";
const AGG_DOMAINS = new Set(["cryptopanic.com", "www.cryptopanic.com"]);

function startOfTodayET() {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce((o, p) => {
      if (p.type !== "literal") o[p.type] = p.value;
      return o;
    }, {});
  const iso = `${p.year}-${p.month}-${p.day}T00:00:00-04:00`;
  return Math.floor(new Date(iso).getTime() / 1000);
}
function hostFromUrl(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}
function norm(s) {
  return String(s || "").trim().toLowerCase();
}
function normalizeTitleKey(t) {
  let s = String(t || "").toLowerCase();
  s = s
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[\u2013\u2014]/g, "-");
  s = s.split(" - ")[0].split(" — ")[0].split(" | ")[0];
  s = s.replace(/["'“”‘’()[\]]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
function titleTokens(t) {
  const s = normalizeTitleKey(t);
  const m = s.match(/[a-z0-9]{4,}/g);
  return new Set(m || []);
}
function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter || 1;
  return inter / union;
}

export default async function handler(req, res) {
  try {
    // auth
    const key = (req.headers["x-admin-key"] || req.query?.key || "").toString();
    const allow = key && key === process.env.MW_WEBHOOK_SECRET;
    if (!allow) return res.status(401).json({ ok: false, error: "unauthorized" });

    const win = (req.query?.window || "24h").toString(); // default 24h
    const hours = Number(req.query?.hours || 24);
    const doDelete = String(req.query?.do || "").toLowerCase() === "delete";

    let start = 0;
    if (win === "today") start = startOfTodayET();
    else if (win === "24h" || Number.isFinite(hours))
      start = Math.floor(Date.now() / 1000) - hours * 3600;

    // load all raw members
    const all = await redis.zrange(ZSET, 0, -1); // raw JSON strings
    const stats = {
      total_members: Array.isArray(all) ? all.length : 0,
      parsed_ok: 0,
      parse_failed: 0,
      in_window: 0,
    };

    // parse and filter to window
    const recent = [];
    for (const raw of all || []) {
      try {
        const m = JSON.parse(raw);
        stats.parsed_ok++;
        const ts = Number(m?.published_ts || 0);
        if (start === 0 || ts >= start) {
          recent.push({ raw, obj: m, ts });
          stats.in_window++;
        }
      } catch {
        stats.parse_failed++;
      }
    }

    if (!recent.length) {
      return res.status(200).json({
        ok: true,
        mode: doDelete ? "delete" : "preview",
        window: win,
        scanned: 0,
        to_remove: 0,
        removed: 0,
        by_canon: 0,
        by_title_exact: 0,
        by_title_fuzzy: 0,
        sample: [],
        stats,
      });
    }

    // pass 0: drop exact-duplicate IDs (keep newest)
    const byId = new Map();
    for (const it of recent) {
      const id = norm(it.obj?.id);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(it);
    }
    const dropById = new Set();
    for (const [id, arr] of byId.entries()) {
      if (arr.length <= 1) continue;
      arr.sort((a, b) => b.ts - a.ts);
      for (let i = 1; i < arr.length; i++) dropById.add(arr[i].raw);
    }

    // pass 1: by canonical URL (strict)
    const byCanon = new Map(); // canon -> [items]
    for (const it of recent) {
      const canon = norm(it.obj?.canon || it.obj?.link || "");
      if (!canon) continue;
      if (!byCanon.has(canon)) byCanon.set(canon, []);
      byCanon.get(canon).push(it);
    }
    const dropCanon = new Set();
    for (const [canon, arr] of byCanon.entries()) {
      if (arr.length <= 1) continue;
      arr.sort((a, b) => b.ts - a.ts);
      for (let i = 1; i < arr.length; i++) dropCanon.add(arr[i].raw); // keep newest
    }

    // pass 2: by title exact (aggregator suppression)
    const buckets = new Map(); // key -> {nonAgg:[], agg:[]}
    for (const it of recent) {
      const key = normalizeTitleKey(it.obj?.title);
      if (!key) continue;
      const host = hostFromUrl(it.obj?.canon || it.obj?.link || "");
      const isAgg = AGG_DOMAINS.has(host);
      const tokenSet = titleTokens(it.obj?.title);
      const wrapped = { ...it, isAgg, host, key, tokenSet };
      if (!buckets.has(key)) buckets.set(key, { nonAgg: [], agg: [] });
      (isAgg ? buckets.get(key).agg : buckets.get(key).nonAgg).push(wrapped);
    }

    const dropTitleExact = new Set();
    for (const [key, grp] of buckets.entries()) {
      const sortNew = (arr) => arr.sort((a, b) => b.ts - a.ts);

      if (grp.nonAgg.length) {
        sortNew(grp.nonAgg);
        for (let i = 1; i < grp.nonAgg.length; i++) dropTitleExact.add(grp.nonAgg[i].raw); // older non-agg
        for (const it of grp.agg) dropTitleExact.add(it.raw); // all aggs of same title
      } else if (grp.agg.length) {
        sortNew(grp.agg);
        for (let i = 1; i < grp.agg.length; i++) dropTitleExact.add(grp.agg[i].raw); // older aggs
      }
    }

    // pass 3: fuzzy (aggregator vs non-agg near-match)
    const nonAggAll = [];
    for (const { nonAgg } of buckets.values()) nonAggAll.push(...nonAgg);

    const dropTitleFuzzy = new Set();
    const FUZZY_THRESHOLD = 0.55;
    for (const { agg } of buckets.values()) {
      for (const a of agg) {
        for (const n of nonAggAll) {
          const sim = jaccard(a.tokenSet, n.tokenSet);
          if (sim >= FUZZY_THRESHOLD) {
            dropTitleFuzzy.add(a.raw);
            break;
          }
        }
      }
    }

    const dropSet = new Set([
      ...dropById,
      ...dropCanon,
      ...dropTitleExact,
      ...dropTitleFuzzy,
    ]);

    let removed = 0;
    if (doDelete) {
      for (const member of dropSet) {
        try {
          const r = await redis.zrem(ZSET, member);
          if (r === 1) removed++;
        } catch {}
      }
    }

    // sample up to 10
    const sample = [];
    let count = 0;
    for (const raw of dropSet) {
      if (count >= 10) break;
      try {
        const m = JSON.parse(raw);
        sample.push({
          title: m?.title || null,
          source: m?.source || null,
          link: m?.link || null,
          canon: m?.canon || null,
        });
        count++;
      } catch {}
    }

    return res.status(200).json({
      ok: true,
      mode: doDelete ? "delete" : "preview",
      window: win,
      scanned: recent.length,
      to_remove: dropSet.size,
      removed,
      by_id: dropById.size,
      by_canon: dropCanon.size,
      by_title_exact: dropTitleExact.size,
      by_title_fuzzy: dropTitleFuzzy.size,
      sample,
      stats,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
