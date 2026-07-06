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

// IEC 60076 preferred sizes (dry + oil-filled transformers built to the IEC
// ladder rather than the ANSI/IEEE ladder). Real plates in the field carry
// these ratings — a validator that only knows the IEEE ladder false-flags every
// import. Sources: IEC 60076-1 Table 4 (preferred rated powers), Schneider
// Trihal / MTZ series catalogs. Added 2026-07-04 after the ~50% FP rate on the
// live 36-image run.
export const STD_KVA_IEC = [
  25, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 630, 800, 1250, 1600,
  2500, 3150, 4000, 6300, 8000,
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
 * "4.16kV-480"    → [4160, 480]
 * "13.8kV"        → [13800]
 *
 * [W8-nameplate, 2026-07-05] A component only scales ×1000 when IT ITSELF
 * is followed by "kV" — never inferred from another component in the same
 * string. The previous implementation used ONE whole-string kV flag for
 * EVERY component, so "13.8kV/480V" (a real HV-primary/LV-secondary label)
 * silently produced [13800, 480000] instead of the documented [13800, 480]
 * — the LV secondary read 1000x high and fed straight into every downstream
 * consistency check (V3 voltage-class, V4 the VA-relationship equation).
 *
 * This deliberately does NOT infer kV for a bare (unit-less) component from
 * a LATER kV suffix (e.g. a same-side multi-tap label like "13.8/12.47kV"
 * would under-scale the first number to 13.8) — that convention is rarer,
 * and a bare low value like 13.8 still gets caught by V3's standard-voltage-
 * class check downstream. Silently OVER-scaling a legitimate explicit "V"
 * component is the worse failure mode (a wrong value with no signal at all),
 * so the conservative per-component-only rule is the safer default.
 */
export function parseVoltageComponents(s: any): number[] {
  const str = String(s ?? '').trim();
  if (!str) return [];
  // Capture each number plus its immediately-following run of non-digit
  // characters (its "unit tail") BEFORE that tail is discarded as a delimiter.
  const tokenRe = /(\d+(?:\.\d+)?)([^\d]*)/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(str)) !== null) {
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const tail = m[2] || '';
    out.push(/kv/i.test(tail) ? n * 1000 : n);
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

/**
 * Soft downgrade — 'high' → 'medium', 'medium' stays, 'low' stays. Used for
 * "the value is plausible in isolation but its source snippet doesn't confirm
 * it" and "off-ladder kVA that might be a legitimate specialty size" — signals
 * that suggest a second look but are not the hard cross-field-mismatch class.
 *
 * Recorded policy (2026-07-04 calibration): the hard `downgrade` to 'low' is
 * reserved for a confirmed cross-field mismatch (kVA snippet contains a Hz
 * label, kva == frequency value duplicate, √3·V·A/1000 vs kVA off by >20%,
 * frequency not in {50, 60}). Everything else uses this softer path so the
 * review queue stays scannable.
 */
function softDowngrade(confidence: Record<string, string>, field: string): void {
  const cur = confidence[field];
  if (cur === 'high') confidence[field] = 'medium';
  // 'medium' and 'low' remain unchanged
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
  // Accepts IEEE C57.12 (1φ + 3φ) AND IEC 60076 preferred sizes. Real plates
  // built to the IEC ladder (63/80/160/630/1250/…) would false-flag against
  // ANSI-only, so the IEC set was added 2026-07-04 after live traffic showed
  // FPs on legitimate specialty ratings.
  //
  // Uses softDowngrade (medium, not low): even a genuine off-ladder plate is
  // a soft signal — plenty of legitimate specialty ratings exist. The hard
  // catches for the kVA class are V1 (duplicate w/ frequency) and V4 (physics
  // violation vs V·A) which stay on downgrade → low.
  if (kvaNum != null && kvaNum > 0) {
    let onSomeLadder = false;
    if (phasesN === 1) {
      onSomeLadder = onLadder(kvaNum, STD_KVA_1PH) || onLadder(kvaNum, STD_KVA_IEC);
    } else if (phasesN === 3) {
      onSomeLadder = onLadder(kvaNum, STD_KVA_3PH) || onLadder(kvaNum, STD_KVA_IEC);
    } else {
      // Phases unknown — accept membership in ANY ladder.
      onSomeLadder = onLadder(kvaNum, STD_KVA_1PH)
                  || onLadder(kvaNum, STD_KVA_3PH)
                  || onLadder(kvaNum, STD_KVA_IEC);
    }
    if (!onSomeLadder) {
      softDowngrade(confidence, 'kva');
      out.push({
        field:   'kva',
        code:    'kva_not_standard_size',
        message: `kVA ${kvaNum} is not on the IEEE C57.12 or IEC 60076 standard-size ladder — verify (specialty sizes exist; confirm the plate)`,
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
  //
  // Uses softDowngrade (medium, not low): many manufacturers legitimately
  // encode the manufacture year in the serial number ("SN-2015-1234-XYZ" is
  // real). Flag for a look, don't force review — the FP rate on the live
  // 36-image run made this the second-largest source of noise after V7.
  if (yearNum != null && yearNum >= 1900 && yearNum <= 2100) {
    const yearStr = String(Math.trunc(yearNum));
    const serial = String(fields.serialNumber ?? '');
    const model  = String(fields.model ?? '');
    const inSerial = serial.length > 0 && serial.includes(yearStr) && serial !== yearStr;
    const inModel  = model.length > 0  && model.includes(yearStr)  && model !== yearStr;
    if (inSerial || inModel) {
      softDowngrade(confidence, 'year');
      out.push({
        field:   'year',
        code:    'year_may_be_model_fragment',
        message: `Year ${yearStr} appears inside the ${inSerial ? 'serial number' : 'model'} — verify (some manufacturers encode the year in the serial)`,
      });
    }
  }

  return out;
}

/**
 * V7 — Evidence-string check (2026-07-04 calibrated).
 *
 * Requires the model to have returned, per field, the verbatim nameplate
 * snippet it read the value from (see the ocrNameplateWithEvidence contract
 * in routes/assetPhotoInspect.ts). Three-way outcome:
 *
 *   (a) POSITIVE match — the snippet mentions THIS field's unit family
 *       (broad synonym set below). PASS. No downgrade.
 *   (b) FOREIGN match — the snippet mentions ONLY another field's unit
 *       family (kVA field with a "60 Hz" snippet — the s03 / s36 case).
 *       Hard downgrade to 'low' with 'evidence_label_mismatch'. This is
 *       THE catch the layer exists for; must survive every calibration.
 *   (c) NEITHER — the snippet has no recognized unit token. SOFT downgrade
 *       to 'medium' with 'no_unit_in_evidence'. Reasonable snippets like
 *       "480 V AC 3PH 60Hz" match the positive; snippets that pulled just
 *       the value ("60") get a soft "verify" not a hard flag.
 *
 * Missing evidence for a value → SOFT downgrade to 'medium' + 'no_evidence'.
 * Absence of evidence is weaker than contradiction (unchanged from prior).
 *
 * WHY the vocabulary was broadened (2026-07-04): a live 36-image run flagged
 * ~50% of successful reads because the accepted set was too narrow —
 * "60 CYCLES" (legacy Hz), "480 VAC" (glued), "9.3 AMPS", "AMPERES", "KV-A"
 * all failed the old strict-boundary regexes. The new vocabulary accepts
 * every real-plate variant Dustin catalogued while keeping cross-family
 * exclusion strict (a "60 Hz" snippet still cannot pass for kVA).
 *
 * If the caller has no evidence map (older client / model regressed), the
 * validator no-ops.
 */

// Positive vocabulary per field. Case-insensitive. Handles glued forms
// (480VAC, 9.3AMPS, 60CYCLES) via the (?<![A-Za-z]) lookbehind — a letter
// before the unit rejects (SERVICE, IMPACT), a digit or start-of-string
// accepts. Right-side lookaheads keep VAC from being read as V+AC bleed and
// KVAR from matching KVA.
//
// Each regex is documented with the tokens it accepts. Case-insensitive
// throughout (/i), so KVA and kVA and kva all pass on every entry.
const UNIT_POSITIVE: Record<string, RegExp> = {
  // KVA family: KVA, KV-A, KV A, KVA., MVA, KILOVOLT-AMP(ERE)(S), MEGAVOLT-AMP
  // Negative lookahead (?![RC]) rejects KVAR (reactive volt-amperes; a
  // separate quantity on some plates) and KVAC (rare instrument shorthand).
  kva:       /(?<![A-Za-z])(?:K\s*V[\s\-.]?A(?![RC])|M\s*V\s*A|KILO[\s\-.]?VOLT[\s\-.]?AMP(?:ERES?|S)?|MEGA[\s\-.]?VOLT[\s\-.]?AMP(?:ERES?|S)?)(?![A-Za-z])/i,

  // Voltage: V, VOLT, VOLTS, VOLTAGE, VAC, VDC, KV, KILOVOLT(S).
  // "KV" is voltage; "KVA" is the kVA family — the negative lookahead
  // (?![\s\-.]?A) on KV rejects KV-A and KV.A and "KV A". Same treatment on
  // KILOVOLT so "KILOVOLT-AMP" doesn't false-positive here.
  voltage:   /(?<![A-Za-z])(?:V(?:OLT(?:AGE|S)?|AC|DC)?|K\s*V(?![\s\-.]?A)|KILO[\s\-.]?VOLTS?(?![\s\-.]?AMP))(?![A-Za-z])/i,

  // Amperage: A, AMP, AMPS, AMPERE, AMPERES, MA, MILLIAMP(ERE)(S).
  amperage:  /(?<![A-Za-z])(?:A(?:MP(?:ERES?|S)?)?|M\s*A|MILLI[\s\-.]?AMP(?:ERES?|S)?)(?![A-Za-z])/i,

  // Frequency: Hz, HZ, HERTZ, CYCLE, CYCLES, CYCLE/SEC, CPS, C/S, ~ (used on
  // old European plates for AC). "HRZ" / "HRTZ" tolerated for OCR noise.
  // NOTE: standalone HZ needs its own alternative — "H[EA]?RT?Z" requires the
  // R, which "Hz" doesn't have. Missing this broke the s03 hard-catch (kva
  // snippet of "60 Hz" wasn't recognized as frequency).
  frequency: /(?<![A-Za-z])(?:HZ|H[EA]?RT?Z|HERTZ|CYCLES?(?:\/SEC)?|CPS|C\/S)(?![A-Za-z])|(?<=\d\s?)~/i,

  // Year: a plausible 4-digit manufacture year (19xx or 20xx). Purely a
  // "the snippet contains SOMETHING year-shaped" check; V6 in
  // checkNameplateConsistency handles the year-in-serial catch separately.
  year:      /(?<!\d)(?:19|20)\d{2}(?!\d)/,
};

/**
 * Detect which unit families the snippet mentions. A snippet like
 * "480V 3PH 60Hz" mentions both voltage and frequency — that's fine for
 * either field's snippet, because a positive match on the field's OWN
 * family is all that's required (a legit source snippet often contains the
 * whole nameplate line).
 */
function detectFamilies(snippet: string): Set<string> {
  const fams = new Set<string>();
  for (const [field, re] of Object.entries(UNIT_POSITIVE)) {
    if (re.test(snippet)) fams.add(field);
  }
  return fams;
}

export function checkNameplateEvidence(
  fields:     Record<string, any>,
  confidence: Record<string, string>,
  evidence:   Record<string, string> | null | undefined,
): NameplateFinding[] {
  const out: NameplateFinding[] = [];
  if (!evidence || typeof evidence !== 'object') return out;

  const CHECKED = ['kva', 'voltage', 'amperage', 'frequency', 'year'];

  for (const field of CHECKED) {
    const value = fields[field];
    if (value == null || value === '') continue;
    const snippet = evidence[field];

    // ── Case 1: no snippet at all — SOFT downgrade to medium ──────────────
    if (snippet == null || String(snippet).trim() === '') {
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
    const fams = detectFamilies(snip);

    // ── Case 2: positive match — snippet contains THIS field's unit ───────
    if (fams.has(field)) continue; // PASS — no finding, no downgrade

    // ── Case 3: foreign match — snippet contains ONLY another field's unit
    //           (kVA snippet says "60 Hz" — the s03/s36 case). HARD 'low'. ─
    const foreignFams = [...fams].filter((f) => f !== field);
    if (foreignFams.length > 0) {
      downgrade(confidence, field);
      out.push({
        field,
        code:    'evidence_label_mismatch',
        message: `Source snippet for ${field} contains a ${foreignFams.join('/')} unit rather than the expected ${field} label — likely read from the wrong line`,
      });
      continue;
    }

    // ── Case 4: no recognized unit token — SOFT downgrade to medium ───────
    // The snippet is present but doesn't mention any known unit family. That
    // is a soft "verify" (the snippet is thin, not contradictory).
    if (confidence[field] === 'high') {
      confidence[field] = 'medium';
      out.push({
        field,
        code:    'no_unit_in_evidence',
        message: `Source snippet for ${field} contains no recognized unit token — verify`,
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
  STD_KVA_IEC,
  STD_VOLTAGES,
  STD_FREQ,
  UNIT_POSITIVE,
  parseVoltageComponents,
  checkNameplateConsistency,
  checkNameplateEvidence,
};

export {};
