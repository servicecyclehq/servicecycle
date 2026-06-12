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

function assetLabel(a: any): string {
  return [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset';
}

function shapeCandidate(c: any) {
  return {
    id: c.id, label: c.label, serialNumber: c.serialNumber, equipmentType: c.equipmentType,
    siteName: c.siteName, positionName: c.positionName, lastTestedAt: c.lastTestedAt,
    reason: c.reason, confidence: c.confidence,
  };
}

// #1 per-section asset matching. A SUBSTATION/POSITION block rarely carries its
// own serial, so it's matched by the position/substation tag against existing
// EquipmentPosition names and serials. The first section additionally tries the
// document-level serial via the #3 resolver (the report header usually names
// the lead device). Returns the same candidate shape as the whole-doc match.
async function resolveSectionAsset(accountId: string, def: any, docSerial: string | null) {
  if (docSerial) {
    const r = await resolveAsset({ accountId, serialNumber: docSerial });
    if (r.best) return { best: shapeCandidate(r.best), candidates: r.candidates.map(shapeCandidate) };
  }
  const terms = [def.position, def.substation].filter(Boolean);
  if (!terms.length) return { best: null, candidates: [] };
  const rows = await prisma.asset.findMany({
    where: {
      accountId, archivedAt: null,
      OR: [
        ...terms.map((t: string) => ({ position: { name: { equals: t, mode: 'insensitive' } } })),
        ...terms.map((t: string) => ({ serialNumber: { contains: t, mode: 'insensitive' } })),
      ],
    },
    select: {
      id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true,
      site: { select: { name: true } }, position: { select: { name: true } },
    },
    take: 5,
  });
  const candidates = rows.map((a: any) => shapeCandidate({
    id: a.id, label: assetLabel(a), serialNumber: a.serialNumber, equipmentType: a.equipmentType,
    siteName: a.site?.name || null, positionName: a.position?.name || null,
    lastTestedAt: null, reason: 'section_name', confidence: 'medium',
  }));
  return { best: candidates[0] || null, candidates };
}

// ── POST /preview ─────────────────────────────────────────────────────────────
// V7: any authenticated role can preview (read-only); commit stays manager+.
router.post('/preview', upload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // #20 photo-of-paper: if the upload is an image, wrap it into a single-page
    // PDF so the rest of the pipeline (OCR + parse + sections) reads it unchanged.
    let photoOfPaper = false;
    if (IMAGE_RE.test(req.file.originalname || '')) {
      try {
        const { imageToPdf } = require('../lib/imageToPdf');
        req.file.buffer = await imageToPdf(req.file.buffer, req.file.mimetype || 'image/jpeg');
        req.file.mimetype = 'application/pdf';
        photoOfPaper = true;
      } catch (e: any) {
        return res.status(400).json({ success: false, error: 'Could not process that photo. Try a clearer, well-lit image.' });
      }
    }

    // #14: oem_admin may preview against a fleet customer account (targetAccountId).
    let accountId: string;
    try { accountId = await resolveIngestAccount(req); }
    catch (e: any) { return res.status(e.httpStatus || 400).json({ success: false, error: e.message }); }

    // #5 fingerprint: hash the raw bytes once, then ask whether this exact
    // report has already been committed in this account. Surfaced to the client
    // as `priorImport` so the UI can warn "imported <date> — re-import anyway?"
    // instead of silently double-importing a year's readings. Advisory only —
    // never blocks the preview.
    const sha256 = sha256Hex(req.file.buffer);
    const priorImport = await findPriorImport({ accountId, sha256 });

    // V4: deterministic pdfplumber engine first (geometry + ruled tables); fall
    // OPEN to the pdfjs text-regex parser if Python is unavailable or yields
    // nothing, so ingest works even without the Python runtime.
    let meta: any, measurements: any[], source: string;
    let assetSections = 1, ocr = false;
    let pageCount: number | null = null, pagesScanned: number | null = null, truncated = false;
    let sectionDefs: any[] = []; // #1 canonical SUBSTATION/POSITION sections from the extractor
    const py = await runDeterministic(req.file.buffer);
    if (py && py.ok && Array.isArray(py.measurements) && py.measurements.length > 0) {
      source = py.ocr ? 'pdfplumber-ocr' : 'pdfplumber';
      assetSections = py.asset_sections || 1;
      sectionDefs = Array.isArray(py.sections) ? py.sections : [];
      pageCount = py.page_count ?? null;
      pagesScanned = py.pages_scanned ?? null;
      truncated = !!py.truncated;
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
          section: (x.section === null || x.section === undefined) ? null : Number(x.section), // #1 SUBSTATION/POSITION index
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

    // #3 identity resolution: fuzzy-match the parsed serial to an existing
    // asset (exact → O/0,I/1 normalized → site/type fallback) instead of the
    // old exact-only equals, so a year of readings can't silently attach to the
    // wrong device — and the UI can offer a one-tap "same device?" confirm.
    // `assetMatch` stays the single best candidate (backward-compatible shape);
    // `assetCandidates` is the new ranked list the confirm step renders.
    let assetMatch: any = null;
    let assetCandidates: any[] = [];
    if (meta.serialNumber || meta.manufacturer || meta.model) {
      const { best, candidates } = await resolveAsset({
        accountId,
        serialNumber: meta.serialNumber,
        manufacturer: meta.manufacturer,
        model: meta.model,
      });
      assetCandidates = candidates.map((c: any) => ({
        id: c.id, label: c.label, serialNumber: c.serialNumber, equipmentType: c.equipmentType,
        siteName: c.siteName, positionName: c.positionName, lastTestedAt: c.lastTestedAt,
        reason: c.reason, confidence: c.confidence,
      }));
      if (best) {
        assetMatch = {
          id: best.id, label: best.label, serialNumber: best.serialNumber,
          equipmentType: best.equipmentType, siteName: best.siteName,
          reason: best.reason, confidence: best.confidence, lastTestedAt: best.lastTestedAt,
        };
      }
    }

    const sliceSummary = (list: any[]) => ({
      total: list.length,
      red:    list.filter((x: any) => x.passFail === 'RED').length,
      yellow: list.filter((x: any) => x.passFail === 'YELLOW').length,
      green:  list.filter((x: any) => x.passFail === 'GREEN').length,
      deficienciesToCreate: list.filter((x: any) => severityFor(x.passFail, x.critical)).length,
    });
    const summary = sliceSummary(measurements);

    // #1 one-upload = one-facility: when the report spans >1 SUBSTATION/POSITION
    // section, group readings per section and resolve each to an existing asset
    // so the split UI can match-or-create per device. `measurements` (flat) and
    // the whole-doc `assetMatch` are untouched — the single-asset path and any
    // client that ignores `sections` keep working exactly as before.
    let sections: any[] = [];
    if (sectionDefs.length > 1) {
      const buckets = new Map<number, number[]>();
      measurements.forEach((m: any, i: number) => {
        const sidx = (m.section === null || m.section === undefined) ? 0 : m.section;
        if (!buckets.has(sidx)) buckets.set(sidx, []);
        buckets.get(sidx)!.push(i);
      });
      sections = await Promise.all(sectionDefs.map(async (def: any, idx: number) => {
        const measurementIndices = buckets.get(idx) || [];
        const secMeas = measurementIndices.map((i) => measurements[i]);
        const { best, candidates } = await resolveSectionAsset(
          accountId, def, idx === 0 ? meta.serialNumber : null,
        );
        return {
          idx, substation: def.substation, position: def.position, label: def.label,
          measurementIndices, summary: sliceSummary(secMeas),
          assetMatch: best, assetCandidates: candidates,
        };
      }));
    }

    // #4 telemetry: log engine / coverage / confidence for this extraction. The
    // returned id is echoed back on commit so the human corrections can be
    // stitched to this exact extraction. Fail-open — a null id just means the
    // correction signal won't be captured for this one.
    const stats = confStats(measurements);
    const extractionId = await recordExtraction({
      accountId, userId: req.user.id,
      kind: 'test_report', engine: source, ocr, aiUsed,
      pageCount, pagesScanned, truncated, assetSections,
      fieldsExtracted: measurements.length,
      confMin: stats.confMin, confMean: stats.confMean,
      redCount: stats.redCount, yellowCount: stats.yellowCount, greenCount: stats.greenCount,
      sha256,
    });

    return res.json({ success: true, data: {
      meta, assetMatch, assetCandidates, measurements, source, summary, assetSections, sections, ocr, aiUsed, aiAdded,
      pageCount, pagesScanned, truncated, extractionId, photoOfPaper,
      priorImport: priorImport ? { importedAt: priorImport.committedAt, readings: priorImport.fieldsCommitted } : null,
    } });
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

  // WorkOrder is the parent of TestMeasurements (no standalone TestEvent model).
  const wo = await db.workOrder.create({
    data: { accountId, assetId, status: 'COMPLETE', scheduledDate: when, completedDate: when,
            isAcceptanceTest,
            notes: `[ingest:test_report]${isAcceptanceTest ? '[acceptance]' : ''} Test report ingest${vendor ? ` — ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
    select: { id: true },
  });

  // Most recent PRIOR reading per (measurementType, phase) for the trend flag.
  const priorRows = await db.testMeasurement.findMany({
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
  return { workOrderId: wo.id, assetId, measurementsCreated, deficienciesCreated, trendDeficiencies, deficiencyBySeverity: defBySeverity };
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

    return res.status(201).json({ success: true, data: r });
  } catch (err: any) {
    if (err && err.httpStatus) return res.status(err.httpStatus).json({ success: false, error: err.message });
    console.error('[testReport/commit]', err);
    return res.status(500).json({ success: false, error: 'Failed to commit test report' });
  }
});

module.exports = router;
export {};
