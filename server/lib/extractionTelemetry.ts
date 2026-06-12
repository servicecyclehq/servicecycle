/**
 * Extraction telemetry + report fingerprinting (gems #4 + #5).
 *
 * Fire-and-forget, exactly like lib/activityLog: a telemetry failure must NEVER
 * break the ingest/scan request that triggered it. Every function swallows its
 * own errors. Writes one `extraction_events` row per extraction across every
 * ingest + scan path (test-report preview, nameplate OCR, photo inspect), then
 * a follow-up update at commit time carries the human corrections — the
 * proprietary labeled-correction dataset (#4). The sha256 column powers
 * re-import dedupe (#5).
 *
 * None of this is on the latency-critical path: recordExtraction returns the new
 * row id so the caller can thread it to commit, but callers treat a null id as
 * "telemetry unavailable" and proceed normally.
 */

import prisma from './prisma';

const crypto = require('crypto');

/** SHA-256 hex of the raw uploaded bytes — the report fingerprint (#5). */
function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Confidence distribution over a measurement array (each item may carry a
 * numeric `confidence` in 0..1 and a `passFail` of GREEN/YELLOW/RED). Returns
 * the stats the telemetry row stores; missing confidences are simply skipped.
 */
function confStats(measurements: any[]): {
  confMin: number | null; confMean: number | null;
  redCount: number; yellowCount: number; greenCount: number;
} {
  const confs = (measurements || [])
    .map((m) => (typeof m?.confidence === 'number' ? m.confidence : null))
    .filter((c): c is number => c != null && !isNaN(c));
  const confMin = confs.length ? Math.min(...confs) : null;
  const confMean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  let redCount = 0, yellowCount = 0, greenCount = 0;
  for (const m of measurements || []) {
    if (m?.passFail === 'RED') redCount++;
    else if (m?.passFail === 'YELLOW') yellowCount++;
    else if (m?.passFail === 'GREEN') greenCount++;
  }
  return { confMin, confMean, redCount, yellowCount, greenCount };
}

/**
 * Write the extraction-time telemetry row. Returns the new row id (string) or
 * null if the write failed — callers must tolerate null.
 */
async function recordExtraction(p: {
  accountId: string;
  userId?: string | null;
  kind: 'test_report' | 'nameplate' | 'photo_inspect';
  engine: string;
  ocr?: boolean;
  aiUsed?: boolean;
  pageCount?: number | null;
  pagesScanned?: number | null;
  truncated?: boolean;
  assetSections?: number | null;
  fieldsExtracted?: number;
  confMin?: number | null;
  confMean?: number | null;
  redCount?: number | null;
  yellowCount?: number | null;
  greenCount?: number | null;
  sha256?: string | null;
}): Promise<string | null> {
  try {
    const row = await prisma.extractionEvent.create({
      data: {
        accountId: p.accountId,
        userId: p.userId ?? null,
        kind: p.kind,
        engine: p.engine,
        ocr: !!p.ocr,
        aiUsed: !!p.aiUsed,
        pageCount: p.pageCount ?? null,
        pagesScanned: p.pagesScanned ?? null,
        truncated: !!p.truncated,
        assetSections: p.assetSections ?? null,
        fieldsExtracted: p.fieldsExtracted ?? 0,
        confMin: p.confMin ?? null,
        confMean: p.confMean ?? null,
        redCount: p.redCount ?? null,
        yellowCount: p.yellowCount ?? null,
        greenCount: p.greenCount ?? null,
        sha256: p.sha256 ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err: any) {
    console.error('[extractionTelemetry] recordExtraction failed:', err?.message || err);
    return null;
  }
}

/**
 * Dedupe lookup (#5): the most recent COMMITTED extraction of the same bytes in
 * the same account. Returns a thin descriptor for the "re-import anyway?" prompt
 * or null when this fingerprint has never been committed here before.
 */
async function findPriorImport(p: { accountId: string; sha256: string }): Promise<
  { id: string; committedAt: Date | null; kind: string; fieldsCommitted: number | null } | null
> {
  if (!p.sha256) return null;
  try {
    const prior = await prisma.extractionEvent.findFirst({
      where: { accountId: p.accountId, sha256: p.sha256, committedAt: { not: null } },
      orderBy: { committedAt: 'desc' },
      select: { id: true, committedAt: true, kind: true, fieldsCommitted: true },
    });
    return prior || null;
  } catch (err: any) {
    console.error('[extractionTelemetry] findPriorImport failed:', err?.message || err);
    return null;
  }
}

/**
 * Stamp the extraction row at commit time with the correction signal (#4): how
 * many fields were committed, how many the human changed, and the field-level
 * before/after diff. No-op when extractionId is falsy (telemetry was
 * unavailable at preview, or an older client didn't echo the id).
 */
async function recordCommit(p: {
  extractionId?: string | null;
  fieldsCommitted?: number | null;
  corrections?: Array<{ field: string; before: any; after: any; formFamily?: string | null }>;
  reviewMs?: number | null;
}): Promise<void> {
  if (!p.extractionId) return;
  try {
    const corrections = Array.isArray(p.corrections) ? p.corrections : undefined;
    await prisma.extractionEvent.update({
      where: { id: p.extractionId },
      data: {
        committedAt: new Date(),
        fieldsCommitted: p.fieldsCommitted ?? null,
        fieldsCorrected: corrections ? corrections.length : null,
        corrections: corrections ?? undefined,
        reviewMs: p.reviewMs ?? null,
      },
    });
  } catch (err: any) {
    // A missing/foreign extractionId (e.g. a spoofed client value) just no-ops.
    console.error('[extractionTelemetry] recordCommit failed:', err?.message || err);
  }
}

module.exports = { sha256Hex, confStats, recordExtraction, findPriorImport, recordCommit };

export {};
