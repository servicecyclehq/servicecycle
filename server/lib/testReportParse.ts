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

/** Evaluate pass/fail from an expected-range string + the measured value. */
function evaluate(value: number | null, expected: string | null): 'GREEN' | 'YELLOW' | 'RED' | null {
  if (value == null || !expected) return null;
  const m = expected.match(/([<>]=?)\s*([\d.]+)/);
  if (!m) return null;
  const op = m[1]; const thr = parseFloat(m[2]);
  if (isNaN(thr)) return null;
  let pass: boolean;
  if (op === '>=' || op === '>') pass = op === '>=' ? value >= thr : value > thr;
  else if (op === '<=' || op === '<') pass = op === '<=' ? value <= thr : value < thr;
  else return null;
  if (pass) return 'GREEN';
  // how far out of spec → RED if badly out (>25%), else YELLOW
  const ratio = thr === 0 ? 1 : Math.abs(value - thr) / thr;
  return ratio > 0.25 ? 'RED' : 'YELLOW';
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
    const valueStr = firstMatch(/\b([\d]+(?:\.\d+)?)\b/, seg.replace(label, '')); // first number after the label
    const value    = valueStr != null ? parseFloat(valueStr) : null;
    let unit       = firstMatch(/[\d.]+\s*(MΩ|Mohm|kΩ|Ω|µΩ|uOhm|mΩ|ppm|%|VDC|kV|A|sec|ratio)/i, seg);
    if (unit) unit = unit.replace(/mohm/i, 'MΩ').replace(/uohm/i, 'µΩ');
    const expected = firstMatch(/Expected\s*([<>]=?\s*[\d.]+\s*[A-Za-zµΩ%]*)/i, seg);
    const testV    = firstMatch(/Test\s*Voltage\s*([\d.]+\s*[kV]*V?DC?)/i, seg);
    let result: any = firstMatch(/Result\s*(GREEN|YELLOW|RED)/i, seg);
    if (result) result = result.toUpperCase();
    else result = evaluate(value, expected);

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
