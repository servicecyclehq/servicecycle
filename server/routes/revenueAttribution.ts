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
    console.error('[revenue/attribution]', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to build revenue attribution.' });
  }
});

module.exports = router;

export {};
