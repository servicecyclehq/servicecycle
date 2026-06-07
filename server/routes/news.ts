/**
 * routes/news.ts — regulatory / industry news feed.
 *
 * Intended mount (index.ts) — NOT yet wired:
 *   app.use('/api/news', authenticateToken, newsRoutes);
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
router.post('/refresh', requireManager, async (req, res) => {
  try {
    const counts = await runNewsScanner();
    return res.json({ success: true, data: counts });
  } catch (err) {
    console.error('[news/refresh] failed:', err);
    return res.status(500).json({ success: false, error: 'News refresh failed' });
  }
});

module.exports = router;

export {};
