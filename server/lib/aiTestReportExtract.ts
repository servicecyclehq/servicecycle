/**
 * lib/aiTestReportExtract.ts — AI gap-fill for test-report ingest (W1-AI).
 *
 * Deterministic-FIRST by design. The pdfplumber engine (lib/testReportExtract)
 * + OCR remain the primary path; this module is only invoked by
 * routes/testReportImport when that pass comes back low-coverage (few readings
 * or a total fall-through to the pdfjs text parser). It asks the configured
 * LLM (default: Google Gemini free-tier cascade — see lib/ai.ts) to pull the
 * quantitative readings the regex/geometry passes missed, returns them in the
 * SAME measurement shape the route already commits, and the caller merges only
 * the net-new rows. Every failure path returns { ok:false, measurements:[] }
 * so a flaky/absent model can never break ingest — the deterministic result
 * stands on its own.
 *
 * Privacy: free-tier model endpoints may retain prompts for training, so
 * scrubForAi() strips emails + phone numbers before the report text is sent.
 * The technical body (equipment type, ratings, readings) is the payload we
 * WANT extracted and is preserved. Operators who need a no-retention guarantee
 * should move AI_PROVIDER to a paid tier / Azure tenant — the call path is
 * identical (lib/ai.ts resolves provider from env).
 */

'use strict';

const ai = require('./ai');

// Canonical measurementType vocabulary — kept aligned with the deficiency
// engine in routes/testReportImport (severityFor + the W4 BAD_DIRECTION trend
// map) and the Python field library, so an AI-added RED critical reading still
// generates the right deficiency on commit. The model may also return a short
// snake_case label for anything outside this list (treated as generic).
const KNOWN_TYPES = [
  'insulation_resistance', 'polarization_index', 'dielectric_absorption_ratio',
  'contact_resistance', 'winding_resistance', 'power_factor', 'dissipation_factor',
  'dissolved_gas', 'turns_ratio_measured', 'excitation_current', 'ground_resistance',
  'ground_fault_pickup', 'trip_time', 'pickup_current', 'primary_injection',
  'secondary_injection', 'megger', 'hipot', 'temperature_rise',
];

const CRITICAL_TYPES = new Set([
  'contact_resistance', 'ground_fault_pickup', 'trip_time', 'pickup_current',
  'primary_injection', 'secondary_injection',
]);

/**
 * Strip the two PII classes most likely to ride along in a report header
 * (technician/customer emails, phone numbers) before sending to a free-tier
 * model. Deliberately light — serial numbers, ratings, and readings stay,
 * because those are the extraction target.
 */
function scrubForAi(text: string): string {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]');
}

const SYSTEM = [
  'You extract quantitative electrical test readings from NETA / PowerDB / Megger / Doble',
  'acceptance and maintenance test reports. You are a fallback for a deterministic parser',
  'that already ran — your job is to recover readings it missed.',
  '',
  'Return ONLY a JSON array (no prose, no markdown fences). Each element:',
  '{',
  '  "measurementType": one of [' + KNOWN_TYPES.join(', ') + '] when it clearly matches,',
  '                     otherwise a short lower_snake_case label,',
  '  "label": the human label exactly as printed on the report,',
  '  "phase": "A" | "B" | "C" | "A-B" | "B-C" | "C-A" | "N" | null,',
  '  "asFoundValue": the measured number ONLY (strip units, commas, ranges) or null,',
  '  "asFoundUnit": e.g. "MΩ" "µΩ" "mΩ" "%" "ppm" "ratio" "V" "A" "sec" or null,',
  '  "expectedRange": e.g. ">=1000 MΩ" or "<=500 µΩ" or null,',
  '  "testVoltage": e.g. "1000VDC" "10kV" or null,',
  '  "kind": "D" for a diagnostic test reading, "R" for nameplate/reference data,',
  '  "critical": true only for safety-critical protective readings (trip time,',
  '              ground-fault pickup, contact resistance)',
  '}',
  '',
  'Rules: NEVER invent a reading — only report values printed in the text. Put exactly one',
  'number in asFoundValue. If a row has no numeric value and no expected range, skip it.',
  'If you find no readings at all, return [].',
].join('\n');

const MAX_INPUT_CHARS = 24000; // ~6-7k tokens of report text; plenty for the body

/**
 * Ask the LLM to recover readings from report text.
 * @returns { ok:boolean, measurements: any[] } — never throws.
 */
async function aiFillReadings(rawText: string, opts: any = {}) {
  const maxTokens = opts.maxTokens || 3072;
  if (process.env.AI_ENABLED === 'false') return { ok: false, measurements: [] };
  if (!rawText || rawText.trim().length < 60) return { ok: false, measurements: [] };

  const user = 'TEST REPORT TEXT:\n' + scrubForAi(rawText).slice(0, MAX_INPUT_CHARS);

  let resp: any;
  try {
    resp = await ai.complete({ system: SYSTEM, user, maxTokens, task: 'extract' });
  } catch (e: any) {
    console.warn('[aiTestReport] model call failed:', e && e.message ? e.message.slice(0, 200) : String(e));
    return { ok: false, measurements: [] };
  }

  let arr: any;
  try {
    arr = ai.parseJSON(resp && resp.text ? resp.text : '', 'ai');
  } catch (e: any) {
    console.warn('[aiTestReport] non-JSON response:', e && e.message ? e.message.slice(0, 160) : String(e));
    return { ok: false, measurements: [] };
  }
  if (!Array.isArray(arr)) return { ok: false, measurements: [] };

  const out: any[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const rawVal = x.asFoundValue;
    const num = (rawVal === null || rawVal === undefined || rawVal === '')
      ? null : Number(String(rawVal).replace(/[, ]/g, ''));
    const type = String(x.measurementType || 'measurement').trim().toLowerCase().slice(0, 60).replace(/\s+/g, '_');
    const critical = x.critical === true || CRITICAL_TYPES.has(type);
    const m = {
      measurementType: type,
      label: x.label ? String(x.label).slice(0, 120) : type,
      phase: x.phase ? String(x.phase).toUpperCase().slice(0, 5) : null,
      asFoundValue: (num != null && !Number.isNaN(num)) ? num : null,
      asFoundUnit: x.asFoundUnit ? String(x.asFoundUnit).slice(0, 12) : null,
      expectedRange: x.expectedRange ? String(x.expectedRange).slice(0, 60) : null,
      testVoltage: x.testVoltage ? String(x.testVoltage).slice(0, 20) : null,
      passFail: null,
      critical,
      kind: x.kind === 'R' ? 'R' : 'D',
      source: 'ai',
      confidence: 'ai',
    };
    // Drop pure noise: a row with neither a value nor an expected range.
    if (m.asFoundValue == null && !m.expectedRange) continue;
    out.push(m);
  }

  return { ok: true, measurements: out };
}

module.exports = { aiFillReadings, scrubForAi, KNOWN_TYPES };
export {};
