/**
 * testReportPreview.ts — shared "buffer -> preview" builder (#2).
 *
 * Extracted verbatim from routes/testReportImport.ts POST /preview so BOTH the
 * synchronous route AND the async ingest worker (lib/ingestWorker) produce the
 * EXACT same preview shape. The route still owns request concerns (multer,
 * account/target resolution, auth); this owns buffer -> { data } only.
 *
 * Pipeline: photo-of-paper wrap -> #5 fingerprint -> V4 pdfplumber deterministic
 * (fallback pdfjs) -> W1 AI gap-fill -> #3 identity resolution -> #1 section
 * split -> #4 telemetry. Fail-open throughout; throws only on an unreadable file.
 */

'use strict';

const prisma = require('./prisma').default;
const { extractPdfText, parseTestReport, severityFor, evaluate } = require('./testReportParse');
const { runDeterministic } = require('./testReportExtract');
const { aiFillReadings, aiFillReadingsFromImage } = require('./aiTestReportExtract');
const { sha256Hex, confStats, recordExtraction, findPriorImport } = require('./extractionTelemetry');
const { resolveAsset } = require('./assetIdentity');

const IMAGE_RE = /\.(jpe?g|png|heic|heif|webp)$/i;

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

/**
 * Merge AI/vision-recovered readings into the deterministic set (P0 fix,
 * 2026-07-03). Shared by BOTH the text gap-fill and the vision fallback so the
 * dedup logic can never drift between the two passes.
 *
 * The dedup key includes SOURCE, so provenance is preserved and same-source
 * repeats collapse. Across sources:
 *   - an exact (type|phase|value) match is AGREEMENT — keep the existing
 *     (deterministic-preferred) row, drop the duplicate, and mark the retained
 *     row so the reviewer can see two passes concurred;
 *   - the same (type|phase) with a DIFFERENT value is a cross-pass DISAGREEMENT
 *     — keep both rows but flag them so the confidence gate routes them to
 *     review. Two independent passes disagreeing on one measurement is the
 *     strongest single misread signal the pipeline has; it used to be discarded.
 *
 * Mutates `existing` in place; returns the number of net-new rows added.
 */
function mergeExtractedMeasurements(existing: any[], incoming: any[]): number {
  let added = 0;
  const keyOf = (m: any) => `${m.measurementType}|${m.phase || ''}|${m.asFoundValue}|${m.source || 'det'}`;
  const seen = new Set(existing.map(keyOf));
  for (const m of incoming) {
    if (!m) continue;
    // Exact value already present from ANY source → agreement; skip the dup.
    const exact = existing.find((e: any) =>
      e.measurementType === m.measurementType &&
      (e.phase || '') === (m.phase || '') &&
      String(e.asFoundValue) === String(m.asFoundValue));
    if (exact) {
      if ((exact.source || 'det') !== (m.source || 'ai')) exact.crossSourceAgreement = true;
      continue;
    }
    // Within-source exact repeat → skip.
    if (seen.has(keyOf(m))) continue;
    // Different value for a reading we already have (same type+phase) →
    // keep both, flag the disagreement.
    const conflicts = existing.filter((e: any) =>
      e.measurementType === m.measurementType &&
      (e.phase || '') === (m.phase || '') &&
      e.asFoundValue != null && m.asFoundValue != null &&
      String(e.asFoundValue) !== String(m.asFoundValue));
    if (conflicts.length) {
      m.crossPassDisagreement = true;
      for (const e of conflicts) e.crossPassDisagreement = true;
    }
    if (!m.passFail && m.expectedRange != null && m.asFoundValue != null) {
      m.passFail = evaluate(Number(m.asFoundValue), m.expectedRange);
    }
    existing.push(m);
    seen.add(keyOf(m));
    added++;
  }
  return added;
}

interface BuildPreviewOpts {
  accountId: string;
  userId: string;
  originalName?: string;
  mimetype?: string;
}

/**
 * Build the test-report preview `data` object from raw upload bytes.
 * Mutates a local copy of the buffer for the photo-of-paper wrap; never touches
 * the caller's buffer reference semantics beyond reading it.
 */
async function buildTestReportPreview(inputBuffer: Buffer, opts: BuildPreviewOpts) {
  const { accountId, userId } = opts;
  let buffer = inputBuffer;

  // #20 photo-of-paper: wrap an image into a single-page PDF so the same OCR +
  // parse pipeline reads it unchanged.
  let photoOfPaper = false;
  if (IMAGE_RE.test(opts.originalName || '')) {
    const { imageToPdf } = require('./imageToPdf');
    buffer = await imageToPdf(buffer, opts.mimetype || 'image/jpeg');
    photoOfPaper = true;
  }

  // #5 fingerprint.
  const sha256 = sha256Hex(buffer);
  const priorImport = await findPriorImport({ accountId, sha256 });

  // V4 deterministic engine first; pdfjs text-regex fallback.
  let meta: any, measurements: any[], source: string;
  let assetSections = 1, ocr = false;
  let pageCount: number | null = null, pagesScanned: number | null = null, truncated = false;
  let textPages: number | null = null;
  let sectionDefs: any[] = [];
  const py = await runDeterministic(buffer);
  if (py && py.ok && Array.isArray(py.measurements) && py.measurements.length > 0) {
    source = py.ocr ? 'pdfplumber-ocr' : 'pdfplumber';
    assetSections = py.asset_sections || 1;
    sectionDefs = Array.isArray(py.sections) ? py.sections : [];
    pageCount = py.page_count ?? null;
    pagesScanned = py.pages_scanned ?? null;
    textPages = py.text_pages ?? null;
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
        section: (x.section === null || x.section === undefined) ? null : Number(x.section),
      };
    });
  } else {
    source = 'pdfjs';
    const text = await extractPdfText(buffer);
    const parsed = parseTestReport(text);
    meta = parsed.meta;
    measurements = parsed.measurements;
  }

  // W1-AI deterministic-first gap-fill.
  let aiUsed = false;
  let aiAdded = 0;
  const MIN_READINGS = Number(process.env.AI_INGEST_MIN_READINGS || 8);
  // Fill any header field the deterministic parser missed from AI/vision output.
  const mergeMeta = (f: any) => {
    if (!f) return;
    for (const k of ['serialNumber', 'manufacturer', 'model', 'testDate', 'vendor', 'techName']) {
      if (!meta[k] && f[k]) meta[k] = f[k];
    }
  };
  const lowCoverage = source === 'pdfjs' || measurements.length < MIN_READINGS;
  if (process.env.AI_ENABLED !== 'false' && lowCoverage) {
    try {
      const aiText = await extractPdfText(buffer);
      if (aiText && aiText.trim().length > 60) {
        const filled = await aiFillReadings(aiText);
        if (filled.ok) mergeMeta(filled.fields);
        if (filled.ok && filled.measurements.length) {
          aiAdded += mergeExtractedMeasurements(measurements, filled.measurements);
          aiUsed = aiAdded > 0;
          if (aiUsed && source !== 'pdfjs') source = `${source}+ai`;
          else if (aiUsed) source = 'ai';
        }
      }
    } catch (e: any) {
      console.warn('[testReportPreview] AI gap-fill skipped:', e && e.message ? e.message : String(e));
    }
  }

  // W1-AI vision fallback: if coverage is STILL low and we have the original
  // image (photo-of-paper upload), send the IMAGE to the multimodal model. The
  // text gap-fill above cannot help when OCR produced little/no usable text —
  // this reads the pixels directly (same Gemini/Groq cascade as nameplate scan).
  let visionUsed = false;
  let visionAdded = 0;
  if (process.env.AI_ENABLED !== 'false' && photoOfPaper && measurements.length < MIN_READINGS) {
    try {
      const vres = await aiFillReadingsFromImage(inputBuffer, { mediaType: opts.mimetype });
      if (vres.ok) mergeMeta(vres.fields);
      if (vres.ok && vres.measurements.length) {
        visionAdded += mergeExtractedMeasurements(measurements, vres.measurements);
        visionUsed = visionAdded > 0;
        if (visionUsed) source = source.includes('ai') ? `${source}+vision` : `${source}+vision`;
      }
    } catch (e: any) {
      console.warn('[testReportPreview] vision fallback skipped:', e && e.message ? e.message : String(e));
    }
  }

  // #3 identity resolution.
  let assetMatch: any = null;
  let assetCandidates: any[] = [];
  if (meta.serialNumber || meta.manufacturer || meta.model) {
    const { best, candidates } = await resolveAsset({
      accountId, serialNumber: meta.serialNumber, manufacturer: meta.manufacturer, model: meta.model,
    });
    assetCandidates = candidates.map(shapeCandidate);
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

  // #1 per-section split.
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
      const { best, candidates } = await resolveSectionAsset(accountId, def, idx === 0 ? meta.serialNumber : null);
      return {
        idx, substation: def.substation, position: def.position, label: def.label,
        measurementIndices, summary: sliceSummary(secMeas),
        assetMatch: best, assetCandidates: candidates,
      };
    }));
  }

  // #4 telemetry.
  const stats = confStats(measurements);
  const extractionId = await recordExtraction({
    accountId, userId,
    kind: 'test_report', engine: source, ocr, aiUsed,
    pageCount, pagesScanned, truncated, assetSections,
    fieldsExtracted: measurements.length,
    confMin: stats.confMin, confMean: stats.confMean,
    redCount: stats.redCount, yellowCount: stats.yellowCount, greenCount: stats.greenCount,
    sha256,
  });

  return {
    meta, assetMatch, assetCandidates, measurements, source, summary, assetSections, sections, ocr, aiUsed, aiAdded,
    visionUsed, visionAdded,
    pageCount, pagesScanned, textPages, truncated, extractionId, photoOfPaper,
    priorImport: priorImport ? { importedAt: priorImport.committedAt, readings: priorImport.fieldsCommitted } : null,
  };
}

module.exports = { buildTestReportPreview };

export {};
