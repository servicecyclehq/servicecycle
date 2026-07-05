'use strict';

/**
 * routes/protectionCurves.ts
 * ----------------------------
 * GET /api/protection-curves?assetId=X   -- list curves for an asset (or account-wide)
 * GET /api/protection-curves/:id         -- single curve detail
 *
 * Backend-only scaffolding for the interactive TCC visualization (2026-07-05,
 * §10 A3). No UI, no wiring into /reports/arc-flash rendering -- see
 * lib/protectionCurves.ts header comment (and
 * docs/scoping/audits/tcc-curve-source-availability.md) for the honest state
 * of curve-point data availability before assuming this is populated from
 * AFX import.
 *
 * Gating: requireManager, matching routes/arcFlashIngest.ts and
 * routes/installedBase.ts (arc-flash-adjacent technical data). Tenancy: every
 * query scoped by req.user.accountId inside lib/protectionCurves.ts.
 *
 * Mount (server/index.ts):
 *   const protectionCurveRoutes = require('./routes/protectionCurves');
 *   app.use('/api/protection-curves', authenticateToken, protectionCurveRoutes);
 */

const express = require('express');
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const { listProtectionCurves, getProtectionCurve, ProtectionCurveNotFoundError } = require('../lib/protectionCurves');

const router = express.Router();

// ── GET / ── list, optionally filtered by ?assetId= / ?protectiveDeviceId= ──
router.get('/', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const rows = await listProtectionCurves(prisma, accountId, {
      assetId: req.query.assetId,
      protectiveDeviceId: req.query.protectiveDeviceId,
    });
    res.json({ success: true, data: { curves: rows } });
  } catch (e) {
    console.error('protection-curves list error:', e);
    res.status(500).json({ success: false, error: 'Failed to list protection curves' });
  }
});

// ── GET /:id ── single curve detail ──────────────────────────────────────────
router.get('/:id', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const row = await getProtectionCurve(prisma, accountId, String(req.params.id));
    res.json({ success: true, data: row });
  } catch (e: any) {
    if (e instanceof ProtectionCurveNotFoundError || e?.code === 'PROTECTION_CURVE_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Protection curve not found' });
    }
    console.error('protection-curves detail error:', e);
    res.status(500).json({ success: false, error: 'Failed to load protection curve' });
  }
});

module.exports = router;

export {};
