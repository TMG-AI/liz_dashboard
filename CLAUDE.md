# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Liz Dashboard** - a media monitoring and alerting system that:
- Collects AI and legal tech news from RSS feeds, Google Alerts, Law360, Meltwater, and newsletters
- Educates lawyers on effective AI use in legal practice
- Tracks new case law and regulatory developments related to AI
- Stores and deduplicates articles in Redis (Upstash)
- Provides a web dashboard to view mentions and analytics
- Runs automated collection via Vercel cron jobs
- Focuses on AI in legal practice, legal tech, and AI-related case law

## Architecture

**Serverless Functions** (`/api/` directory):
- Each `.js` file is a Vercel serverless function
- Uses Node.js ES modules (`"type": "module"` in package.json)
- All functions connect to Upstash Redis for data storage

**Key Components**:
- `collect.js` - Main RSS collection cron job (runs every 4 hours via vercel.json)
- `newsletter_rss_collect.js` - Newsletter RSS collector with AI/legal keyword filtering (runs every 4 hours)
- `meltwater_collect.js` - Meltwater API collector for searchid 27864701 (runs every 4 hours)
- `meltwater_webhook.js` - Receives real-time Meltwater alerts (webhook)
- `ga_webhook.js` - Receives Google Alerts via webhook
- `summary.js` - API endpoint that returns dashboard data
- `meltwater_summary.js` - API endpoint for Meltwater searchid 27864701 data
- `index.html` - Main dashboard frontend (no build step)
- `meltwater.html` - Dedicated Meltwater dashboard for searchid 27864701

**Data Storage**:
- Uses Upstash Redis with sorted sets for time-ordered mentions
- Primary key: `mentions:z` (sorted set by timestamp)
- Deduplication via `mentions:seen:canon` (canonical URLs)
- Additional sets for sentiment analysis and spike detection

## Environment Variables

Required for production:
- `KV2_REST_API_URL` - Upstash Redis URL (KV2 specific to Liz Dashboard)
- `KV2_REST_API_TOKEN` - Upstash Redis token (KV2 specific to Liz Dashboard)

Entity-specific RSS feeds (Google Alerts or similar):
- `RSS_FEED_DELTA_AIR_LINES` - RSS feed URL for Delta Air Lines articles
- `RSS_FEED_GUARDANT_HEALTH` - RSS feed URL for Guardant Health articles
- `RSS_FEED_ALBEMARLE` - RSS feed URL for Albemarle articles
- `RSS_FEED_ADELANTO_HEALTHCARE` - RSS feed URL for Adelanto Healthcare articles
- `RSS_FEED_CARLOS_ZAFARINI` - RSS feed URL for Carlos Zaffirini Jr. articles
- `RSS_FEED_STUBHUB` - RSS feed URL for StubHub articles

Legacy/Optional:
- `RSS_FEEDS` - Semicolon or comma-separated list of RSS feed URLs (fallback for non-entity feeds)
- `RESEND_API_KEY` - For email notifications (optional)
- `GA_WEBHOOK_SECRET` - Google Alerts webhook auth (optional)

## Development Commands

**No build process required** - this is a static site with serverless functions.

**Local development**:
```bash
# Install dependencies
npm install

# Run locally with Vercel CLI
vercel dev
```

**Testing**:
- Test individual API endpoints: `node api/[filename].js` (if modified for local execution)
- Test RSS collection: Hit `/api/collect` endpoint
- Test webhooks: POST to `/api/meltwater_webhook` or `/api/ga_webhook`

## Key Files to Understand

**Core Logic**:
- `api/collect.js:1-100` - RSS parsing, keyword matching, Redis storage
- `api/summary.js:1-50` - Dashboard data aggregation and time windows
- `api/meltwater_webhook.js:25-50` - Meltwater data transformation

**Configuration**:
- `vercel.json` - Cron schedule and CORS headers
- `package.json` - Minimal dependencies (Redis, RSS parser, Resend)

**Frontend**:
- `index.html` - Complete dashboard UI with vanilla JavaScript
- No framework - uses fetch() API to load data from `/api/summary`

## Deployment

Deployed on Vercel with:
- Automatic cron job execution (`/api/collect` every 5 minutes)
- Environment variables set in Vercel dashboard
- Redis storage via Upstash integration

## Data Flow

1. **RSS Collection**: Cron job fetches feeds → parses articles → matches keywords → stores in Redis
2. **Webhook Ingestion**: External services POST to webhook endpoints → transform data → store in Redis
3. **Dashboard**: Frontend fetches from `/api/summary` → displays mentions by time period and source
4. **Deduplication**: All mentions checked against canonical URL set to prevent duplicates