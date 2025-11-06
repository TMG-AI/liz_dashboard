// /api/stream.js - Server-Sent Events for real-time updates
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV2_REST_API_URL,
  token: process.env.KV2_REST_API_TOKEN,
});

export default async function handler(req, res) {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  
  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat ${Date.now()}\n\n`);
  }, 30000); // Every 30 seconds
  
  // Poll for updates (since Vercel doesn't support long-running connections)
  let lastCheck = Math.floor(Date.now() / 1000);
  
  const checkForUpdates = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      
      // Get new mentions since last check
      const newMentions = await redis.zrange(
        'mentions:streamed:z',
        lastCheck,
        now,
        { byScore: true }
      );
      
      if (newMentions.length > 0) {
        const mentions = newMentions
          .map(m => {
            try {
              return JSON.parse(m);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, 5); // Send max 5 at a time
        
        // Send update to client
        const event = {
          type: 'new_mentions',
          count: newMentions.length,
          mentions: mentions,
          timestamp: new Date().toISOString()
        };
        
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        
        // Update counts
        const todayKey = getTodayKey();
        const todayCount = await redis.get(todayKey) || 0;
        
        res.write(`data: ${JSON.stringify({
          type: 'count_update',
          meltwater_count: parseInt(todayCount),
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
      
      lastCheck = now;
    } catch (error) {
      console.error('Error checking for updates:', error);
    }
  };
  
  // Check for updates every 5 seconds
  const updateInterval = setInterval(checkForUpdates, 5000);
  
  // Initial check
  checkForUpdates();
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(updateInterval);
    res.end();
  });
}

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `meltwater:stream:daily:${year}-${month}-${day}`;
}
