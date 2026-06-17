/**
 * /api/test-reports/import â€” staged PDF test-report ingest (gem R1, the moat).
 *
 *   POST /preview â€” multipart PDF upload â†’ extract + parse â†’ measurement
 *                   preview + asset match guess. No DB writes; human verifies.
 *   POST /commit  â€” { assetId, testDate, vendor?, techName?, measurements[] }
 *                   â†’ WorkOrder (COMPLETE, the TestMeasurement parent) +
 *                   TestMeasurement rows + auto-generated Deficiency rows from
 *                   failed/at-risk readings. Returns the N4 action summary.
 *
 * Mounted at /api/test-reports/import (authenticateToken + ingestLimiter in
 * index.ts). Manager+ for both â€” ingestion writes program-of-record data.
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const { extractPdfText, parseTestReport, severityFor, evaluate } = require('../lib/testReportParse');
const { runDeterministic } = require('../lib/testReportExtract'); // V4 pdfplumber engine
const { aiFillReadings } = require('../lib/aiTestReportExtract'); // W1-AI gap-fill (deterministic-first)
const { sha256Hex, confStats, recordExtraction, findPriorImport, recordCommit } = require('../lib/extractionTelemetry'); // #4 telemetry + #5 fingerprint
const { resolveAsset } = require('../lib/assetIdentity'); // #3 fuzzy asset identity resolution
const { buildTestReportPreview } = require('../lib/testReportPreview'); // #2 shared buffer->preview builder

const MAX_BYTES = 10 * 1024 * 1024;
// #20 photo-of-paper: accept a phone photo of a paper field sheet alongside
// PDFs. Images are wrapped into a single-page PDF below so the same OCR + parse
// pipeline reads them.
const ACCEPTED_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const IMAGE_RE = /\.(jpe?g|png|heic|heif|webp)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req: any, file: any, cb: any) =>
    ACCEPTED_RE.test(file.originalname || '') ? cb(null, true) : cb(new Error('Upload a .pdf or a photo (JPG/PNG/HEIC)')),
});

// â”€â”€ POST /preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// V7: any authenticated role can preview (read-only); commit stays manager+.
// The buffer -> preview pipeline lives in lib/testReportPreview (shared with the
// #2 async ingest worker); this handler owns only request concerns.
router.post('/preview', upload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // #14: oem_admin may preview against a fleet customer account (targetAccountId).
    let accountId: string;
    try { accountId = await resolveIngestAccount(req); }
    catch (e: any) { return res.status(e.httpStatus || 400).json({ success: false, error: e.message }); }

    let data;
    try {
      data = await buildTestReportPreview(req.file.buffer, {
        accountId, userId: req.user.id,
        originalName: req.file.originalname, mimetype: req.file.mimetype,
      });
    } catch (e: any) {
      // Image-wrap failure has a friendlier message than a generic parse failure.
      if (IMAGE_RE.test(req.file.originalname || '')) {
        return res.status(400).json({ success: false, error: 'Could not process that photo. Try a clearer, well-lit image.' });
      }
      throw e;
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[testReport/preview]', err);
    return res.status(500).json({ success: false, error: 'Failed to read the PDF. Is it a text-based test report (not a scan)?' });
  }
});

// commitAssetReadings + HttpableError now live in lib/commitTestReport
// (shared with the #6 email-in auto-commit worker).
const { commitAssetReadings, HttpableError } = require('../lib/commitTestReport');

// #14 contractor bulk ingest: oem_admin may ingest into a fleet customer
// account via targetAccountId (validated in lib/oemTargetAccount).
const { resolveTargetAccount } = require('../lib/oemTargetAccount');
const resolveIngestAccount = resolveTargetAccount;

// commitAssetReadings is imported from lib/commitTestReport (see above).

// â”€â”€ POST /commit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Two shapes:
//   legacy single-asset  { assetId, measurements[], testDate?, vendor?, techName? }
//   #1 multi-section      { sections: [{ assetId? | createAsset:{siteId,equipmentType,
//                          manufacturer?,model?,serialNumber?}, measurements[] }], ... }
// The multi-section form writes every asset in ONE transaction â€” one upload =
// one facility, all-or-nothing. The legacy form is byte-for-byte unchanged.
// Auth: account writers (admin/manager) on their own account, OR an oem_admin
// committing into one of its fleet customer accounts (#14, via targetAccountId).
router.post('/commit', async (req: any, res: any) => {
  try {
    const isWriter = ['admin', 'manager'].includes(req.user.role);
    const isOem = req.user.role === 'oem_admin';
    const hasTarget = !!(req.body && req.body.targetAccountId);
    if (!isWriter && !(isOem && hasTarget)) {
      return res.status(403).json({ success: false, error: 'Not permitted to commit this report' });
    }
    let accountId: string;
    try { accountId = await resolveIngestAccount(req); }
    catch (e: any) { return res.status(e.httpStatus || 400).json({ success: false, error: e.message }); }
    const { assetId, testDate, vendor, techName, measurements, sections, extractionId, corrections, reviewMs } = req.body;
    const isAcceptanceTest = !!req.body.isAcceptanceTest; // #27 year-0 baseline (whole report)
    const when = testDate ? new Date(testDate) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid testDate' });

    // â”€â”€ Multi-section path (#1): one upload â†’ many assets, atomically â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (Array.isArray(sections)) {
      if (sections.length === 0) return res.status(400).json({ success: false, error: 'sections required' });
      // Validate everything up front so we never half-commit.
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        if (!s || !Array.isArray(s.measurements) || s.measurements.length === 0)
          return res.status(400).json({ success: false, error: `section ${i}: measurements required` });
        if (!s.assetId && !s.createAsset)
          return res.status(400).json({ success: false, error: `section ${i}: assetId or createAsset required` });
        if (s.createAsset && (!s.createAsset.siteId || !s.createAsset.equipmentType))
          return res.status(400).json({ success: false, error: `section ${i}: createAsset needs siteId and equipmentType` });
      }

      const results = await prisma.$transaction(async (tx: any) => {
        const out: any[] = [];
        for (const s of sections) {
          let targetId = s.assetId;
          let created = false;
          if (targetId) {
            const a = await tx.asset.findFirst({ where: { id: targetId, accountId, archivedAt: null }, select: { id: true } });
            if (!a) throw new HttpableError(404, `Asset not found: ${targetId}`);
          } else {
            const c = s.createAsset;
            const site = await tx.site.findFirst({ where: { id: c.siteId, accountId, archivedAt: null }, select: { id: true } });
            if (!site) throw new HttpableError(400, `Site not found: ${c.siteId}`);
            const na = await tx.asset.create({
              data: {
                accountId, siteId: c.siteId, equipmentType: c.equipmentType,
                manufacturer: c.manufacturer || null, model: c.model || null, serialNumber: c.serialNumber || null,
              },
              select: { id: true },
            });
            targetId = na.id; created = true;
          }
          const r = await commitAssetReadings(tx, { accountId, assetId: targetId, when, vendor, techName, measurements: s.measurements, isAcceptanceTest });
          out.push({ ...r, created, label: s.label || null });
        }
        return out;
      });

      const totals = results.reduce((acc: any, r: any) => {
        acc.measurementsCreated += r.measurementsCreated;
        acc.deficienciesCreated += r.deficienciesCreated;
        acc.assetsCreated += r.created ? 1 : 0;
        return acc;
      }, { measurementsCreated: 0, deficienciesCreated: 0, assetsCreated: 0, assetsCommitted: results.length });

      await recordCommit({
        extractionId, fieldsCommitted: totals.measurementsCreated,
        corrections: Array.isArray(corrections) ? corrections : undefined,
        reviewMs: Number.isFinite(Number(reviewMs)) ? Number(reviewMs) : null,
      });
      // Tier-1 loop notify: a report landed -> tell the account team (fix list).
      try {
        const immediate = results.reduce((n: number, r: any) => n + (r.deficiencyBySeverity?.IMMEDIATE || 0), 0);
        const { notifyReportIngested } = require('../lib/loopNotify');
        notifyReportIngested(accountId, {
          readings: totals.measurementsCreated, deficiencies: totals.deficienciesCreated,
          immediate, assetLabel: `${totals.assetsCommitted} assets`, assetId: null,
        }).catch(() => {});
      } catch { /* never block the commit response */ }
      return res.status(201).json({ success: true, data: { sections: results, totals } });
    }

    // â”€â”€ Legacy single-asset path (unchanged contract) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!assetId) return res.status(400).json({ success: false, error: 'assetId required' });
    if (!Array.isArray(measurements) || measurements.length === 0) {
      return res.status(400).json({ success: false, error: 'measurements required' });
    }
    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId, archivedAt: null }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const r = await commitAssetReadings(prisma, { accountId, assetId, when, vendor, techName, measurements, isAcceptanceTest });

    // #4 correction capture: stamp the extraction row from preview with the
    // commit outcome + the human's field-level edits. Older clients that don't
    // send `corrections` still record the committed count + close the row for
    // the #5 dedupe check. Fire-and-forget.
    await recordCommit({
      extractionId, fieldsCommitted: r.measurementsCreated,
      corrections: Array.isArray(corrections) ? corrections : undefined,
      reviewMs: Number.isFinite(Number(reviewMs)) ? Number(reviewMs) : null,
    });

    // Tier-1 loop notify: a report landed -> tell the account team (fix list).
    try {
      const { notifyReportIngested } = require('../lib/loopNotify');
      notifyReportIngested(accountId, {
        readings: r.measurementsCreated, deficiencies: r.deficienciesCreated,
        immediate: r.deficiencyBySeverity?.IMMEDIATE || 0, assetLabel: null, assetId,
      }).catch(() => {});
    } catch { /* never block the commit response */ }

    return res.status(201).json({ success: true, data: r });
  } catch (err: any) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ success: false, error: err.message });
    console.error('[testReport/commit]', err);
    return res.status(500).json({ success: false, error: 'Failed to commit test report' });
  }
});

module.exports = router;
export {};
