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

const MAX_BYTES = 10 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req: any, file: any, cb: any) =>
    /\.pdf$/i.test(file.originalname || '') ? cb(null, true) : cb(new Error('Only .pdf files are accepted')),
});

function assetLabel(a: any): string {
  return [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset';
}

// ── POST /preview ─────────────────────────────────────────────────────────────
// V7: any authenticated role can preview (read-only); commit stays manager+.
router.post('/preview', upload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No PDF uploaded' });

    // V4: deterministic pdfplumber engine first (geometry + ruled tables); fall
    // OPEN to the pdfjs text-regex parser if Python is unavailable or yields
    // nothing, so ingest works even without the Python runtime.
    let meta: any, measurements: any[], source: string;
    const py = await runDeterministic(req.file.buffer);
    if (py && py.ok && Array.isArray(py.measurements) && py.measurements.length > 0) {
      source = 'pdfplumber';
      const f = py.fields || {};
      meta = {
        serialNumber: f.serialNumber || null, model: f.model || null,
        manufacturer: f.manufacturer || null, testDate: f.testDate || null,
        vendor: f.vendor || null, techName: f.techName || null,
      };
      measurements = py.measurements.map((x: any) => {
        let pf = ['GREEN', 'YELLOW', 'RED'].includes(x.passFail) ? x.passFail : null;
        if (!pf && x.expectedRange != null && x.asFoundValue != null) pf = evaluate(Number(x.asFoundValue), x.expectedRange);
        return {
          measurementType: x.measurementType, label: x.label || x.measurementType,
          phase: x.phase || null, asFoundValue: x.asFoundValue, asFoundUnit: x.asFoundUnit,
          expectedRange: x.expectedRange, testVoltage: x.testVoltage || null,
          passFail: pf, critical: !!x.critical, confidence: x.confidence,
        };
      });
    } else {
      source = 'pdfjs';
      const text = await extractPdfText(req.file.buffer);
      const parsed = parseTestReport(text);
      meta = parsed.meta;
      measurements = parsed.measurements;
    }

    // Best-effort asset match by serial number within the account.
    let assetMatch = null;
    if (meta.serialNumber) {
      const a = await prisma.asset.findFirst({
        where: { accountId: req.user.accountId, archivedAt: null,
                 serialNumber: { equals: meta.serialNumber, mode: 'insensitive' } },
        select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, site: { select: { name: true } } },
      });
      if (a) assetMatch = { id: a.id, label: assetLabel(a), serialNumber: a.serialNumber, equipmentType: a.equipmentType, siteName: a.site?.name || null };
    }

    const summary = {
      total: measurements.length,
      red:    measurements.filter((x: any) => x.passFail === 'RED').length,
      yellow: measurements.filter((x: any) => x.passFail === 'YELLOW').length,
      green:  measurements.filter((x: any) => x.passFail === 'GREEN').length,
      deficienciesToCreate: measurements.filter((x: any) => severityFor(x.passFail, x.critical)).length,
    };
    return res.json({ success: true, data: { meta, assetMatch, measurements, source, summary } });
  } catch (err) {
    console.error('[testReport/preview]', err);
    return res.status(500).json({ success: false, error: 'Failed to read the PDF. Is it a text-based test report (not a scan)?' });
  }
});

// ── POST /commit ──────────────────────────────────────────────────────────────
router.post('/commit', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const { assetId, testDate, vendor, techName, measurements } = req.body;
    if (!assetId) return res.status(400).json({ success: false, error: 'assetId required' });
    if (!Array.isArray(measurements) || measurements.length === 0) {
      return res.status(400).json({ success: false, error: 'measurements required' });
    }
    const asset = await prisma.asset.findFirst({ where: { id: assetId, accountId, archivedAt: null }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });
    const when = testDate ? new Date(testDate) : new Date();
    if (isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid testDate' });

    // WorkOrder is the parent of TestMeasurements (no standalone TestEvent model).
    const wo = await prisma.workOrder.create({
      data: { accountId, assetId, status: 'COMPLETE', scheduledDate: when, completedDate: when,
              notes: `Test report ingest${vendor ? ` — ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
      select: { id: true },
    });

    let measurementsCreated = 0;
    const defBySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
    for (const x of measurements) {
      const raw = x.asFoundValue;
      const val = (raw != null && raw !== '') ? Number(raw) : null;
      const passFail = ['GREEN', 'YELLOW', 'RED'].includes(x.passFail) ? x.passFail : null;
      await prisma.testMeasurement.create({
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

      const sev = severityFor(passFail, !!x.critical);
      if (sev) {
        await prisma.deficiency.create({
          data: {
            accountId, assetId, workOrderId: wo.id, severity: sev,
            description: `${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''}: ${x.asFoundValue ?? '?'}${x.asFoundUnit || ''}${x.expectedRange ? ` — expected ${x.expectedRange}` : ''}`,
            correctiveAction: 'Flagged from test report ingest — review reading and schedule corrective work.',
          },
        });
        defBySeverity[sev]++;
      }
    }

    const deficienciesCreated = defBySeverity.IMMEDIATE + defBySeverity.RECOMMENDED + defBySeverity.ADVISORY;
    return res.status(201).json({
      success: true,
      data: { workOrderId: wo.id, assetId, measurementsCreated, deficienciesCreated, deficiencyBySeverity: defBySeverity },
    });
  } catch (err) {
    console.error('[testReport/commit]', err);
    return res.status(500).json({ success: false, error: 'Failed to commit test report' });
  }
});

module.exports = router;
export {};
