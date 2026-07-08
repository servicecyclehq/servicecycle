/**
 * lib/ingestConfidenceGate.ts — auto-commit safety gate for hands-off ingest.
 *
 * Email-in and #34 backfill parse a report with no human in the loop. Rather
 * than auto-commit everything (junk in -> junk asset cards that pollute the
 * compliance picture and are a pain to unwind), the worker scores the parsed
 * preview here and only auto-commits the high-confidence ones; anything below
 * the bar is parked as `needs_review` for one-tap human approval.
 *
 * DESIGN (agreed with Dustin): IDENTITY is always strict; the READING floor is
 * the tunable knob.
 *   - Identity-critical risks always force review regardless of the threshold:
 *       * OCR / photo-of-paper (least reliable source)
 *       * AI filled an identity field (serial)
 *       * an existing-asset match that is only medium/low confidence (wrong asset)
 *       * creating a NEW asset when similar assets already exist (possible dup)
 *       * the equipment type was guessed (defaulted, not keyword-matched)
 *   - The per-account threshold (0..1, default 0.85) sets the per-reading
 *     confidence floor. Loosening it lets more borderline READING confidence
 *     auto-commit, but never relaxes the identity rules above.
 *
 * Deterministic parses (no per-reading confidence, no AI, no OCR) sail through
 * green — that is the frictionless common case the product depends on. A fresh
 * account with no assets yet has nothing to dedupe against, so first-load
 * backfills also flow without nags until real near-matches appear.
 */

'use strict';

const { inferEquipmentTypeResult } = require('./commitTestReport');

const DEFAULT_THRESHOLD = 0.85;
// [2026-07-08 acquisition audit W2-AI] the account-tunable floor was
// unbounded below DEFAULT_THRESHOLD -- an account could set it near 0 and
// effectively disable the reading-confidence gate for hands-off auto-commit
// jobs (identity rules in evaluateUnit still apply, but the whole point of
// the reading floor is defeated). 0.5 is a coin-flip: below that the
// reading's own confidence number is no longer meaningfully gating anything.
const MIN_THRESHOLD = 0.5;

function clampThreshold(t: any): number {
  const n = Number(t);
  if (!isFinite(n) || n <= 0) return DEFAULT_THRESHOLD;
  if (n > 1) return 1;
  if (n < MIN_THRESHOLD) return MIN_THRESHOLD;
  return n;
}

// Pull the readings that belong to one unit (section) so the per-reading floor
// is scoped to the asset being committed.
function unitMeasurements(preview: any, indices?: number[]): any[] {
  const all: any[] = Array.isArray(preview?.measurements) ? preview.measurements : [];
  if (Array.isArray(indices)) return indices.map((i) => all[i]).filter(Boolean);
  return all;
}

// Score one asset unit. Returns { action, band, reasons[] } where band is the
// WORST of identity + readings for that unit.
function evaluateUnit(
  preview: any,
  unit: { assetMatch?: any; assetCandidates?: any[]; createParts: any[]; measurements: any[]; label: string },
  threshold: number,
): { label: string; action: 'match' | 'create'; band: 'green' | 'yellow' | 'red'; reasons: string[] } {
  const reasons: string[] = [];
  let band: 'green' | 'yellow' | 'red' = 'green';
  const worse = (b: 'green' | 'yellow' | 'red') => {
    if (b === 'red') band = 'red';
    else if (b === 'yellow' && band !== 'red') band = 'yellow';
  };

  const matchId = unit.assetMatch?.id || null;
  const action: 'match' | 'create' = matchId ? 'match' : 'create';

  if (action === 'match') {
    const conf = String(unit.assetMatch?.confidence || '').toLowerCase();
    if (conf === 'low') { worse('red'); reasons.push(`Low-confidence match to "${unit.assetMatch?.label || matchId}" — confirm it's the same device.`); }
    else if (conf === 'medium') { worse('yellow'); reasons.push(`Medium-confidence match to "${unit.assetMatch?.label || matchId}" — confirm before committing.`); }
    // high → no identity concern
  } else {
    // Creating a new asset. Possible duplicate? (only meaningful once the
    // account has assets to match against).
    const cands = Array.isArray(unit.assetCandidates) ? unit.assetCandidates : [];
    if (cands.length > 0) {
      worse('yellow');
      reasons.push(`Looks like it may already exist (${cands.length} similar asset${cands.length === 1 ? '' : 's'}) — review to merge instead of creating a duplicate.`);
    }
    // Guessed type?
    const typeRes = inferEquipmentTypeResult(...unit.createParts);
    if (!typeRes.matched) {
      worse('yellow');
      reasons.push('Equipment type was guessed (no clear keyword) — confirm the type.');
    }
  }

  // Reading floor — only meaningful where the parser emitted per-reading
  // confidence. A failing (RED) reading under the floor is the riskiest (it
  // drives a deficiency), so it pushes to RED; ordinary low readings to YELLOW.
  let belowCount = 0;
  let min: number | null = null;
  let aiCriticalCount = 0;
  let unscoredCount = 0;
  for (const m of unit.measurements) {
    if (!m) continue;

    // HARD RULE (P0, 2026-07-03): an AI/vision-recovered reading that is
    // safety-CRITICAL (contact resistance, trip time, pickup, injection, ground-
    // fault) always forces review, regardless of the account threshold. A model
    // can confabulate a value for an empty cell, and a critical RED reading auto-
    // creates an IMMEDIATE deficiency — so a human must confirm it first. Mirrors
    // the strict-identity rules above.
    if (m.source === 'ai' && m.critical === true) {
      aiCriticalCount++;
      worse('red');
    }

    // A legitimately deterministic reading carries NO per-reading confidence
    // (undefined/null) and sails through — that is the frictionless common case
    // the product depends on.
    const raw = m.confidence;
    if (raw === null || raw === undefined) continue;

    const c = (typeof raw === 'number' && Number.isFinite(raw)) ? raw : null;
    if (c == null) {
      // Confidence is PRESENT but not a finite number (the old 'ai' string, or a
      // corrupt value). We cannot score it — fail LOUD to review rather than
      // silently skipping, which is exactly how AI readings used to bypass this
      // gate entirely.
      unscoredCount++;
      worse(m.passFail === 'RED' ? 'red' : 'yellow');
      continue;
    }

    min = min == null ? c : Math.min(min, c);
    if (c < threshold) {
      belowCount++;
      if (m.passFail === 'RED') worse('red');
      else worse('yellow');
    }
  }
  if (aiCriticalCount > 0) {
    reasons.push(`${aiCriticalCount} AI-recovered critical reading${aiCriticalCount === 1 ? '' : 's'} — a human must confirm before it can drive a deficiency.`);
  }
  if (unscoredCount > 0) {
    reasons.push(`${unscoredCount} reading${unscoredCount === 1 ? '' : 's'} with an unscoreable confidence value — verify against the source report.`);
  }
  if (belowCount > 0) {
    reasons.push(`${belowCount} reading${belowCount === 1 ? '' : 's'} below the confidence floor — verify the values.`);
  }

  return { label: unit.label, action, band, reasons };
}

/**
 * Evaluate a parsed preview and decide whether it can auto-commit.
 *
 * @returns gate object stored on the IngestJob:
 *   { autoCommit, band, threshold, reasons[], units[], source, ocr }
 */
function evaluateIngestGate(preview: any, opts: { threshold?: any; originalName?: string } = {}) {
  const threshold = clampThreshold(opts.threshold);
  const meta = preview?.meta || {};
  const reasons: string[] = [];
  let band: 'green' | 'yellow' | 'red' = 'green';
  const worse = (b: 'green' | 'yellow' | 'red') => {
    if (b === 'red') band = 'red';
    else if (b === 'yellow' && band !== 'red') band = 'yellow';
  };

  // Source-level identity risks apply to the whole document.
  if (preview?.ocr === true) {
    worse('red');
    reasons.push('Read from a photo/scan (OCR) — verify every field before it becomes a record.');
  }
  const aiAdded: string[] = Array.isArray(preview?.aiAdded) ? preview.aiAdded : [];
  if (aiAdded.includes('serialNumber')) {
    worse('red');
    reasons.push('Serial number was AI-inferred — confirm the asset identity.');
  }

  // Build the units the same way commitPreviewSections does.
  const isMultiSection = Array.isArray(preview?.sections) && preview.sections.length > 1;
  const units: Array<Parameters<typeof evaluateUnit>[1]> = [];
  if (isMultiSection) {
    preview.sections.forEach((sec: any, idx: number) => {
      const ms = unitMeasurements(preview, sec.measurementIndices);
      if (!ms.length) return;
      const label = sec.label || sec.position || sec.substation || `Section ${idx + 1}`;
      units.push({
        assetMatch: sec.assetMatch, assetCandidates: sec.assetCandidates,
        createParts: [sec.label, sec.position, sec.substation, idx === 0 ? meta.model : null, idx === 0 ? meta.manufacturer : null],
        measurements: ms, label,
      });
    });
  } else {
    const ms = unitMeasurements(preview);
    if (ms.length) {
      units.push({
        assetMatch: preview?.assetMatch, assetCandidates: preview?.assetCandidates,
        createParts: [meta.model, meta.manufacturer, opts.originalName],
        measurements: ms, label: meta.model || meta.serialNumber || opts.originalName || 'Imported asset',
      });
    }
  }

  const unitResults = units.map((u) => evaluateUnit(preview, u, threshold));
  for (const ur of unitResults) {
    worse(ur.band);
    for (const r of ur.reasons) reasons.push(`${ur.label}: ${r}`);
  }

  const hasUnits = unitResults.length > 0;

  // ── Silent-empty / low-coverage guard (2026-07-03) ──────────────────────────
  // There is no working raster-OCR path today, so a scanned or image-only report
  // extracts few or no readings. Never let that pass as a completed no-op: an
  // empty extraction routes to review, and a multi-page scan that yielded far
  // fewer readings than its length suggests is flagged (the body pages likely
  // didn't parse) rather than auto-committing a fraction of the report.
  const allMeasurements: any[] = Array.isArray(preview?.measurements) ? preview.measurements : [];
  const pageCount = Number(preview?.pageCount) || 0;
  const textPages = Number(preview?.textPages);
  const scannedSignal = preview?.ocr === true
    || String(preview?.source || '').includes('pdfjs')
    || (Number.isFinite(textPages) && pageCount > 0 && textPages < pageCount);

  if (allMeasurements.length === 0) {
    worse('red');
    reasons.push('No readings could be extracted — the report may be a scan needing OCR or an unrecognised layout. Review manually; do not treat it as complete.');
  } else if (scannedSignal && pageCount > 1 && allMeasurements.length < pageCount) {
    worse('yellow');
    reasons.push('Looks like a scan/mixed PDF and far fewer readings were extracted than its page count suggests — verify none were missed.');
  }
  if (preview?.truncated === true) {
    worse('yellow');
    reasons.push('Extraction was truncated (large document) — readings past the limit may be missing.');
  }

  // Cross-pass disagreement: two independent extraction passes produced
  // different values for the same measurement (flagged in testReportPreview).
  const disagreements = allMeasurements.filter((m: any) => m && m.crossPassDisagreement === true).length;
  if (disagreements > 0) {
    worse('yellow');
    reasons.push(`${disagreements} reading${disagreements === 1 ? '' : 's'} where two extraction passes disagreed on the value — verify against the source report.`);
  }

  // ── Domain cross-consistency validators (Part 2) ────────────────────────────
  // Internal-consistency checks (peer balance, PI/DAR/TDCG recompute, gas
  // plausibility, temp-correction, report-verdict cross-check, completeness).
  // They ROUTE suspect extractions to review; they never assert compliance or
  // rewrite a value. Must never break the gate — degrade to prior scoring.
  try {
    const { checkDomainConsistency } = require('./domainValidators');
    // [W8, investigated 2026-07-05 -- NOT wired, flagged for Dustin]
    // domainValidators.completeness() reads ctx.meta.equipmentType ||
    // ctx.equipmentType to flag e.g. a "switchgear" report with no
    // contact_resistance reading -- but `preview.meta` never carries
    // equipmentType in production, so this check has been a permanent no-op
    // (a genuine fallback-masks-capture shape: a coverage check that looks
    // active but never fires). Tried wiring it to the same equipmentType
    // inference commitPreviewSections uses at commit time and it broke
    // __tests__/routes/ingestReviewGate.test.ts's green-path fixture (a
    // switchgear insulation-resistance-only report, which IS a common,
    // legitimate real-world scope -- IR and contact-resistance are often
    // separate test visits/intervals). REQUIRED_BY_TYPE's "this equipment
    // type must have this reading IN THIS REPORT" heuristic is stronger than
    // real NETA practice supports and would manufacture false-positive
    // review friction against the product's frictionless-ingest posture.
    // Needs Dustin's call: loosen REQUIRED_BY_TYPE (e.g. only fire when an
    // asset has NEVER had that reading type across any report) before this
    // is safe to wire live.
    const findings = checkDomainConsistency(allMeasurements, {
      meta: preview?.meta || {},
      reportVerdict: (preview?.meta && preview.meta.reportResult) || preview?.reportVerdict || null,
    });
    for (const f of (Array.isArray(findings) ? findings : [])) {
      worse(f.severity === 'error' ? 'red' : 'yellow');
      if (f.message) reasons.push(f.message);
    }
  } catch (e: any) {
    console.warn('[ingestGate] domain validators skipped:', e && e.message ? e.message : String(e));
  }

  return {
    autoCommit: band === 'green' && hasUnits,
    band,
    threshold,
    source: preview?.source || null,
    ocr: !!preview?.ocr,
    reasons,
    units: unitResults,
  };
}

module.exports = { evaluateIngestGate, DEFAULT_THRESHOLD, clampThreshold };

export {};
