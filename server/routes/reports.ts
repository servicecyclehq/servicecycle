/**
 * Compliance reports — stub router.
 *
 * The inherited renewal-spend report suite (executive spend, budget
 * forecast, vendor concentration, auto-renewal exposure, ...) was built
 * around the Contract/Vendor/PurchaseOrder models and was removed in the
 * ServiceCycle conversion.
 *
 * The replacement compliance report suite lands in a later session:
 *   - NFPA 70B compliance rate by site (schedules completed on time vs
 *     overdue, per site and account-wide)
 *   - Overdue maintenance by deficiency severity (IMMEDIATE / RECOMMENDED /
 *     ADVISORY rollups with aging buckets)
 *   - Audit evidence pack (work-order history + test measurements + NETA
 *     decal trail for a site/date range, exportable for an AHJ or insurer)
 *
 * Until then this router returns an empty report list so the client's
 * Reports hub renders its empty state instead of 404ing.
 *
 * Mounted in server/index.js as:
 *   app.use('/api/reports', authenticateToken, reportRoutes);
 * — authenticateToken stays applied at the mount, so every route here is
 * auth-gated even while stubbed.
 */

'use strict';

const router = require('express').Router();

// ── GET /api/reports ──────────────────────────────────────────────────────────
// Returns the (currently empty) list of available compliance reports.
router.get('/', async (_req, res) => {
  return res.json({ success: true, data: { reports: [] } });
});

module.exports = router;

export {};
