/**
 * routes/reports.ts
 * -----------------
 * Compliance report endpoints.
 *
 * GET  /          -- report catalogue (stub; returns empty list while planned
 *                    reports are in development)
 * GET  /emp       -- one-click EMP PDF download (streams bytes directly;
 *                    ?months=24 controls the work-order lookback window).
 *                    For the snapshot-pipeline variant (stored, hash-anchored,
 *                    audit-log entry) use POST /api/compliance/emp-document.
 *
 * Mounted in server/index.ts as:
 *   app.use('/api/reports', authenticateToken, reportRoutes);
 */

'use strict';

const crypto = require('crypto');
const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { buildEmpData, renderEmpPdf } = require('../lib/empDocument');

// -- GET /api/reports ---------------------------------------------------------
router.get('/', async (_req, res) => {
  return res.json({ success: true, data: { reports: [] } });
});

// -- GET /api/reports/emp -----------------------------------------------------
// Generates the NFPA 70B Section 4.2 Electrical Maintenance Program document
// as a PDF and streams it directly to the client.  Unlike POST
// /api/compliance/emp-document this path does NOT store the file or write an
// audit-log entry -- it is a lightweight, on-demand download for operators who
// want the document immediately without going through the snapshot pipeline.
//
// Query params:
//   months   (integer, 6-60, default 24)  -- work-order history lookback window
//   accountId  -- IGNORED; tenancy is enforced via req.user.accountId (JWT).
//                 The parameter exists only so callers can describe intent in
//                 query strings without the server acting on untrusted input.
//
// Response: application/pdf with Content-Disposition: attachment and an
// X-EMP-Document-Id header carrying the ephemeral document UUID (useful for
// correlating a downloaded file with a support request).
router.get('/emp', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    // Parse + clamp months (6-60).
    const rawMonths = parseInt(String(req.query.months || '24'), 10);
    const months = Number.isFinite(rawMonths) ? Math.min(60, Math.max(6, rawMonths)) : 24;

    const empData = await buildEmpData(prisma, accountId, { months });

    // Pre-generate a document UUID for the footer and response header.
    // This is ephemeral -- it does NOT correspond to a ComplianceSnapshot row.
    const docId       = crypto.randomUUID();
    const generatedAt = new Date();

    // Look up the requesting user's name for the cover page.
    let generatedByName = req.user.name || null;
    if (!generatedByName && req.user.id) {
      try {
        const u = await prisma.user.findUnique({
          where:  { id: req.user.id },
          select: { name: true },
        });
        generatedByName = u?.name || 'Unknown user';
      } catch (_) { generatedByName = 'Unknown user'; }
    }

    const pdfBuffer = await renderEmpPdf(empData, {
      snapshotId:      docId,
      accountName:     empData.accountName,
      generatedByName: generatedByName || 'Unknown user',
      generatedAtIso:  generatedAt.toISOString(),
    });

    // Build a safe ASCII filename:  EMP_AccountName_YYYY-MM-DD.pdf
    const safeName = (empData.accountName || 'Account')
      .replace(/[^\w\s-]/g, '')   // strip non-ASCII
      .replace(/\s+/g, '_')       // spaces to underscores
      .slice(0, 64);
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const filename  = `EMP_${safeName}_${dateStamp}.pdf`;

    const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const rfc5987   = encodeURIComponent(filename);

    res.set('Content-Type',           'application/pdf');
    res.set('Content-Disposition',    `attachment; filename="${safeAscii}"; filename*=UTF-8''${rfc5987}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length',         String(pdfBuffer.length));
    res.set('Cache-Control',          'private, no-store');
    res.set('X-EMP-Document-Id',      docId);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[reports/emp]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate EMP document.' });
  }
});

module.exports = router;

export {};
