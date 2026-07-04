/**
 * lib/domainValidators.ts — cross-measurement domain consistency checks.
 *
 * Sprint-1 of the PDF-ingestion review (docs/PDF_INGESTION_REVIEW_2026-07-03.md,
 * docs/PDF_INGESTION_SYNTHESIS_2026-07-03.md). These are the highest-leverage
 * accuracy defence in the whole stack: a confidence score cannot catch a value
 * that OCR'd or parsed *cleanly* but wrong (4.2 read as 42) — physics can.
 *
 * ── POSTURE (recorded policy — do not weaken) ────────────────────────────────
 * Every check here is an INTERNAL-CONSISTENCY test. It asks only "do these
 * numbers agree with each other and with the report's own printed values?" It
 * NEVER:
 *   - asserts compliance / pass-fail against a standard,
 *   - computes or displays a PPE category,
 *   - rewrites or auto-corrects an extracted value.
 * A failed check ROUTES the extraction to human review (via the confidence
 * gate). That is the only action it takes. This keeps it consistent with the
 * PPE-liability posture (SC does not compute authoritative electrical verdicts).
 *
 * Wired into lib/ingestConfidenceGate.evaluateIngestGate: an `error` finding
 * pushes the document to RED (review), a `warning` to YELLOW. Pure; no I/O;
 * must never throw (the gate wraps the call, but keep it total anyway).
 */

'use strict';

export type DomainSeverity = 'error' | 'warning';

export interface DomainFinding {
  code:     string;
  severity: DomainSeverity;
  message:  string;
}

export interface DomainContext {
  meta?:          Record<string, any>;
  equipmentType?: string | null;
  /** The report's own printed PASS/FAIL result, if the extractor recovered it. */
  reportVerdict?: string | null;
}

function numVal(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function lab(m: any): string {
  return String((m && (m.label || m.measurementType)) || '').toLowerCase();
}

// ── 1. Pole / peer balance — NETA MTS §7.6.1.2 ───────────────────────────────
// "Investigate values that deviate from adjacent poles or similar breakers by
// more than 50 percent of the lowest value." Applied per measurement type
// across phases. Contact resistance uses the NETA 50% spread; winding
// resistance is tighter (a healthy 3-phase winding set is within a few percent,
// IEEE C57.152) so a wider spread is a stronger misread signal. This single
// rule catches the canonical 4.2 -> 42 decimal-drop class.
const BALANCE_TOLERANCE: Record<string, number> = {
  contact_resistance: 0.5,   // NETA 50%-of-lowest
  winding_resistance: 0.05,  // 5% across phases
};

function poleBalance(measurements: any[], out: DomainFinding[]): void {
  for (const type of Object.keys(BALANCE_TOLERANCE)) {
    const tol = BALANCE_TOLERANCE[type];
    const nums = measurements
      .filter((m) => m && m.measurementType === type && m.phase)
      .map((m) => numVal(m.asFoundValue))
      .filter((v): v is number => v != null && v > 0);
    if (nums.length < 2) continue;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min > 0 && max - min > tol * min) {
      out.push({
        code: `${type}_pole_imbalance`,
        severity: 'warning',
        message: `${type.replace(/_/g, ' ')} varies by more than ${Math.round(tol * 100)}% across phases (low ${min}, high ${max}) — NETA MTS flags this spread. Verify the outlier was not misread (e.g. a dropped decimal).`,
      });
    }
  }
}

// ── 2. Acetylene (C2H2) plausibility ─────────────────────────────────────────
// C2H2 is almost always single-digit ppm. A high value is EITHER active arcing
// (a real, serious fault) OR a misread — the validator cannot tell which, so it
// routes to review rather than asserting either. Warning-level on purpose.
function acetylene(measurements: any[], out: DomainFinding[]): void {
  for (const m of measurements) {
    if (!m || m.measurementType !== 'dissolved_gas') continue;
    if (!/c2h2|acetylene/.test(lab(m))) continue;
    const v = numVal(m.asFoundValue);
    if (v != null && v > 100) {
      out.push({
        code: 'c2h2_implausible',
        severity: 'warning',
        message: `Acetylene (C2H2) of ${v} ppm is unusually high — either active arcing (a serious real fault) or a misread. Verify against the lab report before it drives a verdict.`,
      });
      break;
    }
  }
}

// ── 3. TDCG checksum ─────────────────────────────────────────────────────────
// TDCG = H2 + CH4 + C2H2 + C2H4 + C2H6 + CO (CO2 excluded). If the report prints
// TDCG, recompute it from the component gases; a mismatch means one gas was
// misread. C57.104-2019 dropped TDCG as a *compliance* metric — using it purely
// as an internal checksum is exactly the right, liability-safe use.
function tdcgChecksum(measurements: any[], out: DomainFinding[]): void {
  const gas: Record<string, number> = {};
  let reported: number | null = null;
  for (const m of measurements) {
    if (!m || m.measurementType !== 'dissolved_gas') continue;
    const l = lab(m);
    const v = numVal(m.asFoundValue);
    if (v == null) continue;
    if (/tdcg|total dissolved|total combustible/.test(l)) { reported = v; continue; }
    if (/co2|carbon dioxide/.test(l)) continue; // excluded from TDCG
    if (/\bh2\b|hydrogen/.test(l)) gas.h2 = v;
    else if (/ch4|methane/.test(l)) gas.ch4 = v;
    else if (/c2h2|acetylene/.test(l)) gas.c2h2 = v;
    else if (/c2h4|ethylene/.test(l)) gas.c2h4 = v;
    else if (/c2h6|ethane/.test(l)) gas.c2h6 = v;
    else if (/\bco\b|carbon monoxide/.test(l)) gas.co = v;
  }
  const comps = Object.keys(gas);
  if (reported != null && comps.length >= 4) {
    const sum = comps.reduce((s, k) => s + gas[k], 0);
    if (Math.abs(sum - reported) > Math.max(5, 0.1 * reported)) {
      out.push({
        code: 'tdcg_mismatch',
        severity: 'warning',
        message: `Printed TDCG (${reported}) does not match the sum of its component gases (${Math.round(sum)}) — a gas value was likely misread. Verify against the DGA lab report.`,
      });
    }
  }
}

// ── 4. Polarization Index recompute (best-effort) ────────────────────────────
// PI = IR(10 min) / IR(1 min). Only fires when both timed IR readings AND a
// printed PI are all present and clearly labelled; a safe no-op otherwise.
// Skipped when IR(1 min) > 5000 MΩ (IEEE 43 says PI is ambiguous there).
function piRecompute(measurements: any[], out: DomainFinding[]): void {
  const irAt = (re: RegExp): number | null => {
    const m = measurements.find(
      (x) => x && x.measurementType === 'insulation_resistance' && re.test(lab(x)) && numVal(x.asFoundValue) != null,
    );
    return m ? numVal(m.asFoundValue) : null;
  };
  const ir1 = irAt(/1\s*min|\b60\s*s|t1\b/);
  const ir10 = irAt(/10\s*min|\b600\s*s|t10\b/);
  const piRow = measurements.find((x) => x && x.measurementType === 'polarization_index' && numVal(x.asFoundValue) != null);
  if (ir1 == null || ir10 == null || ir1 <= 0 || ir1 > 5000 || !piRow) return;
  const computed = ir10 / ir1;
  const reported = numVal(piRow.asFoundValue);
  if (reported != null && Math.abs(computed - reported) > Math.max(0.3, 0.15 * reported)) {
    out.push({
      code: 'pi_mismatch',
      severity: 'warning',
      message: `Printed Polarization Index (${reported}) does not match IR(10 min)/IR(1 min) = ${computed.toFixed(2)} — a value was likely misread. Verify.`,
    });
  }
}

// ── 4b. Temperature-correction consistency (IEEE-43 IR temp-correction) ─────
// Insulation-resistance readings are commonly reported both RAW (at the
// reading temperature) and CORRECTED to a 40 °C reference via the IEEE-43
// convention IR_40 = IR_raw × 0.5^((40 − T)/10). When BOTH values appear on
// the report AND the temperature is known, this reconciles them: a
// disagreement flags for review because one of the three (raw, corrected,
// temperature) was misread.
//
// POSTURE: never asserts compliance, never rewrites a value. Silently no-ops
// unless it can find a raw + corrected pair AND a plausible temperature —
// absence of evidence is not a flag.
//
// Pairing rule: two insulation_resistance rows with the same phase are
// treated as a raw/corrected pair when ONE label mentions "corrected" (or
// "@ 40" / "reference") and the OTHER either mentions "raw" / "measured" /
// "as found" or lacks any correction qualifier. Ambiguous singletons don't
// pair. The extractor may eventually thread paired values on a single row
// (measurement.correctedValue + measurement.temperatureC); this validator
// prefers those when present.
const CORR_LABEL_RE = /\b(corrected|@\s*40|to\s*40|reference|40\s*°?\s*c)\b/;
const RAW_LABEL_RE  = /\b(raw|measured|as\s*[- ]?found|uncorrected)\b/;

function tempCorrectionFactor(tempC: number): number {
  // IEEE-43 approximation: doubles per −10 °C from the 40 °C reference.
  return Math.pow(0.5, (40 - tempC) / 10);
}

function tempCorrection(measurements: any[], ctx: DomainContext, out: DomainFinding[]): void {
  // Temperature source: per-row wins over meta-level (a row on a mixed report
  // may have its own temperature stamp), but meta is the common case since
  // the header carries the one-per-report ambient reading.
  const metaTempC = numVal((ctx.meta && (ctx.meta as any).ambientTempC));
  const insulation = measurements.filter((m) => m && m.measurementType === 'insulation_resistance');
  if (!insulation.length) return;

  // Case A — single row carries paired values on itself.
  for (const m of insulation) {
    const raw       = numVal(m.asFoundValue);
    const corrected = numVal(m.correctedValue);
    const rowTempC  = numVal(m.temperatureC);
    const tempC     = rowTempC != null ? rowTempC : metaTempC;
    if (raw == null || corrected == null || tempC == null || raw === 0) continue;
    const expected = raw * tempCorrectionFactor(tempC);
    if (expected === 0) continue;
    const relErr = Math.abs(corrected - expected) / expected;
    if (relErr > 0.10) {
      out.push({
        code: 'temp_correction_mismatch',
        severity: 'warning',
        message: `Insulation resistance temperature-correction mismatch (${m.phase || 'no phase'}): reported raw ${raw} + corrected ${corrected} at ${tempC} °C predicts corrected ≈ ${expected.toFixed(1)} (IEEE-43). Verify the temperature or one of the readings.`,
      });
    }
  }

  // Case B — separate rows for raw and corrected. Pair by phase.
  const byPhase = new Map<string, any[]>();
  for (const m of insulation) {
    const key = String(m.phase || '').toLowerCase();
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)!.push(m);
  }
  for (const [, rows] of byPhase) {
    if (rows.length < 2) continue;
    const raws       = rows.filter((r) => RAW_LABEL_RE.test(lab(r)) || (!CORR_LABEL_RE.test(lab(r))));
    const correcteds = rows.filter((r) => CORR_LABEL_RE.test(lab(r)));
    if (!raws.length || !correcteds.length) continue;
    for (const rawRow of raws) {
      const raw = numVal(rawRow.asFoundValue);
      if (raw == null || raw === 0) continue;
      const rowTempC = numVal(rawRow.temperatureC);
      const tempC = rowTempC != null ? rowTempC : metaTempC;
      if (tempC == null) continue;
      const expected = raw * tempCorrectionFactor(tempC);
      if (expected === 0) continue;
      for (const corRow of correcteds) {
        if (corRow === rawRow) continue;
        const corrected = numVal(corRow.asFoundValue);
        if (corrected == null) continue;
        const relErr = Math.abs(corrected - expected) / expected;
        if (relErr > 0.10) {
          out.push({
            code: 'temp_correction_mismatch',
            severity: 'warning',
            message: `Insulation resistance temperature-correction mismatch (${rawRow.phase || 'no phase'}): raw ${raw} + corrected ${corrected} at ${tempC} °C predicts corrected ≈ ${expected.toFixed(1)} (IEEE-43). Verify the temperature or one of the readings.`,
          });
          // Only flag the first mismatched pair per phase — avoid spamming
          // findings on a report that lists many phase permutations.
          break;
        }
      }
    }
  }
}

// ── 5. Report-verdict cross-check ────────────────────────────────────────────
// The extractor already recovers the report's own PASS/FAIL. If the printed
// verdict disagrees with the verdict computed from the readings (any RED =>
// FAIL), one of them was misread. Flag for review; never auto-flip either.
function normalizeVerdict(v: any): 'PASS' | 'FAIL' | null {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  // Vocabulary aligned with extractor.py _REPORT_VERDICT_RE / _RESULT_RE — the
  // extractor emits whichever printed token the report used ("PASS" / "SAT" /
  // "SATISFACTORY" / etc.), and this canonicalizes them to PASS or FAIL.
  // MARGINAL / DEFICIENT are deliberately unmapped: the report's own author
  // did not commit either way and we would rather return null (no cross-check
  // fires) than force one side.
  if (/^(pass|passed|green|ok|accept|acceptable|satisfactory|sat)$/.test(s)) return 'PASS';
  if (/^(fail|failed|red|reject|rejected|unacceptable|defective|unsatisfactory|unsat)$/.test(s)) return 'FAIL';
  return null;
}

function verdictCrossCheck(measurements: any[], ctx: DomainContext, out: DomainFinding[]): void {
  const rv = normalizeVerdict(ctx.reportVerdict);
  if (!rv || !measurements.length) return;
  const computed: 'PASS' | 'FAIL' = measurements.some((m) => m && m.passFail === 'RED') ? 'FAIL' : 'PASS';
  if (rv !== computed) {
    out.push({
      code: 'verdict_mismatch',
      severity: 'warning',
      message: `The report's printed result (${rv}) disagrees with the result computed from its readings (${computed}) — a reading or the verdict may be misread. Review before committing.`,
    });
  }
}

// ── 6. Completeness — expected-but-missing measurement type ───────────────────
// Coverage counterpart to the value checks: the silent-recall failure mode where
// a template change means an expected reading is never extracted, so the report
// "looks clean". Safe no-op unless the equipment type is known AND non-empty.
const REQUIRED_BY_TYPE: Array<{ match: RegExp; require: string[]; label: string }> = [
  { match: /transformer/i,             require: ['insulation_resistance'], label: 'transformer' },
  { match: /breaker|recloser/i,        require: ['contact_resistance'],    label: 'breaker' },
  { match: /switchgear|switch/i,       require: ['contact_resistance'],    label: 'switchgear' },
  { match: /cable/i,                   require: ['insulation_resistance'], label: 'cable' },
  { match: /motor|generator/i,         require: ['insulation_resistance'], label: 'motor/generator' },
];

function completeness(measurements: any[], ctx: DomainContext, out: DomainFinding[]): void {
  const et = String((ctx.meta && ctx.meta.equipmentType) || ctx.equipmentType || '').trim();
  if (!et || !measurements.length) return; // empty handled by the silent-empty guard
  const rule = REQUIRED_BY_TYPE.find((r) => r.match.test(et));
  if (!rule) return;
  const present = new Set(measurements.map((m) => m && m.measurementType));
  const missing = rule.require.filter((t) => !present.has(t));
  if (missing.length) {
    out.push({
      code: 'incomplete_report',
      severity: 'warning',
      message: `This looks like a ${rule.label} report but no ${missing.join(', ').replace(/_/g, ' ')} reading was extracted — the expected test may be missing or unparsed. Review for completeness.`,
    });
  }
}

/**
 * Run all domain consistency checks over a full measurement set.
 * Pure and total (never throws). Returns [] when everything is consistent.
 *
 * The temp-correction check is active when the extractor supplied
 * `ctx.meta.ambientTempC` (or per-row `temperatureC`) AND the report carries
 * a raw + corrected insulation-resistance pair (either as two rows or as a
 * single row with `correctedValue`). Otherwise it silently no-ops.
 */
export function checkDomainConsistency(measurements: any[], ctx: DomainContext = {}): DomainFinding[] {
  const out: DomainFinding[] = [];
  const list = Array.isArray(measurements) ? measurements : [];
  try {
    poleBalance(list, out);
    acetylene(list, out);
    tdcgChecksum(list, out);
    piRecompute(list, out);
    tempCorrection(list, ctx, out);
    verdictCrossCheck(list, ctx, out);
    completeness(list, ctx, out);
  } catch {
    // total by contract — a validator bug must never break ingest.
  }
  return out;
}

module.exports = { checkDomainConsistency };
export {};
