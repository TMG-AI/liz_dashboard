// /api/spike_detection.js
import { Redis } from "@upstash/redis";
const redis = new Redis({ url: process.env.KV2_REST_API_URL, token: process.env.KV2_REST_API_TOKEN });

const ZSET_SPIKES = "mw:spikes:z";

function startOfTodayET(){
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US",{ timeZone:"America/New_York", year:"numeric",month:"2-digit",day:"2-digit" })
    .formatToParts(now).reduce((o,p)=>{ if(p.type!=="literal") o[p.type]=p.value; return o; },{});
  const iso = `${p.year}-${p.month}-${p.day}T00:00:00-04:00`;
  return Math.floor(new Date(iso).getTime()/1000);
}

export default async function handler(req,res){
  try{
    const win = (req.query?.window || "today").toString();
    const hours = Number(req.query?.hours || 24);
    let start = 0;
    if (win === "today") start = startOfTodayET();
    else if (win === "24h" || Number.isFinite(hours)) start = Math.floor(Date.now()/1000) - hours*3600;

    const raw = await redis.zrange(ZSET_SPIKES, 0, -1); // members are JSON strings
    const items = [];
    for (const s of raw){
      try{
        const o = JSON.parse(s);
        if (!start || (o.ts||0) >= start) items.push(o);
      }catch{}
    }
    items.sort((a,b)=> (b.ts||0) - (a.ts||0));
    res.status(200).json({ ok:true, window: win, spikes: items.slice(0,20) });
  }catch(e){
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
}
