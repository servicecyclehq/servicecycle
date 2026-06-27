/**
 * routes/news.ts — regulatory / industry news feed.
 *
 * Mounted in index.ts (verified):
 *   app.use('/api/news', authenticateToken, newsRoutes);
 * Rows are also refreshed by a server-side cron every 6 hours
 * (runNewsScanner), independent of the manual /refresh trigger below.
 *
 *   GET  /          — list news items (?category=&search=&page=&limit=)
 *   GET  /summary   — per-category counts, last 14 days (nav badge)
 *   POST /refresh   — run the scanner live (manager+), returns counts
 *
 * ⚠ TENANCY EXCEPTION (deliberate): every other route file scopes every
 * query by req.user.accountId. NewsItem is GLOBAL — it has no accountId
 * column at all. Rows come from public RSS feeds (OSHA newsroom, electrical
 * trade press) and contain zero tenant data, so there is nothing
 * tenant-scoped to leak: every authenticated user on every account sees the
 * same industry-wide feed by design. Do not "fix" this by adding account
 * scoping.
 *
 * RBAC: reads are any authenticated role. /refresh is requireManager — it
 * triggers outbound HTTP to third-party feeds and DB writes, which a viewer
 * shouldn't be able to spam.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const { runNewsScanner } = require('../lib/newsScanner');
import prisma from '../lib/prisma';

const NEWS_CATEGORIES = ['regulatory', 'standards', 'safety', 'industry'];
const DAY_MS = 86_400_000;

// ── GET /api/news ─────────────────────────────────────────────────────────────
// Newest first (publishedAt desc).
//   ?category= regulatory|standards|safety|industry
//   ?search=   case-insensitive contains on title / summary / source
//   ?page / ?limit — pagination (default 1 / 30, limit max 100)
router.get('/', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || '1'),  10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
    const skip  = (page - 1) * limit;

    const where: any = {};

    if (req.query.category !== undefined) {
      const category = String(req.query.category);
      if (!NEWS_CATEGORIES.includes(category)) {
        return res.status(400).json({
          success: false,
          error: `category must be one of ${NEWS_CATEGORIES.join(', ')}`,
        });
      }
      where.category = category;
    }

    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { title:   { contains: search, mode: 'insensitive' } },
        { summary: { contains: search, mode: 'insensitive' } },
        { source:  { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.newsItem.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.newsItem.count({ where }),
    ]);

    return res.json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('[news] list failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch news' });
  }
});

// ── GET /api/news/summary ─────────────────────────────────────────────────────
// Per-category counts over the last 14 days — feeds the nav badge without
// shipping the item list.
router.get('/summary', async (req, res) => {
  try {
    const since = new Date(Date.now() - 14 * DAY_MS);

    const grouped = await prisma.newsItem.groupBy({
      by: ['category'],
      where: { publishedAt: { gte: since } },
      _count: { _all: true },
    });

    const counts: any = { regulatory: 0, standards: 0, safety: 0, industry: 0 };
    let total = 0;
    for (const g of grouped) {
      counts[g.category] = g._count._all;
      total += g._count._all;
    }

    return res.json({ success: true, data: { since, counts, total } });
  } catch (err) {
    console.error('[news/summary] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch news summary' });
  }
});

// ── POST /api/news/refresh ────────────────────────────────────────────────────
// Run the scanner synchronously and return its counts. Manager+ only — this
// fires outbound HTTP to every configured feed (worst case ~10s/feed in
// parallel) and writes to the global table.
//
// COMP-8-14: the scanner is a global outbound-fetch lever — without a guard a
// manager (on any account) could spam third-party RSS endpoints (OSHA, trade
// press) by hammering this route. Two cheap guards, process-wide because the
// target feeds are global, not per-tenant:
//   - an in-flight latch so concurrent calls don't fan out duplicate scans;
//   - a cooldown window (default 10 min; the cron refreshes every 6h anyway, so
//     manual refresh is a convenience, not a data-freshness requirement).
// Tunable via NEWS_REFRESH_COOLDOWN_MS. Returns 429 with retryAfter when hot.
const NEWS_REFRESH_COOLDOWN_MS = Math.max(0, parseInt(String(process.env.NEWS_REFRESH_COOLDOWN_MS || ''), 10) || 10 * 60 * 1000);
let _newsRefreshInFlight = false;
let _newsLastRefreshAt = 0;

router.post('/refresh', requireManager, async (req, res) => {
  if (_newsRefreshInFlight) {
    return res.status(429).json({ success: false, error: 'A news refresh is already running — try again shortly.' });
  }
  const sinceLast = Date.now() - _newsLastRefreshAt;
  if (_newsLastRefreshAt && sinceLast < NEWS_REFRESH_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((NEWS_REFRESH_COOLDOWN_MS - sinceLast) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      success: false,
      error: `News was refreshed recently — wait ${retryAfterSec}s before refreshing again. The feed also auto-updates every few hours.`,
      data: { retryAfterSeconds: retryAfterSec },
    });
  }
  _newsRefreshInFlight = true;
  try {
    const counts = await runNewsScanner();
    _newsLastRefreshAt = Date.now();
    return res.json({ success: true, data: counts });
  } catch (err) {
    console.error('[news/refresh] failed:', err);
    return res.status(500).json({ success: false, error: 'News refresh failed' });
  } finally {
    _newsRefreshInFlight = false;
  }
});

module.exports = router;

export {};
