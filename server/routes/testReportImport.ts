/**
 * /api/test-reports/import — staged PDF test-report ingest (gem R1, the moat).
 *
 *   POST /preview — multipart PDF upload → extract + parse → measurement
 *                   preview + asset match guess. No DB writes; human verifies.
 *   POST /commit  — { assetId, testDate, vendor?, techName?, measurements[] }
 *                   → WorkOrder (COMPLETE, the TestMeasurement parent) +
 *                   TestMeasurement rows + auto-generated Deficiency rows from
 *                   failed/at-risk readings. Returns the N4 action summary.
 *
 * Mounted at /api/test-reports/import (authenticateToken + ingestLimiter in
 * index.ts). Manager+ for both — ingestion writes program-of-record data.
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

// ── POST /preview ─────────────────────────────────────────────────────────────
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

// W4 trend flags: which direction is "worse" per measurement type, and the
// year-over-year percentage that turns an in-spec reading into an ADVISORY.
const BAD_DIRECTION: any = {
  insulation_resistance: 'down', polarization_index: 'down', dielectric_absorption_ratio: 'down',
  contact_resistance: 'up', winding_resistance: 'up', power_factor: 'up', dissipation_factor: 'up',
  dissolved_gas: 'up', excitation_current: 'up', ground_resistance: 'up',
};
const TREND_PCT = 15;

// Thrown inside the multi-section $transaction to abort the whole commit with a
// specific HTTP status (e.g. a bad section asset id) — never a half-written
// facility. The handler's catch maps `httpStatus` to the response.
class HttpableError extends Error {
  httpStatus: number;
  constructor(status: number, message: string) { super(message); this.httpStatus = status; }
}

// #14 contractor bulk ingest: oem_admin may ingest into a fleet customer
// account via targetAccountId (validated in lib/oemTargetAccount).
const { resolveTargetAccount } = require('../lib/oemTargetAccount');
const resolveIngestAccount = resolveTargetAccount;

// Write ONE asset's readings: a COMPLETE WorkOrder parent + TestMeasurement
// rows + auto Deficiency rows (hard pass/fail and the year-over-year trend
// flag). `db` is a prisma client OR a $transaction client, so the multi-section
// path can write every asset atomically. Returns the per-asset summary.
async function commitAssetReadings(db: any, p: {
  accountId: string; assetId: string; when: Date;
  vendor?: string; techName?: string; measurements: any[];
  isAcceptanceTest?: boolean;
}) {
  const { accountId, assetId, when, vendor, techName, measurements } = p;
  const isAcceptanceTest = !!p.isAcceptanceTest;
  const { checkMeasurementSanity } = require('../lib/measurementSanity');

  // Compliance-by-import guard: a report must carry at least one USABLE reading
  // (a numeric value OR an explicit pass/fail) before it can complete a work
  // order and roll schedules to compliant. A date with only empty/label rows
  // must not count as maintenance performed. (Empty measurement arrays are
  // already rejected by the route; this catches non-empty-but-valueless rows.)
  const hasUsableReading = measurements.some((x: any) => {
    const v = (x.asFoundValue != null && x.asFoundValue !== '') ? Number(x.asFoundValue) : null;
    return (v != null && !isNaN(v)) || ['GREEN', 'YELLOW', 'RED'].includes(x.passFail);
  });
  if (!hasUsableReading) {
    throw new HttpableError(400, 'Report has no usable readings (a value or pass/fail) — refusing to mark maintenance complete.');
  }

  // WorkOrder is the parent of TestMeasurements (no standalone TestEvent model).
  const wo = await db.workOrder.create({
    data: { accountId, assetId, status: 'COMPLETE', scheduledDate: when, completedDate: when,
            isAcceptanceTest,
            notes: `[ingest:test_report]${isAcceptanceTest ? '[acceptance]' : ''} Test report ingest${vendor ? ` — ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
    select: { id: true },
  });

  // Most recent PRIOR reading per (measurementType, phase) for the trend flag.
  const priorRows = await db.testMeasurement.findMany({
    where: { accountId, deletedAt: null, asFoundValue: { not: null }, workOrder: { assetId } },
    select: { measurementType: true, phase: true, asFoundValue: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const priorByKey = new Map<string, number>();
  for (const r of priorRows as any[]) {
    const k = `${r.measurementType}|${r.phase || ''}`;
    if (!priorByKey.has(k)) priorByKey.set(k, Number(r.asFoundValue));
  }

  let measurementsCreated = 0;
  let trendDeficiencies = 0;
  let sanityFlags = 0;
  const defBySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  for (const x of measurements) {
    const raw = x.asFoundValue;
    const val = (raw != null && raw !== '') ? Number(raw) : null;
    const passFail = ['GREEN', 'YELLOW', 'RED'].includes(x.passFail) ? x.passFail : null;
    await db.testMeasurement.create({
      data: {
        accountId, workOrderId: wo.id,
        measurementType: String(x.measurementType || 'measurement'),
        phase: x.phase || null,
        asFoundValue: (val != null && !isNaN(val)) ? val : null,
        asFoundUnit: x.asFoundUnit || null,
        passFail,
        expectedRange: x.expectedRange || null,
        testVoltage: x.testVoltage || null,
        notes: x.notes || null,
      },
    });
    measurementsCreated++;

    // Unit/scale sanity flag (non-blocking) — catch order-of-magnitude errors
    // such as a contact resistance entered in mOhm that should be uOhm. Surfaced
    // as an ADVISORY "data check" so a human verifies before the value is trusted
    // in the trend; never blocks the commit.
    if (val != null && !isNaN(val)) {
      const sanity = checkMeasurementSanity(x.measurementType, val);
      if (sanity) {
        await db.deficiency.create({
          data: {
            accountId, assetId, workOrderId: wo.id, severity: 'ADVISORY',
            description: `[data check] ${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''}: ${sanity}`,
            correctiveAction: 'Verify the reading and its unit against the source report before trusting the trend.',
          },
        });
        defBySeverity.ADVISORY++;
        sanityFlags++;
      }
    }

    const sev = severityFor(passFail, !!x.critical);
    if (sev) {
      await db.deficiency.create({
        data: {
          accountId, assetId, workOrderId: wo.id, severity: sev,
          description: `${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''}: ${x.asFoundValue ?? '?'}${x.asFoundUnit || ''}${x.expectedRange ? ` — expected ${x.expectedRange}` : ''}`,
          correctiveAction: 'Flagged from test report ingest — review reading and schedule corrective work.',
        },
      });
      defBySeverity[sev]++;
    } else if (val != null && !isAcceptanceTest) {
      // No hard pass/fail issue — check the year-over-year trend (W4).
      // Skipped for an acceptance test: a year-0 baseline IS the anchor, so it
      // has nothing legitimate to trend against (and if backfilled after later
      // tests it must not be compared to newer readings).
      const dir = BAD_DIRECTION[String(x.measurementType)];
      const prior = priorByKey.get(`${x.measurementType}|${x.phase || ''}`);
      if (dir && prior != null && prior !== 0) {
        const pct = ((val - prior) / Math.abs(prior)) * 100;
        const worse = (dir === 'up' && pct >= TREND_PCT) || (dir === 'down' && pct <= -TREND_PCT);
        if (worse) {
          await db.deficiency.create({
            data: {
              accountId, assetId, workOrderId: wo.id, severity: 'ADVISORY',
              description: `${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''} trending ${dir === 'up' ? 'up' : 'down'} ${Math.abs(Math.round(pct))}% since last test (${prior}→${val}${x.asFoundUnit || ''}) — still in spec, monitor`,
              correctiveAction: 'Trend flag from test-report ingest — watch for continued degradation before next cycle.',
            },
          });
          defBySeverity.ADVISORY++;
          trendDeficiencies++;
        }
      }
    }
  }

  const deficienciesCreated = defBySeverity.IMMEDIATE + defBySeverity.RECOMMENDED + defBySeverity.ADVISORY;
  return { workOrderId: wo.id, assetId, measurementsCreated, deficienciesCreated, trendDeficiencies, sanityFlags, deficiencyBySeverity: defBySeverity };
}

// ── POST /commit ──────────────────────────────────────────────────────────────
// Two shapes:
//   legacy single-asset  { assetId, measurements[], testDate?, vendor?, techName? }
//   #1 multi-section      { sections: [{ assetId? | createAsset:{siteId,equipmentType,
//                          manufacturer?,model?,serialNumber?}, measurements[] }], ... }
// The multi-section form writes every asset in ONE transaction — one upload =
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

    // ── Multi-section path (#1): one upload → many assets, atomically ──────────
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

    // ── Legacy single-asset path (unchanged contract) ─────────────────────────
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
