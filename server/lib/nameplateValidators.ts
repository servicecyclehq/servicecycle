/**
 * lib/nameplateValidators.ts — cross-field domain consistency checks for
 * NAMEPLATE OCR reads.
 *
 * Companion to lib/measurementSanity.applyNameplateDowngrades — that layer
 * checks each field alone against a very generous plausibility envelope
 * ("kva>0 and <=5,000,000") and cannot catch the observed failure class:
 * an adjacent-value grab, e.g. `kva=60` next to `frequency="60 Hz"` where
 * the OCR read a crisp "60" from the wrong line. That value passes every
 * per-field check but is nonsense in context. See
 * docs/NAMEPLATE_INGESTION_REVIEW_2026-07-03.md §4 for the full design.
 *
 * ── POSTURE (recorded policy — do not weaken) ────────────────────────────────
 * Every check here is an INTERNAL-CONSISTENCY test — same posture as
 * lib/domainValidators.ts. It NEVER:
 *   - asserts compliance / pass-fail against a standard,
 *   - computes a PPE category,
 *   - rewrites or auto-corrects an extracted value.
 * A failed check ROUTES the suspect field to human review by downgrading
 * confidence to 'low' and appending a machine-readable reason. The tech in
 * front of the plate confirms. This mirrors the PPE-liability posture: SC
 * does not compute authoritative electrical verdicts.
 *
 * Called after applyNameplateDowngrades in routes/assetPhotoInspect.ts
 * (POST /api/assets/ocr-nameplate). Pure; no I/O; must never throw.
 */

'use strict';

// ── Reference data (constants) ──────────────────────────────────────────────

// IEEE C57.12-series standard kVA ratings.
// Sources: Schneider FAQ FA91532, Eaton MV transformer fundamentals.
// 1-phase distribution + station transformer ladder (kVA).
export const STD_KVA_1PH = [
  1, 1.5, 2, 3, 5, 7.5, 10, 15, 25, 37.5, 50, 75, 100, 167, 200, 250, 333, 500,
];

// 3-phase distribution + power transformer ladder (kVA).
export const STD_KVA_3PH = [
  3, 6, 9, 15, 30, 45, 75, 112.5, 150, 225, 300, 500, 750, 1000, 1500, 2000,
  2500, 3000, 3750, 5000, 7500, 10000, 12500, 15000, 20000, 25000, 30000,
];

// ANSI C84.1 system-nominal voltages PLUS NEMA MG-1 motor UTILIZATION voltages
// (115/230/460/575). A voltage validator that only knows system voltages
// false-flags every motor plate. Values in volts.
export const STD_VOLTAGES = [
  110, 115, 120, 208, 220, 230, 240, 277, 347, 380, 400, 415, 440, 460, 480,
  550, 575, 600,
  // medium/high voltage:
  2300, 2400, 4160, 4800, 6900, 7200, 12000, 12470, 13200, 13800, 22860, 24940,
  34500, 46000, 69000,
];

// Frequency set. Also accept the "50/60" dual-marked plates.
export const STD_FREQ = new Set([50, 60]);

// ── Finding shape returned to the route ─────────────────────────────────────

export interface NameplateFinding {
  field:   string;
  code:    string;
  message: string;
}

// ── Value parsers ───────────────────────────────────────────────────────────

/**
 * Parse the numeric core out of a voltage string. Handles kV suffix and
 * multi-voltage strings ("480/277V" → returns 480; the first component).
 * For multi-component checks (V3), use parseVoltageComponents() below.
 */
function parseVoltageNumber(s: any): number | null {
  const str = String(s ?? '').trim();
  if (!str) return null;
  const isKv = /kv/i.test(str);
  const raw = parseFloat(str);
  if (!Number.isFinite(raw)) return null;
  return isKv ? raw * 1000 : raw;
}

/**
 * Split a multi-voltage string into every numeric component (volts).
 * "480/277V"      → [480, 277]
 * "4160-480V"     → [4160, 480]
 * "480Y/277"      → [480, 277]
 * "13.8kV/480V"   → [13800, 480]
 * "480"           → [480]
 * Components carry the string's kV-flag: if ANY "kV" appears in the string,
 * ALL sub-values are treated as kV. Real dual-voltage nameplates never mix
 * kV and V in one field — they say "13.8kV / 480V" as two labels.
 */
export function parseVoltageComponents(s: any): number[] {
  const str = String(s ?? '').trim();
  if (!str) return [];
  const isKv = /kv/i.test(str);
  // Split on /, -, comma, whitespace, letters (V, Y, D, etc.)
  const parts = str.split(/[\/\-,\s]+|[A-Za-z]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = parseFloat(p);
    if (Number.isFinite(n) && n > 0) {
      out.push(isKv ? n * 1000 : n);
    }
  }
  return out;
}

/** Frequency parser — grabs the leading integer, tolerates "60 Hz", "50/60 Hz". */
function parseFrequency(s: any): number[] {
  const str = String(s ?? '').trim();
  if (!str) return [];
  const matches = str.match(/\d+(?:\.\d+)?/g) || [];
  return matches
    .map((m) => parseFloat(m))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Numeric coercion for kva/amperage/phases. */
function numeric(v: any): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Off-ladder detector with a small ±1% tolerance for decimal formatting. */
function onLadder(v: number, ladder: number[], relTol = 0.01): boolean {
  for (const std of ladder) {
    if (Math.abs(v - std) <= Math.max(std * relTol, 0.001)) return true;
  }
  return false;
}

// ── Confidence helper ───────────────────────────────────────────────────────

function downgrade(confidence: Record<string, string>, field: string): void {
  // Never upgrade — only pull down. If already 'low', leave it.
  const cur = confidence[field];
  if (cur === 'low') return;
  confidence[field] = 'low';
}

// ── The validator ───────────────────────────────────────────────────────────

/**
 * Run all nameplate domain-consistency checks. Mutates `confidence` in place
 * (downgrades to 'low') and returns machine-readable findings so the client
 * tooltip can explain WHY a field is red ("60 also appears as the frequency
 * — verify the kVA line"). NEVER auto-corrects a value; NEVER asserts
 * compliance.
 *
 * Wired after applyNameplateDowngrades so the per-field range checks run
 * first (they can drop a value to 'low' on their own criteria).
 */
export function checkNameplateConsistency(
  fields: Record<string, any>,
  confidence: Record<string, string>,
): NameplateFinding[] {
  const out: NameplateFinding[] = [];
  if (!fields || typeof fields !== 'object') return out;

  const kvaNum   = numeric(fields.kva);
  const ampNum   = numeric(fields.amperage);
  const yearNum  = numeric(fields.year);
  const phasesN  = numeric(fields.phases);
  const vComps   = parseVoltageComponents(fields.voltage);
  const freqNums = parseFrequency(fields.frequency);

  // ── V1: duplicate-value across semantically-unrelated fields ───────────────
  // Priors (highest first): frequency ∈ {50,60} is near-certain; year is
  // strong; kVA/amperage/voltage are weak. Downgrade the WEAKER prior.
  //
  // Canonical case: kva=60 & frequency="60 Hz" → downgrade KVA (frequency is
  // the more confident field).
  if (kvaNum != null && freqNums.some((f) => f === kvaNum)) {
    downgrade(confidence, 'kva');
    out.push({
      field:   'kva',
      code:    'kva_equals_frequency',
      message: `kVA (${kvaNum}) matches the frequency value — verify the kVA line on the plate`,
    });
  }
  if (ampNum != null && freqNums.some((f) => f === ampNum) && ampNum < 200) {
    // Only fire below 200A — most transformer plates carry frequency in the
    // 50/60 band, so amperages that equal a valid frequency are always small.
    downgrade(confidence, 'amperage');
    out.push({
      field:   'amperage',
      code:    'amperage_equals_frequency',
      message: `Amperage (${ampNum}) matches the frequency value — verify`,
    });
  }
  // kva == amperage is suspicious for medium/large plates (numerically
  // possible on tiny 1-phase units, but a strong misread signal on 3-phase).
  if (kvaNum != null && ampNum != null && kvaNum === ampNum && kvaNum > 25) {
    downgrade(confidence, 'kva');
    downgrade(confidence, 'amperage');
    out.push({
      field:   'kva',
      code:    'kva_equals_amperage',
      message: `kVA and amperage are the same number (${kvaNum}) — verify both`,
    });
  }
  // Voltage value duplicates kVA or amperage → suspect that voltage was
  // pulled from the wrong line.
  for (const vc of vComps) {
    if (kvaNum != null && vc === kvaNum && vc < 1000) {
      // Only for low values (<1kV); a real 480V system commonly has kVA in
      // that range and the coincidence is legitimate — but if the number
      // duplicates AND is tiny (say voltage=60 kva=60), the grab is wrong.
      // We only flag if BOTH values are ≤ typical frequency band (≤ 100).
      if (vc <= 100 && kvaNum <= 100) {
        downgrade(confidence, 'voltage');
        out.push({
          field:   'voltage',
          code:    'voltage_equals_kva',
          message: `Voltage component (${vc}) matches kVA — verify voltage line`,
        });
        break;
      }
    }
  }

  // ── V2: kVA standard-ladder check ────────────────────────────────────────
  if (kvaNum != null && kvaNum > 0) {
    let onSomeLadder = false;
    if (phasesN === 1) {
      onSomeLadder = onLadder(kvaNum, STD_KVA_1PH);
    } else if (phasesN === 3) {
      onSomeLadder = onLadder(kvaNum, STD_KVA_3PH);
    } else {
      // Phases unknown — accept membership in EITHER ladder.
      onSomeLadder = onLadder(kvaNum, STD_KVA_1PH) || onLadder(kvaNum, STD_KVA_3PH);
    }
    if (!onSomeLadder) {
      downgrade(confidence, 'kva');
      out.push({
        field:   'kva',
        code:    'kva_not_standard_size',
        message: `kVA ${kvaNum} is not on the IEEE C57.12 standard-size ladder — verify (specialty sizes exist; confirm the plate)`,
      });
    }
  }

  // ── V3: voltage-class check (±10% tolerance for ANSI Range B) ────────────
  if (vComps.length > 0) {
    const RANGE_TOL = 0.10;
    const allWithinClass = vComps.every((v) => {
      for (const std of STD_VOLTAGES) {
        if (Math.abs(v - std) <= std * RANGE_TOL) return true;
      }
      return false;
    });
    if (!allWithinClass) {
      downgrade(confidence, 'voltage');
      out.push({
        field:   'voltage',
        code:    'voltage_not_standard_class',
        message: `Voltage ${fields.voltage} is not within ±10% of any ANSI C84.1 / NEMA MG-1 class — verify`,
      });
    }
  }

  // ── V4: electrical-relationship consistency (transformer plates) ─────────
  // When kVA, voltage, amperage, and phases are all present, at least one
  // voltage component must satisfy kVA ≈ √3 · V · A / 1000 (3φ) or V·A/1000
  // (1φ) within ±20% (tolerance covers taps, dual ratings, rounding).
  if (kvaNum != null && ampNum != null && vComps.length > 0 && (phasesN === 1 || phasesN === 3)) {
    const factor = phasesN === 3 ? Math.sqrt(3) : 1;
    let anyOk = false;
    for (const V of vComps) {
      const expectedKva = (factor * V * ampNum) / 1000;
      if (expectedKva > 0) {
        const rel = Math.abs(expectedKva - kvaNum) / expectedKva;
        if (rel <= 0.20) { anyOk = true; break; }
      }
    }
    if (!anyOk) {
      downgrade(confidence, 'kva');
      downgrade(confidence, 'voltage');
      downgrade(confidence, 'amperage');
      out.push({
        field:   'kva',
        code:    'kva_va_relationship_mismatch',
        message: `kVA / voltage / amperage do not satisfy the transformer VA equation within ±20% — verify all three`,
      });
    }
  }

  // ── V5: frequency set ────────────────────────────────────────────────────
  if (freqNums.length > 0) {
    const allStandard = freqNums.every((f) => STD_FREQ.has(f));
    if (!allStandard) {
      downgrade(confidence, 'frequency');
      out.push({
        field:   'frequency',
        code:    'frequency_not_standard',
        message: `Frequency ${fields.frequency} is not 50 Hz or 60 Hz — verify`,
      });
    }
  }

  // ── V6: year-adjacency check ────────────────────────────────────────────
  // If the year value appears as a 4-digit substring of serialNumber or model,
  // the OCR may have grabbed a model-fragment as the manufacture year.
  if (yearNum != null && yearNum >= 1900 && yearNum <= 2100) {
    const yearStr = String(Math.trunc(yearNum));
    const serial = String(fields.serialNumber ?? '');
    const model  = String(fields.model ?? '');
    const inSerial = serial.length > 0 && serial.includes(yearStr) && serial !== yearStr;
    const inModel  = model.length > 0  && model.includes(yearStr)  && model !== yearStr;
    if (inSerial || inModel) {
      downgrade(confidence, 'year');
      out.push({
        field:   'year',
        code:    'year_may_be_model_fragment',
        message: `Year ${yearStr} appears inside the ${inSerial ? 'serial number' : 'model'} — verify the year line`,
      });
    }
  }

  return out;
}

/**
 * V7 — Evidence-string check.
 *
 * Requires the model to have returned, per field, the verbatim nameplate
 * snippet it read the value from (see the ocrNameplateWithEvidence contract
 * in routes/assetPhotoInspect.ts). This is a deterministic check: the
 * evidence for `kva` must contain a kVA-family unit token AND must not
 * contain "Hz|HERTZ|CYCLES"; amperage evidence must contain "A|AMP"; etc.
 *
 * Missing evidence for a field with a value → downgrade to 'low' with reason
 * 'no_evidence' (weaker signal than a contradicted evidence — we cap at
 * medium to reflect the ambiguity). A CONTRADICTED evidence (unit keyword
 * mismatch) → 'low' with reason 'evidence_label_mismatch'.
 *
 * If the caller has no evidence map (older client / model regressed), the
 * validator no-ops.
 */
export function checkNameplateEvidence(
  fields:     Record<string, any>,
  confidence: Record<string, string>,
  evidence:   Record<string, string> | null | undefined,
): NameplateFinding[] {
  const out: NameplateFinding[] = [];
  if (!evidence || typeof evidence !== 'object') return out;

  const RULES: Record<string, { must: RegExp; mustNot?: RegExp; label: string }> = {
    kva:       { must: /\bkVA\b|\bkva\b|KVA/i, mustNot: /Hz|HERTZ|CYCLES/i,               label: 'kVA' },
    voltage:   { must: /\bV(?:OLT)?S?\b/i,     mustNot: /\bHz\b|\bA\b|\bAMP/i,             label: 'volts' },
    amperage:  { must: /\bA(?:MP)?S?\b/i,      mustNot: /\bHz\b|\bV(?:OLT)?\b|\bKVA\b/i,   label: 'amps' },
    frequency: { must: /Hz|HERTZ|CYCLES/i,     mustNot: /\bKVA\b|\bAMP/i,                  label: 'Hz' },
    year:      { must: /(19|20)\d{2}/,         label: 'year' },
  };

  for (const [field, rule] of Object.entries(RULES)) {
    const value = fields[field];
    if (value == null || value === '') continue;
    const snippet = evidence[field];
    if (snippet == null || String(snippet).trim() === '') {
      // No evidence — cap confidence at 'medium' rather than dropping to low.
      // Absence of evidence is weaker than contradiction.
      if (confidence[field] === 'high') {
        confidence[field] = 'medium';
        out.push({
          field,
          code:    'no_evidence',
          message: `Model provided no source snippet for ${field} — verify`,
        });
      }
      continue;
    }
    const snip = String(snippet);
    const hasMust = rule.must.test(snip);
    const hasMustNot = rule.mustNot ? rule.mustNot.test(snip) : false;
    if (!hasMust || hasMustNot) {
      downgrade(confidence, field);
      out.push({
        field,
        code:    'evidence_label_mismatch',
        message: `Source snippet for ${field} does not contain the expected ${rule.label} label${hasMustNot ? ' (contains a conflicting unit)' : ''} — verify`,
      });
    }
  }
  return out;
}

// CommonJS export for require() callers (esbuild handles TS compilation
// through the wider server build; require() is the pattern used in
// routes/assetPhotoInspect.ts).
module.exports = {
  STD_KVA_1PH,
  STD_KVA_3PH,
  STD_VOLTAGES,
  STD_FREQ,
  parseVoltageComponents,
  checkNameplateConsistency,
  checkNameplateEvidence,
};

export {};
