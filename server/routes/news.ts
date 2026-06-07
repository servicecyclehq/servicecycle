const express = require('express');
const { requireAdmin, requireManager } = require('../middleware/roles');
// Note: news feed URLs are HARDCODED in lib/newsScanner.js (RSS_FEEDS).
// There's no operator-configurable feed URL today, so this route surface
// is SSRF-free. If a future feature lets admins add custom feeds, gate
// new URLs behind a private-IP / loopback allowlist before fetching.
const { runNewsScanner } = require('../lib/newsScanner');
import prisma from '../lib/prisma';

// v0.89.6: newsOutageRegion is stored as a comma-separated text value so the
// schema column (TEXT) doesn't need to change. Single value 'global' (legacy
// pre-v0.89.6) parses to ['global']; 'us,eu' parses to ['us','eu']; empty
// or null parses to []. Whitespace is tolerated.
function parseRegions(raw) {
  if (!raw) return [];
  return String(raw).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}

const router = express.Router();

// ── GET /api/news ─────────────────────────────────────────────────────────────
// Returns news items for this account, newest first.
// Optional query params:
//   vendorId  — filter to a specific vendor
//   category  — filter by category
//   unread    — "true" to show only unread items (per-user)
//   limit     — max items to return (default 50, max 100)
//   offset    — for pagination
//
// Read-state is now per-user (UserNewsRead join). The old per-row
// vendor_news.isRead column is no longer consulted.
router.get('/', async (req, res) => {
  try {
    const { vendorId, vendorIds, vendorNames, category, unread, view, limit = '50', offset = '0' } = req.query;
    const userId = req.user.id;

    const where: any = { accountId: req.user.accountId };
    if (vendorId) where.vendorId = vendorId;

    // v0.89.7: multi-vendor filter to match the Excel-style ColumnFilterDropdown
    // on /news (mirrors ContractsList). Accepts either vendorIds (UUID list)
    // or vendorNames (account-scoped lookup). Both work additively.
    if (vendorNames || vendorIds) {
      const idList = vendorIds
        ? String(vendorIds).split(',').map(s => s.trim()).filter(Boolean)
        : [];
      if (vendorNames) {
        const names = String(vendorNames).split(',').map(s => s.trim()).filter(Boolean);
        if (names.length > 0) {
          const matched = await prisma.vendor.findMany({
            where:  { accountId: req.user.accountId, name: { in: names } },
            select: { id: true },
          });
          for (const v of matched) idList.push(v.id);
        }
      }
      if (idList.length > 0) where.vendorId = { in: idList };
    }

    if (category) where.category = category;
    // unread filter applied AFTER the LEFT JOIN below so we keep one query.
    if (unread === 'true') where.reads = { none: { userId } };

    // v0.89.5: view-based category split. `view=headlines` (default in the SPA)
    // excludes the outage category so status-page noise doesn't drown out real
    // news; `view=outages` shows ONLY the outage category and applies the
    // account-level region filter. `view=all` (or unset) preserves old behavior
    // for any consumer that hasn't migrated.
    if (view === 'headlines') {
      where.category = { not: 'outage' };
    } else if (view === 'outages') {
      where.category = 'outage';
      // v0.89.6: newsOutageRegion is a comma-separated list of regions.
      // Semantics: empty/null or contains 'global' -> no filter (show all).
      // Otherwise show rows whose region is in the list OR is 'global' OR
      // is null (undetectable -> shown to everyone, fail-open).
      const acct = await prisma.account.findUnique({
        where:  { id: req.user.accountId },
        select: { newsOutageRegion: true },
      });
      const regions = parseRegions(acct && acct.newsOutageRegion);
      if (regions.length > 0 && !regions.includes('global')) {
        where.OR = [
          { region: { in: regions } },
          { region: 'global' },
          { region: null },
        ];
      }
    }

    const take = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = parseInt(offset, 10) || 0;

    const [items, total, unreadCount] = await Promise.all([
      prisma.vendorNews.findMany({
        where,
        select: {
          id: true, title: true, url: true, source: true, summary: true,
          category: true, publishedAt: true, region: true,
          watchTerm: true, userId: true,
          vendor: { select: { id: true, name: true } },
          reads: {
            where:  { userId },
            select: { readAt: true },
            take:   1,
          },
        },
        orderBy: { publishedAt: 'desc' },
        take,
        skip,
      }),
      prisma.vendorNews.count({ where }),
      // unreadCount reflects the CURRENT view so the page-header badge stays
      // accurate as the user switches tabs.
      prisma.vendorNews.count({
        where: { ...where, reads: { none: { userId } } },
      }),
    ]);

    // Flatten the `reads` projection into an `isRead` boolean so the SPA
    // contract is unchanged.
    const shaped = items.map(({ reads, ...rest }) => ({
      ...rest,
      isRead: reads.length > 0,
    }));

    return res.json({ success: true, data: { items: shaped, total, unreadCount, take, skip } });
  } catch (err) {
    console.error('GET /news error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch news' });
  }
});

// ── GET /api/news/summary ─────────────────────────────────────────────────────
// Returns unread counts per vendor for THIS user — used for vendor list badges.
// Only counts vendor-matched items (vendorId not null).
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = req.user.accountId;

    // v0.89.5: load region preference + compute split unread counts so the
    // NewsPage tabs can render their own badges in one round-trip.
    const acct = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { newsOutageRegion: true },
    });
    const regions = parseRegions(acct && acct.newsOutageRegion);
    const newsOutageRegion = (acct && acct.newsOutageRegion) || 'global';

    const outageWhere: any = { accountId, category: 'outage' };
    if (regions.length > 0 && !regions.includes('global')) {
      outageWhere.OR = [
        { region: { in: regions } },
        { region: 'global' },
        { region: null },
      ];
    }

    const [perVendorRows, unreadHeadlines, unreadOutages] = await Promise.all([
      prisma.vendorNews.groupBy({
        by: ['vendorId'],
        where: {
          accountId,
          vendorId:  { not: null },
          reads:     { none: { userId } },
        },
        _count: { id: true },
      }),
      prisma.vendorNews.count({
        where: { accountId, category: { not: 'outage' }, reads: { none: { userId } } },
      }),
      prisma.vendorNews.count({
        where: { ...outageWhere, reads: { none: { userId } } },
      }),
    ]);

    const counts: any = {};
    perVendorRows.forEach(r => { if (r.vendorId) counts[r.vendorId] = r._count.id; });

    // v0.90.9: validate /api/news/summary shape. Drives Navbar badge + tab
    // counts. Was the v0.89.7 cascade origin (wrong Prisma relation name) --
    // exactly the bug class this layer is designed to catch.
    const { validateResponse } = require('../lib/responseValidator');
    const { newsSummarySchema } = require('../schemas/api');
    const payload: any = {
      success: true,
      data: {
        counts,
        unreadHeadlines,
        unreadOutages,
        newsOutageRegion,
      },
    };
    return res.json(validateResponse('/api/news/summary', newsSummarySchema, payload, req));
  } catch (err) {
    console.error('GET /news/summary error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch news summary' });
  }
});

// ── PUT /api/news/:id/read ────────────────────────────────────────────────────
// Marks this news item as read FOR THE CURRENT USER (not the account).
// === GET /api/news/distinct/vendor (v0.89.7) =================================
// Returns distinct vendor NAMES that have at least one news row for this
// account. Powers the ColumnFilterDropdown on NewsPage (same look-and-feel as
// the per-column vendor filter on ContractsList). Sorted alphabetically.
router.get('/distinct/vendor', async (req, res) => {
  try {
    const rows = await prisma.vendor.findMany({
      where: {
        accountId: req.user.accountId,
        news: { some: {} },
      },
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const values = rows.map(r => r.name).filter(Boolean);
    return res.json({ success: true, values });
  } catch (err) {
    console.error('GET /news/distinct/vendor error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch vendor list' });
  }
});

router.put('/:id/read', async (req, res) => {
  try {
    const item = await prisma.vendorNews.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!item) return res.status(404).json({ success: false, error: 'Item not found' });

    // Idempotent: upsert a UserNewsRead row keyed by (userId, newsId). A
    // second click is a no-op rather than a unique-constraint violation.
    await prisma.userNewsRead.upsert({
      where:  { userId_newsId: { userId: req.user.id, newsId: item.id } },
      create: { userId: req.user.id, newsId: item.id },
      update: { /* readAt stays — first-read timestamp wins */ },
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to mark as read' });
  }
});

// ── PUT /api/news/read-all ────────────────────────────────────────────────────
// Must be before /:id to avoid param collision. Marks every news item the
// current user hasn't yet read as read FOR THE CURRENT USER ONLY. Doesn't
// touch other users' read state — the previous (broken) behaviour was an
// account-wide flag; the requireManager gate on the old route was a
// workaround until this per-user model landed. The gate is no longer
// strictly necessary but kept since marking all-as-read is still a
// destructive op against personal queue state.
router.put('/read-all', requireManager, async (req, res) => {
  try {
    const userId = req.user.id;
    const { vendorId } = req.body;

    // Find every news item this user hasn't yet read. Bulk-create reads.
    const candidates = await prisma.vendorNews.findMany({
      where: {
        accountId: req.user.accountId,
        ...(vendorId ? { vendorId } : {}),
        reads:     { none: { userId } },
      },
      select: { id: true },
    });

    if (candidates.length === 0) return res.json({ success: true, marked: 0 });

    const data = candidates.map((c) => ({ userId, newsId: c.id }));
    // skipDuplicates handles the race where another tab marks the same row
    // read between our find and our createMany.
    await prisma.userNewsRead.createMany({ data, skipDuplicates: true });

    return res.json({ success: true, marked: candidates.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to mark all as read' });
  }
});

// ── POST /api/news/scan ───────────────────────────────────────────────────────
// Admin-only: manually trigger the news scanner (useful for testing / first run)
router.post('/scan', requireAdmin, async (req, res) => {
  try {
    // Run async — don't wait for completion, return immediately
    runNewsScanner()
      .then(r => console.log('[news/scan] Complete:', r))
      .catch(e => console.error('[news/scan] Error:', e));

    return res.json({ success: true, message: 'Scanner started — results will appear within a few minutes.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to start scanner' });
  }
});

// ── GET /api/news/watches ─────────────────────────────────────────────────────
// Returns the current user's personal watch terms.
router.get('/watches', async (req, res) => {
  try {
    const watches = await prisma.userNewsWatch.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, term: true, createdAt: true },
    });
    return res.json({ success: true, data: { watches } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch watch terms' });
  }
});

// ── POST /api/news/watches ────────────────────────────────────────────────────
// Add a new watch term for the current user (max 20 per user).
router.post('/watches', async (req, res) => {
  try {
    const term = (req.body.term || '').trim().slice(0, 100);
    if (!term) return res.status(400).json({ success: false, error: 'Term is required' });

    // Cap at 20 watch terms per user
    const count = await prisma.userNewsWatch.count({ where: { userId: req.user.id } });
    if (count >= 20) {
      return res.status(400).json({ success: false, error: 'Maximum 20 watch terms allowed per user' });
    }

    const watch = await prisma.userNewsWatch.create({
      data: { userId: req.user.id, term },
      select: { id: true, term: true, createdAt: true },
    });
    return res.status(201).json({ success: true, data: { watch } });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'You are already watching that term' });
    }
    return res.status(500).json({ success: false, error: 'Failed to add watch term' });
  }
});

// ── DELETE /api/news/watches/:id ──────────────────────────────────────────────
router.delete('/watches/:id', async (req, res) => {
  try {
    const watch = await prisma.userNewsWatch.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!watch) return res.status(404).json({ success: false, error: 'Watch term not found' });

    await prisma.userNewsWatch.delete({ where: { id: watch.id } });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete watch term' });
  }
});

// â”€â”€ PUT /api/news/region (v0.89.5) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admin-only. Sets the account-level Outages tab region filter. Allowed values:
//   global | us | eu | apac
// When the value is anything other than 'global', /api/news?view=outages
// (and the unreadOutages count on /summary) only return rows whose detected
// region matches the account region OR is 'global' OR is null (undetectable).
router.put('/region', requireAdmin, async (req, res) => {
  try {
    const ALLOWED = ['global', 'us', 'eu', 'apac'];
    const raw = (req.body && req.body.region);
    let tokens;
    if (Array.isArray(raw)) {
      tokens = raw.map(s => String(s).toLowerCase().trim()).filter(Boolean);
    } else {
      tokens = String(raw || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    }
    if (tokens.length === 0) tokens = ['global'];
    // Dedupe
    tokens = [...new Set(tokens)];
    // Validate every token
    const bad = tokens.filter(t => !ALLOWED.includes(t));
    if (bad.length > 0) {
      return res.status(400).json({ success: false, error: 'Invalid region(s): ' + bad.join(', ') + '. Allowed: ' + ALLOWED.join(', ') });
    }
    // If 'global' is selected together with specific regions, "global" wins
    // semantically (show all). Normalize to just 'global' so storage matches
    // semantics. Otherwise store the sorted list for canonical form.
    const value = tokens.includes('global') ? 'global' : tokens.sort().join(',');
    const updated = await prisma.account.update({
      where:  { id: req.user.accountId },
      data:   { newsOutageRegion: value },
      select: { id: true, newsOutageRegion: true },
    });
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /news/region error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update region preference' });
  }
});

module.exports = router;

export {};
