// Test endpoint to diagnose RSS feed issues
import Parser from "rss-parser";

const parser = new Parser({
  customFields: {
    item: [
      ['media:group', 'media', { keepArray: false }],
      ['media:description', 'mediaDescription'],
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumb', { keepArray: false }],
    ]
  },
  requestOptions: {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
    },
    timeout: 10000
  }
});

export default async function handler(req, res) {
  const results = {
    environment_check: {
      RSS_FEEDS: !!process.env.RSS_FEEDS,
      RSS_FEEDS_length: (process.env.RSS_FEEDS || "").split(/[,;]/).filter(s => s.trim()).length,
      LAW360_RSS_FEED: !!process.env.LAW360_RSS_FEED,
      NEWSLETTER_RSS_FEEDS: !!process.env.NEWSLETTER_RSS_FEEDS,
      NEWSLETTER_RSS_FEEDS_length: (process.env.NEWSLETTER_RSS_FEEDS || "").split(/[,;]/).filter(s => s.trim()).length,
      MELTWATER_API_KEY: !!process.env.MELTWATER_API_KEY,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      KV2_REST_API_URL: !!process.env.KV2_REST_API_URL,
      KV2_REST_API_TOKEN: !!process.env.KV2_REST_API_TOKEN
    },
    feed_tests: []
  };

  // Test Google Alerts feed
  if (process.env.RSS_FEEDS) {
    const feeds = process.env.RSS_FEEDS.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    for (const url of feeds) {
      const test = {
        name: 'Google Alerts',
        url: url.substring(0, 50) + '...', // Truncate for security
        status: 'pending',
        error: null,
        item_count: 0
      };

      try {
        const feed = await parser.parseURL(url);
        test.status = 'success';
        test.item_count = feed?.items?.length || 0;
        test.feed_title = feed?.title || 'Unknown';
      } catch (err) {
        test.status = 'error';
        test.error = err?.message || String(err);
      }

      results.feed_tests.push(test);
    }
  }

  // Test Law360 feed
  if (process.env.LAW360_RSS_FEED) {
    const url = process.env.LAW360_RSS_FEED.trim();
    const test = {
      name: 'Law360',
      url: url.substring(0, 50) + '...', // Truncate for security
      status: 'pending',
      error: null,
      item_count: 0
    };

    try {
      const feed = await parser.parseURL(url);
      test.status = 'success';
      test.item_count = feed?.items?.length || 0;
      test.feed_title = feed?.title || 'Unknown';
    } catch (err) {
      test.status = 'error';
      test.error = err?.message || String(err);
    }

    results.feed_tests.push(test);
  }

  // Test Newsletter RSS feeds (just first one to avoid timeout)
  if (process.env.NEWSLETTER_RSS_FEEDS) {
    const feeds = process.env.NEWSLETTER_RSS_FEEDS.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const url = feeds[0]; // Test only first feed

    if (url) {
      const test = {
        name: 'Newsletter RSS (first feed only)',
        url: url.substring(0, 50) + '...', // Truncate for security
        status: 'pending',
        error: null,
        item_count: 0,
        note: `Testing 1 of ${feeds.length} newsletter feeds`
      };

      try {
        const feed = await parser.parseURL(url);
        test.status = 'success';
        test.item_count = feed?.items?.length || 0;
        test.feed_title = feed?.title || 'Unknown';
      } catch (err) {
        test.status = 'error';
        test.error = err?.message || String(err);
      }

      results.feed_tests.push(test);
    }
  }

  res.status(200).json(results);
}
