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
  'You extract data from NETA / PowerDB / Megger / Doble electrical acceptance and',
  'maintenance test reports. You are a fallback for a deterministic parser that already',
  'ran — recover the header fields and readings it missed.',
  '',
  'Return ONLY a JSON object (no prose, no markdown fences):',
  '{',
  '  "fields": {',
  '    "serialNumber": str|null, "manufacturer": str|null, "model": str|null,',
  '    "testDate": "YYYY-MM-DD"|null, "vendor": str|null, "techName": str|null',
  '  },',
  '  "measurements": [ {',
  '    "measurementType": one of [' + KNOWN_TYPES.join(', ') + '] when it clearly matches,',
  '                       otherwise a short lower_snake_case label,',
  '    "label": the human label exactly as printed,',
  '    "phase": "A" | "B" | "C" | "A-B" | "B-C" | "C-A" | "N" | null,',
  '    "asFoundValue": the measured number ONLY (strip units, commas, ranges) or null,',
  '    "asFoundUnit": preserve the EXACT unit as printed — mΩ (milliohm), MΩ (megohm)',
  '                   and µΩ (microohm) are DIFFERENT units; never change the prefix case,',
  '    "result": "pass" | "fail" | "green" | "yellow" | "red" | null (the printed result),',
  '    "expectedRange": e.g. ">=1000 MΩ" or "<=500 µΩ" or null,',
  '    "testVoltage": e.g. "1000VDC" or null,',
  '    "kind": "D" diagnostic | "R" reference/nameplate,',
  '    "critical": true only for safety-critical protective readings',
  '  } ]',
  '}',
  '',
  'Rules: NEVER invent data — only report what is present. Put exactly one number in',
  'asFoundValue. Skip a reading row with no numeric value and no expected range. Unknown',
  'fields = null. If you find nothing, return {"fields":{},"measurements":[]}.',
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

  // One text attempt: call -> parse -> coerce. Returns null on call/parse
  // failure. `settings` lets us force a provider on the retry.
  const attempt = async (settings: any, tag: string) => {
    let resp: any;
    try {
      resp = await ai.complete({ system: SYSTEM, user, maxTokens, task: 'extract', settings });
    } catch (e: any) {
      console.warn(`[aiTestReport] model call failed (${tag}):`, e && e.message ? e.message.slice(0, 200) : String(e));
      return null;
    }
    try {
      return _coerceResult(ai.parseJSON(resp && resp.text ? resp.text : '', 'ai'));
    } catch (e: any) {
      console.warn(`[aiTestReport] non-JSON response (${tag}):`, e && e.message ? e.message.slice(0, 160) : String(e));
      return null;
    }
  };

  let c = await attempt({}, 'primary');
  // Retry on Groq if the primary failed OR succeeded-but-empty (a quota-throttled
  // Gemini alias that answers with nothing no longer sinks the gap-fill).
  const primary = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!_hasContent(c) && process.env.GROQ_API_KEY && primary !== 'groq') {
    console.warn('[aiTestReport] text: primary returned nothing → retrying on groq');
    const c2 = await attempt({ provider: 'groq' }, 'groq');
    if (_hasContent(c2)) c = c2;
  }
  if (!c) return { ok: false, measurements: [] };
  return { ok: true, measurements: _mapMeasurements(c.measurements), fields: _mapFields(c.fields) };
}

// Accept either the new {fields, measurements} object OR a bare measurements
// array (back-compat with the older prompt / lenient models).
function _coerceResult(j: any) {
  if (Array.isArray(j)) return { fields: {}, measurements: j };
  if (j && typeof j === 'object') return { fields: j.fields || {}, measurements: Array.isArray(j.measurements) ? j.measurements : [] };
  return { fields: {}, measurements: [] };
}

// Did a coerced {fields, measurements} actually recover anything? A primary
// model that "succeeds" with an empty array/object (e.g. a quota-throttled
// Gemini alias model that answers but finds nothing) is useless — callers use
// this to decide whether to retry on Groq.
function _hasContent(c: any) {
  if (!c) return false;
  // Count MAPPED measurements: a model can answer with rows that are all noise
  // (no value, no range) which _mapMeasurements drops — that's "empty" for our
  // purposes and should still trigger the Groq retry.
  if (Array.isArray(c.measurements) && _mapMeasurements(c.measurements).length) return true;
  const f = _mapFields(c.fields);
  return Object.values(f).some((v) => v != null);
}

// Shared mapping from the model's loose JSON array to our measurement shape.
// Used by both the text gap-fill and the vision fallback.
function _mapMeasurements(arr: any[]) {
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
      asFoundUnit: _normUnit(x.asFoundUnit),
      expectedRange: x.expectedRange ? String(x.expectedRange).slice(0, 60) : null,
      testVoltage: x.testVoltage ? String(x.testVoltage).slice(0, 20) : null,
      passFail: _mapResult(x.result != null ? x.result : x.passFail),
      critical,
      kind: x.kind === 'R' ? 'R' : 'D',
      source: 'ai',
      confidence: 'ai',
    };
    // Drop pure noise: a row with neither a value nor an expected range.
    if (m.asFoundValue == null && !m.expectedRange) continue;
    out.push(m);
  }
  return out;
}

// Header fields recovered by the AI/vision path -> our meta shape.
function _mapFields(f: any) {
  f = f || {};
  const s = (v: any) => (v == null || v === '' ? null : String(v).slice(0, 120));
  return {
    serialNumber: s(f.serialNumber), manufacturer: s(f.manufacturer), model: s(f.model),
    testDate: s(f.testDate), vendor: s(f.vendor), techName: s(f.techName),
  };
}

// Map a printed result token to our GREEN/YELLOW/RED rating (or null).
function _mapResult(v: any) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['green', 'pass', 'passed', 'ok', 'good', 'satisfactory', 'accept', 'acceptable'].includes(s)) return 'GREEN';
  if (['red', 'fail', 'failed', 'reject', 'rejected', 'unacceptable', 'defective'].includes(s)) return 'RED';
  if (['yellow', 'marginal', 'warn', 'warning', 'caution', 'monitor', 'investigate'].includes(s)) return 'YELLOW';
  return null;
}

// Light unit normalizer mirroring pyextract/neta_field_library: keeps milli (mΩ)
// vs mega (MΩ) vs micro (µΩ) distinct (case-sensitive milli) and collapses spelled
// variants, so AI/vision units line up with the deterministic parser's output.
function _normUnit(u: any) {
  if (u == null || u === '') return null;
  const s = String(u).trim().slice(0, 12);
  const OHM = 'Ω', MU = 'µ';
  if (/^(milliohm|m\s?ohm|mohm|mΩ)$/.test(s)) return 'm' + OHM;       // case-sensitive lowercase m = milli
  if (/^(m\s?ohm|mohm|mΩ|megohm|meg)$/i.test(s)) return 'M' + OHM;    // mega (capital M / words)
  if (/^(u\s?ohm|uohm|uΩ|µΩ|micro)$/i.test(s)) return MU + OHM;
  if (/^(k\s?ohm|kohm|kΩ)$/i.test(s)) return 'k' + OHM;
  if (/^(ohm|Ω)$/i.test(s)) return OHM;
  return s;
}

// Vision fallback: send the report IMAGE to the multimodal model. Used when the
// deterministic parser + OCR + text gap-fill all come back low-coverage, which
// happens on photos/scans whose OCR text is too poor for the text path. The
// vision providers have no separate system turn, so the extraction rules are
// prepended to the prompt. Reuses the same provider cascade (Gemini/Groq/...)
// as the nameplate photo-inspect feature. Never throws.
const VISION_PROMPT = SYSTEM +
  '\n\nThe input is an IMAGE of an electrical test report (a scan or phone photo). ' +
  'Read every quantitative reading visible in the image and return the JSON array described above.';

async function aiFillReadingsFromImage(imageBuffer: Buffer, opts: any = {}) {
  if (process.env.AI_ENABLED === 'false') return { ok: false, measurements: [] };
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) return { ok: false, measurements: [] };
  let processed: Buffer;
  try {
    const sharp = require('sharp');
    processed = await sharp(imageBuffer).rotate()
      .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer();
  } catch (e: any) {
    console.warn('[aiTestReport] image preprocess failed:', e && e.message ? e.message.slice(0, 160) : String(e));
    return { ok: false, measurements: [] };
  }
  // One vision attempt: call -> parse. Returns the parsed JSON or null on any
  // failure (call error OR unparseable body). `settings` lets us force a
  // specific provider on the retry.
  // One vision attempt: call -> parse -> coerce. Returns null on call/parse
  // failure. `settings` lets us force a provider on the retry.
  const attempt = async (settings: any, tag: string) => {
    let resp: any;
    try {
      resp = await ai.completeWithImage({ imageBuffer: processed, mediaType: 'image/jpeg', prompt: VISION_PROMPT, maxTokens: opts.maxTokens || 3072, settings });
    } catch (e: any) {
      console.warn(`[aiTestReport] vision call failed (${tag}):`, e && e.message ? e.message.slice(0, 200) : String(e));
      return null;
    }
    try {
      return _coerceResult(ai.parseJSON(resp && resp.text ? resp.text : '', 'ai'));
    } catch (e: any) {
      console.warn(`[aiTestReport] vision non-JSON response (${tag}):`, e && e.message ? e.message.slice(0, 160) : String(e));
      return null;
    }
  };

  // Primary provider first. If it throws, returns junk (non-JSON), OR succeeds
  // with an empty extraction (a Gemini alias model that answers but finds
  // nothing), fall to Groq's vision model so a quota-throttled primary doesn't
  // sink the whole extraction.
  let c = await attempt({}, 'primary');
  const primary = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!_hasContent(c) && process.env.GROQ_API_KEY && primary !== 'groq') {
    console.warn('[aiTestReport] vision: primary unusable/empty → retrying on groq');
    const c2 = await attempt({ provider: 'groq' }, 'groq');
    if (_hasContent(c2)) c = c2;
  }
  if (!c) return { ok: false, measurements: [] };
  return { ok: true, measurements: _mapMeasurements(c.measurements), fields: _mapFields(c.fields) };
}

module.exports = { aiFillReadings, aiFillReadingsFromImage, scrubForAi, KNOWN_TYPES, _mapMeasurements, _mapFields, _mapResult, _normUnit };
export {};
