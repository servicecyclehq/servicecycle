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

function clampThreshold(t: any): number {
  const n = Number(t);
  if (!isFinite(n) || n <= 0) return DEFAULT_THRESHOLD;
  if (n > 1) return 1;
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
  for (const m of unit.measurements) {
    const c = (m && typeof m.confidence === 'number') ? m.confidence : null;
    if (c == null) continue;
    min = min == null ? c : Math.min(min, c);
    if (c < threshold) {
      belowCount++;
      if (m.passFail === 'RED') worse('red');
      else worse('yellow');
    }
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
  const units: Array<Parameters<typeof evaluateUnit>[1]> = [];
  if (Array.isArray(preview?.sections) && preview.sections.length > 1) {
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

  // No usable units at all — nothing to commit; let the worker handle it as a
  // no-op done (not a review item).
  const hasUnits = unitResults.length > 0;

  return {
    autoCommit: band === 'green' && hasUnits,
    band: hasUnits ? band : 'green',
    threshold,
    source: preview?.source || null,
    ocr: !!preview?.ocr,
    reasons,
    units: unitResults,
  };
}

module.exports = { evaluateIngestGate, DEFAULT_THRESHOLD, clampThreshold };

export {};
