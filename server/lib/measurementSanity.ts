/**
 * lib/measurementSanity.ts
 *
 * Two complementary sanity layers for ingested test-report and nameplate data.
 *
 * ── Layer 1: post-commit advisory (existing) ─────────────────────────────────
 *   checkMeasurementSanity() / BANDS
 *   Catches order-of-magnitude unit/scale errors AFTER a measurement is committed
 *   to the database.  Creates an ADVISORY deficiency so a human can verify the
 *   reading and its unit against the source report.  Advisory / non-blocking.
 *   Used by lib/commitTestReport.ts.
 *
 * ── Layer 2: pre-parse physical-plausibility gate (new) ──────────────────────
 *   checkMeasurement() / checkMeasurements()
 *   Runs BEFORE auto-commit (inside parseTestReport / the ingest confidence gate).
 *   Checks for physically IMPOSSIBLE values — not "plausible but suspicious" like
 *   Layer 1, but actually outside the physical envelope.  An ERROR-severity Finding
 *   forces the measurement to passFail='RED' so evaluateUnit() in
 *   ingestConfidenceGate.ts routes the whole unit to the Review Queue.
 *   Modelled on lib/arcFlashSanity.ts: deterministic, no AI, Finding[] shape.
 *
 * ── Layer 3: nameplate OCR confidence downgrades (new) ───────────────────────
 *   applyNameplateDowngrades()
 *   Extends the serialNumber/year/phases inline checks in assetPhotoInspect.ts
 *   to cover voltage, kva, amperage, and enclosureRating.  Mutates the confidence
 *   map in-place.  Extracted here so the logic is unit-testable without the route.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1 — post-commit advisory (PRESERVED — do not modify; used by commitTestReport.ts)
// ═══════════════════════════════════════════════════════════════════════════════

const BANDS = [
  { match: /insulation|megger|\bir[_-]|polarization/i, min: 0,    max: 1e7,  label: 'insulation resistance (MOhm/GOhm)' },
  { match: /contact|connection|micro[_-]?ohm|ductor|\bdlro\b/i, min: 0, max: 5e5, label: 'contact resistance (uOhm)' },
  { match: /winding[_-]?res/i,           min: 0,    max: 1e6,  label: 'winding resistance' },
  { match: /ground|earth|fall[_-]?of[_-]?potential/i, min: 0, max: 1e4, label: 'ground resistance (Ohm)' },
  { match: /turns?[_-]?ratio|\bttr\b/i,  min: 0,    max: 1e4,  label: 'turns ratio' },
  { match: /power[_-]?factor|tan[_-]?delta|dissipation/i, min: -100, max: 100, label: 'power factor / tan-delta (%)' },
];

/**
 * Returns a human-readable reason string if the value looks like a unit/scale
 * error for its measurement type, or null if it is plausible (or the type is
 * unknown / the value is non-numeric).
 */
function checkMeasurementSanity(measurementType: any, value: any): string | null {
  if (value == null || value === '') return null;
  const v = Number(value);
  if (!isFinite(v)) return null;
  const t = String(measurementType || '');
  if (v < 0) {
    return `negative value (${v}) is physically implausible for ${t || 'this measurement'}`;
  }
  for (const b of BANDS) {
    if (b.match.test(t)) {
      if (v < b.min || v > b.max) {
        return `value ${v} is outside the plausible band for ${b.label} [${b.min}, ${b.max}] - possible unit/scale error`;
      }
      break;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 2 — pre-parse physical-plausibility gate (Finding[] pattern)
// ═══════════════════════════════════════════════════════════════════════════════

export type Severity = 'error' | 'warning';

export interface MeasurementFinding {
  measurementType: string;
  code:            string;
  severity:        Severity;
  message:         string;
  detail?:         string;
}

function numVal(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a voltage string that may include unit suffixes.
 * Handles: "480", "480V", "480 VAC", "4.16kV", "4160V", "13.8 kV"
 */
function parseVoltage(s: any): number | null {
  const str = String(s || '').trim();
  const isKv = /kv/i.test(str);
  // parseFloat handles leading minus signs and stops at trailing non-numeric chars
  // ("480V" → 480, "4.16kV" → 4.16, "-480" → -480).  Do NOT strip with /[^0-9.]/ first
  // — that removes the minus sign and turns negative values into positive ones.
  const raw = parseFloat(str);
  if (!Number.isFinite(raw)) return null;
  return isKv ? raw * 1000 : raw;
}

/**
 * Run physical-plausibility checks on a single extracted measurement row.
 * Pure; no I/O.  Returns Finding[] (empty = all clear).
 *
 * ERROR severity = physically impossible value (OCR / transcription artefact).
 * WARNING severity = extreme but theoretically possible; verify.
 *
 * Per-type bounds rationale:
 *   IR > 0 MΩ                   — zero/negative is impossible on a live meter
 *   PI 1.0–10.0                 — ratio t10/t1 IR; < 1 is a transcription error (IEEE 43)
 *   Contact resistance 0–10k µΩ — NETA ATS-2021 acceptance criterion for switchgear
 *   Power factor 0–100%         — dimensionless ratio; > 100 is impossible
 *   DGA 0–10,000 ppm            — > 10k ppm is above real saturation; digit duplication
 *   Test voltage > 0 and ≤ 50 kV — covers all field dielectric test equipment
 */
export function checkMeasurement(m: any): MeasurementFinding[] {
  const out: MeasurementFinding[] = [];
  const mType = String(m?.measurementType || '');
  const value = numVal(m?.asFoundValue);

  const add = (code: string, severity: Severity, message: string, detail?: string) =>
    out.push({ measurementType: mType, code, severity, message, detail });

  if (value != null) {
    switch (mType) {
      case 'insulation_resistance':
        if (value <= 0) {
          add('ir_not_positive', 'error',
            'Insulation resistance must be > 0 MΩ — a zero or negative reading is physically impossible.',
            `asFoundValue=${value} MΩ`);
        }
        break;

      case 'polarization_index':
        // PI = R(10 min) / R(1 min). The ratio cannot be < 1 on a resistive circuit;
        // values below 1.0 are an OCR artefact (IEEE 43-2013 §12 already catches
        // marginal values as RED via IEEE43_FLOORS; < 1.0 is strictly impossible).
        if (value < 1.0) {
          add('pi_below_minimum', 'error',
            'Polarization Index below 1.0 — physically impossible (PI = t10 IR / t1 IR cannot be < 1). Verify transcription.',
            `asFoundValue=${value}`);
        } else if (value > 10.0) {
          add('pi_above_maximum', 'warning',
            'Polarization Index exceeds 10.0 — verify transcription (extreme values are typically OCR artefacts).',
            `asFoundValue=${value}`);
        }
        break;

      case 'contact_resistance':
        // NETA ATS-2021 acceptance: ≤ 10,000 µΩ for switchgear contacts.
        // > 10k µΩ almost certainly means a unit confusion (mΩ entered as µΩ = 1000x).
        if (value < 0) {
          add('contact_resistance_negative', 'error',
            'Contact resistance cannot be negative.',
            `asFoundValue=${value} µΩ`);
        } else if (value > 10_000) {
          add('contact_resistance_excessive', 'error',
            'Contact resistance exceeds 10,000 µΩ — physically implausible for healthy switchgear contacts. Verify unit (mΩ vs µΩ) and transcription.',
            `asFoundValue=${value} µΩ`);
        }
        break;

      case 'power_factor':
        if (value < 0) {
          add('power_factor_negative', 'error',
            'Power factor cannot be negative.',
            `asFoundValue=${value}%`);
        } else if (value > 100) {
          add('power_factor_exceeds_100', 'error',
            'Power factor exceeds 100% — physically impossible.',
            `asFoundValue=${value}%`);
        }
        break;

      case 'dissolved_gas':
        if (value < 0) {
          add('dga_negative', 'error',
            'Dissolved gas concentration cannot be negative.',
            `asFoundValue=${value} ppm`);
        } else if (value > 10_000) {
          add('dga_excessive', 'error',
            'Dissolved gas concentration exceeds 10,000 ppm — likely a transcription or OCR error. Verify against the original lab report.',
            `asFoundValue=${value} ppm`);
        }
        break;

      default:
        break;
    }
  }

  // Test-voltage plausibility applies to any measurement that carries one.
  if (m?.testVoltage != null) {
    const tv = parseVoltage(m.testVoltage);
    if (tv != null) {
      if (tv <= 0) {
        add('test_voltage_not_positive', 'error',
          'Test voltage must be > 0 V.',
          `testVoltage="${m.testVoltage}"`);
      } else if (tv > 50_000) {
        add('test_voltage_excessive', 'error',
          'Test voltage exceeds 50 kV — outside the range of field dielectric test equipment used in substation maintenance.',
          `testVoltage="${m.testVoltage}"`);
      }
    }
  }

  return out;
}

/**
 * Run checkMeasurement across an array and return all findings.  Pure.
 */
export function checkMeasurements(measurements: any[]): MeasurementFinding[] {
  const all: MeasurementFinding[] = [];
  for (const m of measurements || []) all.push(...checkMeasurement(m));
  return all;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 3 — nameplate OCR confidence downgrades
// ═══════════════════════════════════════════════════════════════════════════════

// NEMA enclosure type numbers + IP-code pattern.
// NEMA: 1, 2, 3, 3R, 3S, 3X, 3RX, 3SX, 4, 4X, 5, 6, 6P, 12, 12K, 13
// IP: IP54, IP65, IP67, IP68, IP69K, etc.
// Optional "NEMA " prefix is accepted.
const ENCLOSURE_RE = /^(NEMA\s*)?(1|2|3(RX?|SX?|X)?|4X?|5|6P?|12K?|13|IP\d{2}[A-Z]{0,2})$/i;

/**
 * Deterministic nameplate confidence downgrades.  Extends the existing
 * serialNumber / year / phases inline checks in assetPhotoInspect.ts to cover
 * voltage, kva, amperage, and enclosureRating.
 *
 * Mutates `confidence` in-place (values: 'high' | 'medium' | 'low').
 *
 * Numeric bounds:
 *   voltage ≤ 1,500,000 V (1.5 MV) — highest transmission-class nameplate
 *   kva ≤ 5,000,000 kVA (5 GVA)    — largest power transformers in service
 *   amperage ≤ 100,000 A            — generous ceiling for large bus duct
 */
export function applyNameplateDowngrades(
  fields:     Record<string, any>,
  confidence: Record<string, string>,
): void {
  // ── existing checks (carried here so the full set is unit-testable in isolation) ──
  if (fields.serialNumber && !/\d/.test(String(fields.serialNumber))) {
    confidence.serialNumber = 'low';
  }
  if (fields.year != null && !(Number(fields.year) >= 1900 && Number(fields.year) <= 2100)) {
    confidence.year = 'low';
  }
  if (fields.phases != null && ![1, 3].includes(Number(fields.phases))) {
    confidence.phases = 'low';
  }

  // ── new checks ──

  // voltage: parse numeric portion; flag zero, negative, or absurd magnitudes
  // ("480 million" → 480,000,000 V).
  if (fields.voltage != null) {
    const v = parseVoltage(String(fields.voltage));
    if (v == null || v <= 0 || v > 1_500_000) {
      confidence.voltage = 'low';
    }
  }

  // kva: must be positive.  A non-finite or non-positive parse means a unit/digit error.
  if (fields.kva != null) {
    // parseFloat handles leading minus signs; do not strip with /[^0-9.]/ first.
    const k = parseFloat(String(fields.kva));
    if (!Number.isFinite(k) || k <= 0 || k > 5_000_000) {
      confidence.kva = 'low';
    }
  }

  // amperage: must be positive and plausible for a piece of named equipment.
  if (fields.amperage != null) {
    const a = parseFloat(String(fields.amperage));
    if (!Number.isFinite(a) || a <= 0 || a > 100_000) {
      confidence.amperage = 'low';
    }
  }

  // enclosureRating: must match a recognised NEMA enclosure type or IP code.
  // Free-form text ("weatherproof", "sealed", OCR garbage) flags as low.
  if (fields.enclosureRating != null) {
    if (!ENCLOSURE_RE.test(String(fields.enclosureRating).trim())) {
      confidence.enclosureRating = 'low';
    }
  }
}

// CommonJS export for require() callers (esbuild handles TS compilation).
module.exports = { checkMeasurementSanity, BANDS, checkMeasurement, checkMeasurements, applyNameplateDowngrades };

export {};
