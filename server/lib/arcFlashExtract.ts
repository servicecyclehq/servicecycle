/**
 * lib/arcFlashExtract.ts — arc-flash document ingestion (Slice 2).
 *
 * Takes an uploaded one-line diagram or study report and extracts a STRUCTURED
 * system model (system facts + per-bus IEEE 1584 inputs + feeds-downstream
 * topology) via the BYO-AI cascade:
 *   - text path  : text-extractable PDFs (e.g. SKM/EasyPower study reports) ->
 *                  pdfjs text -> ai.complete (extraction prompt)
 *   - vision path: PNG/JPG one-line images (scanned / CAD exports with no text
 *                  layer) -> ai.completeWithImage
 *
 * The raw model output is parsed DEFENSIVELY (engineering-guidelines §4: build to
 * the response we actually get, never assume) and normalized: equipment labels
 * map to our EquipmentType enum, numbers coerce, unknown values become null
 * rather than guesses. Confidence/gap scoring is NOT done here — that's the
 * deterministic job of lib/arcFlashGap.ts, run after this returns.
 *
 * Honest by design: extraction is a "strong draft you correct," never a stamp.
 */

'use strict';

const ai = require('./ai');
const { extractPdfText } = require('./testReportParse');
const { rasterizePdf } = require('./rasterizePdf');
const { extractPdfPlumber } = require('./pdfText');

const PROMPT_VERSION = 'af-extract-v1';

// Allowed EquipmentType enum values an extracted bus may map to.
const VALID_TYPES = new Set([
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD',
  'BUSWAY', 'GENERATOR', 'MOTOR', 'MCC', 'VFD', 'UPS_BATTERY', 'CIRCUIT_BREAKER',
  'DISCONNECT_SWITCH', 'TRANSFER_SWITCH', 'CABLE_LV', 'CABLE_MV_HV',
]);

const ELECTRODE_CONFIGS = new Set(['VCB', 'VCBB', 'HCB', 'VOA', 'HOA']);

// The strict-JSON contract we ask the model to fill. Kept in one place so the
// text and vision prompts stay identical and the version is reproducible.
const JSON_CONTRACT = `Return STRICT JSON only (no prose, no markdown fences) matching exactly:
{
  "system": {
    "sourceVoltage": "string or null (utility/service voltage, e.g. \\"13.8kV\\")",
    "mainTransformer": { "kva": number_or_null, "primaryVoltage": "string|null", "secondaryVoltage": "string|null", "impedancePct": number_or_null } ,
    "serviceFaultCurrentKA": number_or_null,
    "studyMeta": { "peName": "string|null", "date": "string|null", "method": "string|null", "software": "string|null" }
  },
  "buses": [
    {
      "busName": "string (the equipment/bus label as drawn, REQUIRED)",
      "equipmentType": "one of TRANSFORMER_LIQUID, TRANSFORMER_DRY, SWITCHGEAR, SWITCHBOARD, PANELBOARD, BUSWAY, GENERATOR, MOTOR, MCC, VFD, UPS_BATTERY, CIRCUIT_BREAKER, DISCONNECT_SWITCH, TRANSFER_SWITCH, CABLE_LV, CABLE_MV_HV — or null",
      "fedFromBusName": "string|null (the name of the upstream bus that feeds this one)",
      "nominalVoltage": "string|null",
      "boltedFaultCurrentKA": number_or_null,
      "arcingCurrentKA": number_or_null,
      "electrodeConfig": "VCB|VCBB|HCB|VOA|HOA|null",
      "conductorGapMm": number_or_null,
      "workingDistanceIn": number_or_null,
      "clearingTimeMs": number_or_null,
      "upstreamDevice": "string|null (protective device label, e.g. \\"Main CB / 51 relay\\")",
      "deviceType": "breaker|fuse|relay|switch|null (the upstream protective device kind)",
      "deviceManufacturer": "string|null",
      "deviceModel": "string|null (series / catalog / part number)",
      "deviceRatingA": number_or_null,
      "deviceSettings": "object|null (trip settings: longTime, shortTime, instantaneous, groundFault; or fuse class+rating)",
      "cableLengthFt": number_or_null,
      "cableSize": "string|null (e.g. \\"500 kcmil\\", \\"#2 AWG\\")",
      "cableMaterial": "Cu|Al|null",
      "incidentEnergyCalCm2": number_or_null,
      "arcFlashBoundaryIn": number_or_null,
      "ppeCategory": number_or_null
    }
  ]
}
Rules: extract ONLY what is explicitly present in the document. Use null for anything not stated — NEVER invent or estimate a value. Every bus MUST have a busName. Preserve the feeds-downstream topology via fedFromBusName.`;

const EXTRACT_SYSTEM =
  'You are a meticulous electrical power-systems data extractor. You read arc-flash and short-circuit study reports and one-line diagrams and pull out a structured system model for IEEE 1584 arc-flash analysis. You never fabricate values. ' +
  JSON_CONTRACT;

const VISION_PROMPT =
  'This image is an electrical one-line (single-line) diagram. Read every bus, switchboard, switchgear, MCC, panel, transformer and their connections. Extract the structured system model for IEEE 1584 arc-flash analysis. ' +
  JSON_CONTRACT;

// Flatten deterministically-extracted tables to a compact, capped text block.
function tablesToText(tables: any[]): string {
  if (!Array.isArray(tables) || !tables.length) return '';
  const lines: string[] = [];
  for (const tbl of tables) {
    if (!Array.isArray(tbl)) continue;
    for (const row of tbl) lines.push((Array.isArray(row) ? row : []).map((c: any) => String(c == null ? '' : c)).join(' | '));
    lines.push('');
    if (lines.join('\n').length > 10000) break; // token guard
  }
  return lines.join('\n').slice(0, 10000);
}

function buildUserPrompt(reportText: string, tables?: any[]): string {
  const tbl = tablesToText(tables || []);
  if (tbl) {
    // pdfplumber found ruled tables — they carry the per-bus device / rating /
    // IEEE 1584 data. Send the TABLES as the high-value payload + a smaller text
    // excerpt for context: fewer, more focused tokens than dumping the report.
    const ctx = reportText.length > 8000 ? reportText.slice(0, 8000) + '\n...[truncated]' : reportText;
    return 'Extract the structured system model. The TABLES below were extracted deterministically and carry the per-bus device, rating, and IEEE 1584 data — rely on them first; the TEXT is for context.\n\nTABLES:\n' + tbl + '\n\nTEXT:\n' + ctx;
  }
  // No tables — cap the raw text so a long report stays within budget.
  const clipped = reportText.length > 24000 ? reportText.slice(0, 24000) + '\n...[truncated]' : reportText;
  return 'Extract the structured system model from this study report text:\n\n' + clipped;
}

// ── Normalization helpers ────────────────────────────────────────────────────

function cleanStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|n\/a|na|none|-|—)$/i.test(s)) return null;
  return s;
}

function coerceNum(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  // Pull the first numeric token so "22 kA", "1,500", "13.8 kV" parse, but
  // "N/A" / "none" yield null (no token) instead of 0.
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Map a free-text equipment label to our EquipmentType enum, else null.
function mapEquipmentType(raw: any): string | null {
  if (!raw) return null;
  const up = String(raw).trim().toUpperCase();
  if (VALID_TYPES.has(up)) return up; // model already returned a valid enum
  const s = String(raw).toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => s.includes(w));
  if (has('motor control', 'mcc')) return 'MCC';
  if (has('switchgear', 'swgr', 'metal-clad', 'metalclad', 'metal clad')) return 'SWITCHGEAR';
  if (has('switchboard', 'swbd', 'mdp', 'main distribution', 'main dist', 'main switchboard')) return 'SWITCHBOARD';
  if (has('panelboard', 'panel', 'pnl', 'load center', 'loadcenter', 'lighting panel')) return 'PANELBOARD';
  if (has('busway', 'bus duct', 'busduct', 'bus way', 'bus-duct')) return 'BUSWAY';
  if (has('transfer switch', 'ats ', ' ats', 'automatic transfer')) return 'TRANSFER_SWITCH';
  if (has('vfd', 'variable frequency', 'variable-frequency', 'adjustable speed')) return 'VFD';
  if (has('ups', 'uninterruptible', 'battery')) return 'UPS_BATTERY';
  if (has('generator', 'genset', 'gen set', 'gen-set')) return 'GENERATOR';
  if (has('transformer', 'xfmr', 'xfrm', 'xfr')) return s.includes('dry') ? 'TRANSFORMER_DRY' : 'TRANSFORMER_LIQUID';
  if (has('disconnect', 'safety switch', 'fused switch', 'fusible')) return 'DISCONNECT_SWITCH';
  if (has('circuit breaker', 'breaker')) return 'CIRCUIT_BREAKER';
  if (has('motor')) return 'MOTOR';
  if (has('cable', 'feeder', 'conductor')) return (s.includes('mv') || s.includes('medium') || /\b(5|15|13\.8|13\.2|12\.47|4\.16)\s*kv/.test(s)) ? 'CABLE_MV_HV' : 'CABLE_LV';
  return null;
}

function normElectrode(v: any): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  const up = s.toUpperCase();
  return ELECTRODE_CONFIGS.has(up) ? up : null;
}

function normPpe(v: any): number | null {
  const n = coerceNum(v);
  if (n == null) return null;
  const i = Math.round(n);
  return i >= 0 && i <= 4 ? i : null;
}

// Defensive normalization of whatever JSON the model returned.
function normalizeExtraction(parsed: any): { systemMeta: any; buses: any[]; warnings: string[] } {
  const warnings: string[] = [];
  const root = parsed && typeof parsed === 'object' ? parsed : {};

  const sys = root.system && typeof root.system === 'object' ? root.system : {};
  const mt = sys.mainTransformer && typeof sys.mainTransformer === 'object' ? sys.mainTransformer : {};
  const sm = sys.studyMeta && typeof sys.studyMeta === 'object' ? sys.studyMeta : {};
  const systemMeta = {
    sourceVoltage: cleanStr(sys.sourceVoltage),
    mainTransformer: {
      kva: coerceNum(mt.kva),
      primaryVoltage: cleanStr(mt.primaryVoltage),
      secondaryVoltage: cleanStr(mt.secondaryVoltage),
      impedancePct: coerceNum(mt.impedancePct),
    },
    serviceFaultCurrentKA: coerceNum(sys.serviceFaultCurrentKA),
    studyMeta: {
      peName: cleanStr(sm.peName),
      date: cleanStr(sm.date),
      method: cleanStr(sm.method),
      software: cleanStr(sm.software),
    },
  };

  const rawBuses = Array.isArray(root.buses) ? root.buses : [];
  if (!Array.isArray(root.buses)) warnings.push('Model returned no "buses" array.');
  const seen = new Set<string>();
  const buses: any[] = [];
  for (const b of rawBuses) {
    if (!b || typeof b !== 'object') continue;
    const busName = cleanStr(b.busName);
    if (!busName) { warnings.push('Dropped a bus with no name.'); continue; }
    const key = busName.toLowerCase();
    if (seen.has(key)) { warnings.push(`Duplicate bus "${busName}" collapsed.`); continue; }
    seen.add(key);
    const typeRaw = b.equipmentType;
    const equipmentTypeGuess = mapEquipmentType(typeRaw);
    if (typeRaw && !equipmentTypeGuess) warnings.push(`Unmapped equipment type "${typeRaw}" on ${busName} — left blank for review.`);
    buses.push({
      busName,
      equipmentTypeGuess,
      equipmentTypeRaw: cleanStr(typeRaw),
      fedFromBusName: cleanStr(b.fedFromBusName),
      nominalVoltage: cleanStr(b.nominalVoltage),
      boltedFaultCurrentKA: coerceNum(b.boltedFaultCurrentKA),
      arcingCurrentKA: coerceNum(b.arcingCurrentKA),
      electrodeConfig: normElectrode(b.electrodeConfig),
      conductorGapMm: coerceNum(b.conductorGapMm),
      workingDistanceIn: coerceNum(b.workingDistanceIn),
      clearingTimeMs: coerceNum(b.clearingTimeMs),
      upstreamDevice: cleanStr(b.upstreamDevice),
      deviceType: cleanStr(b.deviceType),
      deviceManufacturer: cleanStr(b.deviceManufacturer),
      deviceModel: cleanStr(b.deviceModel),
      deviceRatingA: coerceNum(b.deviceRatingA),
      deviceSettings: b.deviceSettings && typeof b.deviceSettings === 'object' ? b.deviceSettings : null,
      cableLengthFt: coerceNum(b.cableLengthFt),
      cableSize: cleanStr(b.cableSize),
      cableMaterial: cleanStr(b.cableMaterial),
      incidentEnergyCalCm2: coerceNum(b.incidentEnergyCalCm2),
      arcFlashBoundaryIn: coerceNum(b.arcFlashBoundaryIn),
      ppeCategory: normPpe(b.ppeCategory),
    });
  }
  return { systemMeta, buses, warnings };
}

function normalizeMedia(mimeType: any): string {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('png')) return 'image/png';
  if (m.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

// ── Public entry point ───────────────────────────────────────────────────────

function firstNonNull(...vals: any[]): any { for (const v of vals) if (v != null) return v; return null; }

// Run the vision model on ONE image buffer and normalize the result.
async function visionExtractOne(buffer: Buffer, mediaType: string, settings: any): Promise<any> {
  const out = await ai.completeWithImage({ imageBuffer: buffer, mediaType, prompt: VISION_PROMPT, maxTokens: 8192, settings });
  const text = out && out.text ? out.text : '';
  let parsed: any;
  try { parsed = ai.parseJSON(text, 'arc-flash-extract'); }
  catch { return { systemMeta: null, buses: [], warnings: ['Could not parse the AI response as JSON.'], rawJsonText: text }; }
  const norm = normalizeExtraction(parsed);
  return { systemMeta: norm.systemMeta, buses: norm.buses, warnings: norm.warnings, rawJsonText: text };
}

// Merge per-page extractions: union buses (dedup by name, fill nulls from later
// pages), take the first non-null system fact for each field.
function mergeExtractions(list: any[]): any {
  const warnings: string[] = [];
  const sm: any = { sourceVoltage: null, mainTransformer: { kva: null, primaryVoltage: null, secondaryVoltage: null, impedancePct: null }, serviceFaultCurrentKA: null, studyMeta: { peName: null, date: null, method: null, software: null } };
  const byName = new Map<string, any>();
  let rawJsonText = '';
  for (const x of list) {
    if (!x) continue;
    warnings.push(...(x.warnings || []));
    if (x.rawJsonText && !rawJsonText) rawJsonText = x.rawJsonText;
    const m = x.systemMeta;
    if (m) {
      sm.sourceVoltage = firstNonNull(sm.sourceVoltage, m.sourceVoltage);
      sm.serviceFaultCurrentKA = firstNonNull(sm.serviceFaultCurrentKA, m.serviceFaultCurrentKA);
      if (m.mainTransformer) for (const k of ['kva', 'primaryVoltage', 'secondaryVoltage', 'impedancePct']) sm.mainTransformer[k] = firstNonNull(sm.mainTransformer[k], m.mainTransformer[k]);
      if (m.studyMeta) for (const k of ['peName', 'date', 'method', 'software']) sm.studyMeta[k] = firstNonNull(sm.studyMeta[k], m.studyMeta[k]);
    }
    for (const b of (x.buses || [])) {
      const key = String(b.busName || '').toLowerCase();
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, b);
      else {
        const merged: any = { ...byName.get(key) };
        for (const k of Object.keys(b)) if (merged[k] == null && b[k] != null) merged[k] = b[k];
        byName.set(key, merged);
      }
    }
  }
  return { systemMeta: sm, buses: [...byName.values()], warnings, rawJsonText };
}

// Assemble the final return envelope + a no-buses warning if empty.
function finalize(method: string, aiProvider: any, norm: any, warnings: string[]): any {
  const all = [...warnings, ...(norm.warnings || [])];
  if (!norm.buses || !norm.buses.length) all.push('No buses were extracted — the document may not be a one-line / study, or the scan is too low quality.');
  return { method, aiProvider: aiProvider ?? null, promptVersion: PROMPT_VERSION, systemMeta: norm.systemMeta ?? null, buses: norm.buses || [], warnings: all, rawJsonText: norm.rawJsonText || '' };
}

// Extract a structured arc-flash system model from an uploaded document.
// Image -> vision; text-layer PDF -> text parse; scanned/vector PDF -> AUTO
// rasterize to image(s) -> vision (no manual conversion). Fails SOFT: an
// unreadable / unsupported file yields an empty model + a clear warning.
async function extractArcFlashDocument(opts: { buffer: Buffer; mimeType?: string; fileName?: string; settings?: any }): Promise<any> {
  const { buffer, mimeType, fileName, settings = {} } = opts;
  const warnings: string[] = [];
  const isImage = /image\/(png|jpe?g|webp)/i.test(mimeType || '') || /\.(png|jpe?g|webp)$/i.test(fileName || '');
  const isPdf = /pdf/i.test(mimeType || '') || /\.pdf$/i.test(fileName || '');

  // Image upload -> vision directly.
  if (isImage) {
    const one = await visionExtractOne(buffer, normalizeMedia(mimeType), settings);
    return finalize('vision', null, one, warnings);
  }

  if (isPdf) {
    // Deterministic-first: pdfplumber (best at the ruled tables study reports are
    // full of) -> pdfjs fallback. Vision only fires when there is NO text layer,
    // so we never spend vision tokens on a text-based study.
    let pdfText = '';
    let tables: any[] = [];
    try {
      const det = await extractPdfPlumber(buffer);
      if (det && det.ok && det.text) { pdfText = det.text; tables = Array.isArray(det.tables) ? det.tables : []; }
    } catch { /* fail-open to pdfjs */ }
    if (!pdfText || pdfText.replace(/\s+/g, ' ').trim().length < 120) {
      try { pdfText = await extractPdfText(buffer); } catch (e: any) { warnings.push('PDF text extraction failed: ' + (e && e.message ? e.message : e)); }
      tables = [];
    }
    const meaningful = (pdfText || '').replace(/\s+/g, ' ').trim();
    if (meaningful.length >= 120) {
      // Text-layer PDF (study report) -> text path.
      const out = await ai.complete({ system: EXTRACT_SYSTEM, user: buildUserPrompt(pdfText, tables), maxTokens: 8192, task: 'extract', settings });
      const text = out && out.text ? out.text : '';
      let parsed: any;
      try { parsed = ai.parseJSON(text, 'arc-flash-extract'); }
      catch { warnings.push('Could not parse the AI response as JSON — try re-uploading.'); return { method: 'text', aiProvider: out && out.provider ? out.provider : null, promptVersion: PROMPT_VERSION, systemMeta: null, buses: [], warnings, rawJsonText: text }; }
      const norm = normalizeExtraction(parsed);
      return finalize('text', out && out.provider ? out.provider : null, { ...norm, rawJsonText: text }, warnings);
    }
    // Scanned / vector PDF (no text layer) -> AUTO-RASTERIZE then vision.
    const pages = await rasterizePdf(buffer, { maxPages: 4 });
    if (!pages.length) {
      warnings.push('This PDF has no text layer and could not be auto-converted to an image. Upload a PNG/JPG of the one-line instead.');
      return { method: 'needs_image', aiProvider: null, promptVersion: PROMPT_VERSION, systemMeta: null, buses: [], warnings, rawJsonText: '' };
    }
    const perPage: any[] = [];
    for (const pg of pages) perPage.push(await visionExtractOne(pg, 'image/png', settings));
    const merged = mergeExtractions(perPage);
    if (pages.length > 1) warnings.push(`Auto-converted ${pages.length} PDF page(s) to images for reading.`);
    return finalize('vision_pdf', null, merged, warnings);
  }

  warnings.push('Unsupported file type for arc-flash extraction (' + (mimeType || fileName || 'unknown') + '). Upload a PDF study report or a PNG/JPG one-line image.');
  return { method: 'unsupported', aiProvider: null, promptVersion: PROMPT_VERSION, systemMeta: null, buses: [], warnings, rawJsonText: '' };
}

export { extractArcFlashDocument, normalizeExtraction, mapEquipmentType, PROMPT_VERSION };
