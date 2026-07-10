'use strict';

/**
 * routes/revenueAttribution.ts -- Phase 2 revenue-attribution dashboard.
 *
 * Mounted with auth at the app level:
 *   app.use('/api/revenue', authenticateToken, revenueAttributionRoutes);
 *
 * RBAC: requireManager (admin/manager). This surfaces service pipeline + dollar
 * estimates, same tier as the Reports hub that links to it. Every query is
 * accountId-scoped.
 *
 *   GET /attribution?windowDays=  -- the closed-loop engagement -> pipeline -> $ view
 */

const express = require('express');
const prisma = require('../lib/prisma').default;
const { requireManager } = require('../middleware/roles');
const { buildRevenueAttribution } = require('../lib/revenueAttribution');

const router = express.Router();

router.get('/attribution', requireManager, async (req: any, res: any) => {
  try {
    const windowDays = req.query.windowDays !== undefined ? Number(req.query.windowDays) : undefined;
    const data = await buildRevenueAttribution(prisma, req.user.accountId, { windowDays });
    return res.json({ success: true, data });
  } catch (err: any) {
    // 2026-07-09: proof-of-pattern for the console.* -> req.log migration
    // (pino-http, req-id-bound, redaction already configured in index.ts;
    // this was the first route to actually adopt req.log). Falls back to
    // console.error if req.log is somehow unavailable (pino-http failed to
    // load — see the try/catch around its app.use() in index.ts) so an
    // error is never silently swallowed either way.
    if (req.log) {
      req.log.error({ err }, '[revenue/attribution] failed to build revenue attribution');
    } else {
      console.error('[revenue/attribution]', err?.message || err);
    }
    return res.status(500).json({ success: false, error: 'Failed to build revenue attribution.' });
  }
});

module.exports = router;

export {};
