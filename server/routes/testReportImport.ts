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
    let assetSections = 1, ocr = false;
    const py = await runDeterministic(req.file.buffer);
    if (py && py.ok && Array.isArray(py.measurements) && py.measurements.length > 0) {
      source = py.ocr ? 'pdfplumber-ocr' : 'pdfplumber';
      assetSections = py.asset_sections || 1;
      ocr = !!py.ocr;
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
          passFail: pf, critical: !!x.critical, kind: x.kind || 'D', confidence: x.confidence,
        };
      });
    } else {
      source = 'pdfjs';
      const text = await extractPdfText(req.file.buffer);
      const parsed = parseTestReport(text);
      meta = parsed.meta;
      measurements = parsed.measurements;
    }

    // ── W1-AI: deterministic-first AI gap-fill ────────────────────────────────
    // Fires ONLY when the deterministic + OCR pass came back thin (few total
    // readings, or a full fall-through to the pdfjs text parser). Recovers the
    // readings the regex/geometry passes missed via the configured LLM (Gemini
    // free-tier cascade by default). Fail-open: any error leaves the
    // deterministic result untouched. Net-new rows only — an AI row never
    // overwrites or duplicates a deterministic reading.
    let aiUsed = false;
    let aiAdded = 0;
    const MIN_READINGS = Number(process.env.AI_INGEST_MIN_READINGS || 8);
    const lowCoverage = source === 'pdfjs' || measurements.length < MIN_READINGS;
    if (process.env.AI_ENABLED !== 'false' && lowCoverage) {
      try {
        const aiText = await extractPdfText(req.file.buffer); // text-layer; scans (OCR) yield none → skipped
        if (aiText && aiText.trim().length > 60) {
          const filled = await aiFillReadings(aiText);
          if (filled.ok && filled.measurements.length) {
            const seen = new Set(
              measurements.map((m: any) => `${m.measurementType}|${m.phase || ''}|${m.asFoundValue}`),
            );
            for (const m of filled.measurements) {
              const key = `${m.measurementType}|${m.phase || ''}|${m.asFoundValue}`;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!m.passFail && m.expectedRange != null && m.asFoundValue != null) {
                m.passFail = evaluate(Number(m.asFoundValue), m.expectedRange);
              }
              measurements.push(m);
              aiAdded++;
            }
            aiUsed = aiAdded > 0;
            if (aiUsed && source !== 'pdfjs') source = `${source}+ai`;
            else if (aiUsed) source = 'ai';
          }
        }
      } catch (e: any) {
        console.warn('[testReport/preview] AI gap-fill skipped:', e && e.message ? e.message : String(e));
      }
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
    return res.json({ success: true, data: { meta, assetMatch, measurements, source, summary, assetSections, ocr, aiUsed, aiAdded } });
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
              notes: `[ingest:test_report] Test report ingest${vendor ? ` — ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
      select: { id: true },
    });

    // W4: trend-based deficiencies. Pull the most recent PRIOR reading per
    // (measurementType, phase) so a value that's still in spec but moving the
    // wrong way year-over-year ("C-phase IR down 40% — won't pass next year")
    // becomes an ADVISORY now, not a surprise next cycle. bad='up' → higher is
    // worse; bad='down' → lower is worse.
    const BAD_DIRECTION: any = {
      insulation_resistance: 'down', polarization_index: 'down', dielectric_absorption_ratio: 'down',
      contact_resistance: 'up', winding_resistance: 'up', power_factor: 'up', dissipation_factor: 'up',
      dissolved_gas: 'up', excitation_current: 'up', ground_resistance: 'up',
    };
    const TREND_PCT = 15;
    const priorRows = await prisma.testMeasurement.findMany({
      where: { accountId, asFoundValue: { not: null }, workOrder: { assetId } },
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
      } else if (val != null) {
        // No hard pass/fail issue — check the year-over-year trend (W4).
        const dir = BAD_DIRECTION[String(x.measurementType)];
        const prior = priorByKey.get(`${x.measurementType}|${x.phase || ''}`);
        if (dir && prior != null && prior !== 0) {
          const pct = ((val - prior) / Math.abs(prior)) * 100;
          const worse = (dir === 'up' && pct >= TREND_PCT) || (dir === 'down' && pct <= -TREND_PCT);
          if (worse) {
            await prisma.deficiency.create({
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
    return res.status(201).json({
      success: true,
      data: { workOrderId: wo.id, assetId, measurementsCreated, deficienciesCreated, trendDeficiencies, deficiencyBySeverity: defBySeverity },
    });
  } catch (err) {
    console.error('[testReport/commit]', err);
    return res.status(500).json({ success: false, error: 'Failed to commit test report' });
  }
});

module.exports = router;
export {};
