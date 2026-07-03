/**
 * lib/testReportParse.ts — deterministic PowerDB/Megger/NETA test-report PDF
 * extraction (gem R1, the moat — "we read the report nobody reads and hand
 * back the to-do list").
 *
 * No AI: extract the PDF's text layer with pdfjs-dist, then pattern-match the
 * measurement rows against the known PowerDB form vocabulary
 * (docs/research/powerdb-templates/). Human-in-the-loop preview on the client
 * keeps extraction-accuracy risk contained — this returns best-effort rows the
 * user verifies before commit.
 *
 * Pure-ish: extractPdfText does IO (pdf parse); parseTestReport is pure string
 * work and unit-testable.
 */

'use strict';

// measurementType vocabulary: label → { type, unit, badDirection }
// badDirection: 'up' = higher is worse; 'down' = lower is worse.
const MEASUREMENT_VOCAB: any = {
  'insulation resistance': { type: 'insulation_resistance', unit: 'MΩ',  bad: 'down', critical: false },
  'polarization index':    { type: 'polarization_index',    unit: 'ratio', bad: 'down', critical: false },
  'dielectric absorption': { type: 'dielectric_absorption_ratio', unit: 'ratio', bad: 'down', critical: false },
  'contact resistance':    { type: 'contact_resistance',    unit: 'µΩ',  bad: 'up',   critical: true },
  'winding resistance':    { type: 'winding_resistance',    unit: 'mΩ',  bad: 'up',   critical: false },
  'power factor':          { type: 'power_factor',          unit: '%',   bad: 'up',   critical: false },
  'dissolved gas':         { type: 'dissolved_gas',         unit: 'ppm', bad: 'up',   critical: false },
  'turns ratio':           { type: 'turns_ratio_measured',  unit: 'ratio', bad: 'up', critical: false },
  'ground fault':          { type: 'ground_fault_pickup',   unit: 'A',   bad: 'up',   critical: true },
  'trip test':             { type: 'trip_time',             unit: 'sec', bad: 'up',   critical: true },
};
const LABELS = Object.keys(MEASUREMENT_VOCAB);

// Layer-2 physical-plausibility gate (see lib/measurementSanity.ts).
// Required at module level so esbuild tree-shakes it correctly.
const { checkMeasurement: _physCheck } = require('./measurementSanity');

/** Extract the concatenated text layer from a PDF buffer via pdfjs-dist. */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false });
  const pdf = await task.promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it: any) => it.str).join(' ') + '\n';
  }
  try { await pdf.cleanup(); } catch {}
  return text;
}

function firstMatch(re: RegExp, s: string): string | null {
  const m = s.match(re);
  return m ? m[1].trim() : null;
}

// [NETA-8-9] IEEE 43 absolute acceptance floors for rotating-machine / winding
// insulation diagnostics. These are PASS/FAIL minimums independent of any
// per-report "expected" string, so a report that omits the limit (or sets a lax
// one) still can't pass a wet/contaminated winding.
//   Polarization Index (IEEE 43-2013 §12): PI >= 2.0 acceptable; 1.0–2.0
//     questionable; < 1.0 indicates moisture/contamination (fail).
//   Dielectric Absorption Ratio: DAR >= 1.4 good; 1.25–1.4 questionable;
//     < 1.25 unsatisfactory.
const IEEE43_FLOORS: Record<string, { red: number; yellow: number }> = {
  polarization_index:         { red: 1.0,  yellow: 2.0 },
  dielectric_absorption_ratio:{ red: 1.25, yellow: 1.4 },
};

// Worst-of two verdicts (RED > YELLOW > GREEN). null is ignored.
function worstVerdict(a: any, b: any): 'GREEN' | 'YELLOW' | 'RED' | null {
  const rank: any = { GREEN: 0, YELLOW: 1, RED: 2 };
  const cands = [a, b].filter((v) => v === 'GREEN' || v === 'YELLOW' || v === 'RED');
  if (!cands.length) return null;
  return cands.reduce((w, v) => (rank[v] > rank[w] ? v : w));
}

/**
 * Evaluate pass/fail from an expected-range string + the measured value.
 * [NETA-8-13] When the caller supplies the measurement's `bad` direction, the
 * out-of-spec band (RED vs YELLOW) is computed in that DIRECTION rather than from
 * a symmetric unit-relative |value-thr|/thr ratio: an insulation-resistance
 * reading FAR ABOVE a ">=" floor is excellent (still GREEN), and a contact
 * resistance reading just over a "<=" cap on the bad side escalates correctly.
 * [NETA-8-9] When `measurementType` has an IEEE 43 floor, that absolute floor is
 * applied in ADDITION (worst-of), so it can only make the verdict worse.
 */
function evaluate(
  value: number | null,
  expected: string | null,
  opts?: { bad?: 'up' | 'down'; measurementType?: string },
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const bad = opts?.bad;
  const mType = opts?.measurementType;

  // IEEE 43 absolute floor (independent of the expected string).
  let floorVerdict: 'GREEN' | 'YELLOW' | 'RED' | null = null;
  if (value != null && mType && IEEE43_FLOORS[mType]) {
    const f = IEEE43_FLOORS[mType];
    floorVerdict = value < f.red ? 'RED' : value < f.yellow ? 'YELLOW' : 'GREEN';
  }

  let specVerdict: 'GREEN' | 'YELLOW' | 'RED' | null = null;
  if (value != null && expected) {
    const m = expected.match(/([<>]=?)\s*([\d.]+)/);
    if (m) {
      const op = m[1]; const thr = parseFloat(m[2]);
      if (!isNaN(thr)) {
        let pass: boolean | null = null;
        if (op === '>=' || op === '>') pass = op === '>=' ? value >= thr : value > thr;
        else if (op === '<=' || op === '<') pass = op === '<=' ? value <= thr : value < thr;
        if (pass === true) specVerdict = 'GREEN';
        else if (pass === false) {
          // How far out of spec, measured on the BAD side. If a direction is
          // known, only an excursion in that direction escalates to RED; an
          // excursion on the good side of a single-sided limit is at most YELLOW.
          const ratio = thr === 0 ? 1 : Math.abs(value - thr) / Math.abs(thr);
          const onBadSide =
            bad == null ? true
            : bad === 'up' ? value > thr
            : value < thr;
          specVerdict = (onBadSide && ratio > 0.25) ? 'RED' : 'YELLOW';
        }
      }
    }
  }

  return worstVerdict(specVerdict, floorVerdict);
}

/**
 * Parse extracted text into report metadata + measurement rows.
 * @returns { meta, measurements[], detectedLabels[] }
 */
function parseTestReport(rawText: string) {
  const text = rawText.replace(/\s+/g, ' ').trim();

  const meta = {
    serialNumber: firstMatch(/Serial(?:\s*Number)?\s*[:#]?\s*([A-Za-z0-9._-]+)/i, text),
    model:        firstMatch(/Model\s*[:#]?\s*([A-Za-z0-9._-]+)/i, text),
    manufacturer: firstMatch(/Manufacturer\s*[:#]?\s*([A-Za-z0-9._&-]+)/i, text),
    testDate:     firstMatch(/Test\s*Date\s*[:#]?\s*(\d{4}-\d{2}-\d{2})/i, text),
    vendor:       firstMatch(/Vendor\s*[:#]?\s*([A-Za-z0-9 .&-]+?)(?:\s{2,}|\sTechnician|\sTech\b|$)/i, text),
    techName:     firstMatch(/Techn?icians?\s*[:#]?\s*([A-Za-z0-9 .]+?)(?:\s{2,}|$)/i, text),
  };

  // Locate each measurement label occurrence, slice the segment to the next
  // label (or 80 chars), and parse phase / value / unit / expected / result.
  const lower = text.toLowerCase();
  const hits: { idx: number, label: string }[] = [];
  for (const label of LABELS) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(label, from);
      if (idx === -1) break;
      hits.push({ idx, label });
      from = idx + label.length;
    }
  }
  hits.sort((a, b) => a.idx - b.idx);

  const measurements: any[] = [];
  for (let h = 0; h < hits.length; h++) {
    const { idx, label } = hits[h];
    const end = h + 1 < hits.length ? hits[h + 1].idx : Math.min(text.length, idx + 90);
    const seg = text.slice(idx, end);
    const vocab = MEASUREMENT_VOCAB[label];

    const phase    = firstMatch(/\bPh(?:ase)?\.?\s*([ABCN](?:-[ABCN])?)/i, seg);
    let unit       = firstMatch(/[\d.]+\s*(MΩ|Mohm|kΩ|Ω|µΩ|uOhm|mΩ|ppm|%|VDC|kV|A|sec|ratio)/i, seg);
    if (unit) unit = unit.replace(/mohm/i, 'MΩ').replace(/uohm/i, 'µΩ');
    const expected = firstMatch(/Expected\s*([<>]=?\s*[\d.]+\s*[A-Za-zµΩ%]*)/i, seg);
    const testV    = firstMatch(/Test\s*Voltage\s*([\d.]+\s*[kV]*V?DC?)/i, seg);

    // [NETA-8-5] Anchor the reading to the MEASUREMENT, not the applied test
    // voltage. The old "first number after the label" grabbed the test voltage on
    // forms laid out "<label> Test Voltage 500 VDC ... 1250 MΩ", fabricating a 500
    // reading. Strategy: (1) drop the label, (2) excise the "Test Voltage NNNN"
    // and "Expected <op> NNNN" clauses so their numbers can't win, then (3) prefer
    // a number bound to a measurement unit; else fall back to the first remaining
    // number. The reading's own unit (e.g. VDC for a hipot) is still allowed via
    // the vocab unit, but the test-voltage clause is removed before the search.
    let valueScope = seg.replace(label, '');
    valueScope = valueScope
      .replace(/Test\s*Voltage\s*[\d.]+\s*k?V?DC?/ig, ' ')
      .replace(/Expected\s*[<>]=?\s*[\d.]+\s*[A-Za-zµΩ%]*/ig, ' ');
    // Prefer "<number><unit>" so the reading (which carries the measurement unit)
    // wins over a bare number elsewhere in the row.
    const valueStr = firstMatch(/([\d]+(?:\.\d+)?)\s*(?:MΩ|Mohm|kΩ|Ω|µΩ|uOhm|mΩ|ppm|%|kV|VDC|A|sec|ratio)\b/i, valueScope)
      ?? firstMatch(/\b([\d]+(?:\.\d+)?)\b/, valueScope);
    const value    = valueStr != null ? parseFloat(valueStr) : null;
    let result: any = firstMatch(/Result\s*(GREEN|YELLOW|RED)/i, seg);
    if (result) result = result.toUpperCase();
    else result = evaluate(value, expected, { bad: vocab.bad, measurementType: vocab.type });

    // Skip phantom matches (e.g. a section header that names a measurement type
    // but carries no reading): a real row has at least a value or a verdict.
    if (value == null && result == null) continue;

    measurements.push({
      measurementType: vocab.type,
      label: label.replace(/\b\w/g, c => c.toUpperCase()),
      phase: phase ? phase.toUpperCase() : null,
      asFoundValue: value,
      asFoundUnit: unit || vocab.unit,
      expectedRange: expected,
      testVoltage: testV,
      passFail: result,        // GREEN | YELLOW | RED | null
      critical: vocab.critical,
    });
  }

  // Physical-plausibility gate — runs AFTER the full measurements array is built,
  // BEFORE returning to the caller.  ERROR-severity findings force passFail to RED
  // so evaluateUnit() in ingestConfidenceGate.ts routes the whole unit to the
  // Review Queue (same path as a low-confidence match — see evaluateUnit line ~98).
  // A sanityNote field is added for the review UI to surface the reason.
  for (const m of measurements) {
    const errors = (_physCheck(m) as any[]).filter((f: any) => f.severity === 'error');
    if (errors.length > 0) {
      m.passFail  = 'RED';
      m.sanityNote = errors.map((f: any) => f.message).join('; ');
    }
  }

  return { meta, measurements, detectedLabels: [...new Set(hits.map(h => h.label))] };
}

/** Map a measurement verdict to a deficiency severity (null = no deficiency). */
function severityFor(passFail: string | null, critical: boolean): 'IMMEDIATE' | 'RECOMMENDED' | 'ADVISORY' | null {
  if (passFail === 'RED')    return critical ? 'IMMEDIATE' : 'RECOMMENDED';
  if (passFail === 'YELLOW') return 'ADVISORY';
  return null;
}

module.exports = { extractPdfText, parseTestReport, evaluate, severityFor, MEASUREMENT_VOCAB };
export {};
