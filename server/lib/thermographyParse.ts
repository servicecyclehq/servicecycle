/**
 * thermographyParse.ts — #29 extract IR hot-spots from survey-report text.
 *
 * Conservative line scanner: any line carrying a temperature-rise token
 * (deltaT / dT / rise / "N C over") becomes a hot-spot, with the text before
 * the token taken as the location. Built to read common FLIR / contractor IR
 * report layouts; tune against real reports as they arrive (existence not
 * quality — same posture as the DGA + test-report parsers).
 */

// [NETA-8-1] Reference frame the ΔT is measured against. NETA Table 100.18 grades
// "over-ambient-air" rises on a DIFFERENT (more lenient) scale than
// "between-similar-components" rises, so the frame must travel with the value or
// a 30°C-over-ambient RECOMMENDED rise gets mis-graded as an IMMEDIATE
// similar-component discrepancy. 'baseline' is treated as similar-component for
// grading (a prior-reading comparison) until a dedicated band exists.
export type HotspotReference = 'ambient' | 'similar' | 'baseline';

export interface ParsedHotspot {
  location: string;
  deltaT: number;
  reference?: HotspotReference;
  // #29 7.4: the component label (same text as `location`, named for the
  // ThermographyFinding column) and the reference delta where the report
  // states one ("ΔT 18C vs 4C reference").
  component?: string;
  referenceDeltaT?: number | null;
}

// #29 NFPA 70B 7.4 survey header. Every field is best-effort: a value the
// report didn't state comes back null with 0 confidence so the capture form
// flags it for manual entry rather than inventing a number.
export interface ParsedSurveyHeader {
  thermographerName: string | null;
  thermographerQual: string | null;
  cameraMake:        string | null;
  cameraModel:       string | null;
  emissivity:        number | null;
  ambientTempC:      number | null;
  humidityPct:       number | null;
  reflectedTempC:    number | null;
  loadPercent:       number | null;
  surveyDate:        string | null;
}

export type HeaderConfidence = Partial<Record<keyof ParsedSurveyHeader, number>>;

// deltaT token + value: "ΔT 25C", "delta-T 8 degC", "dT: 12", "25°C rise",
// "30 C over ambient". Captures the number.
const DELTA_PATTERNS: RegExp[] = [
  /(?:Δ\s*t|delta[\s-]?t|\bd\s*t)\b[^0-9\n]{0,12}?(\d+(?:\.\d+)?)/i,
  /(\d+(?:\.\d+)?)\s*(?:°|deg(?:rees)?|º)?\s*c\b[^\n]{0,12}?(?:rise|over|above)/i,
];

function extractDelta(line: string): number | null {
  for (const re of DELTA_PATTERNS) {
    const m = re.exec(line);
    if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n > 0) return n; }
  }
  return null;
}

// [NETA-8-1] Infer the ΔT reference frame from the line text. Defaults to
// 'similar' (the most common electrical-IR comparison and the conservative band)
// only when the line gives no frame cue. "over/above ambient" => over-ambient;
// "vs/between similar/phase" => similar-component; "baseline/last/prior" =>
// baseline.
function extractReference(line: string): HotspotReference {
  const s = line.toLowerCase();
  if (/\b(over|above|vs\.?|versus|compared to|from)\s+ambient\b/.test(s) || /\bambient\s+rise\b/.test(s) || /\bover[-\s]?ambient\b/.test(s)) {
    return 'ambient';
  }
  if (/\b(baseline|last (?:scan|survey|reading)|prior|previous)\b/.test(s)) return 'baseline';
  // similar-component cues (or default): "similar", "between phases", "phase-to-phase"
  return 'similar';
}

function cleanLocation(line: string): string {
  // Strip the delta token + reference phrase and trailing severity words to
  // leave the location.
  let loc = line
    .replace(/(?:Δ\s*t|delta[\s-]?t|\bd\s*t)\b.*$/i, '')
    .replace(/\d+(?:\.\d+)?\s*(?:°|deg(?:rees)?|º)?\s*c\b.*$/i, '')
    .replace(/\b(over|above)\s+ambient\b.*$/i, '')
    .replace(/[\s.:,_|-]+$/g, '')
    .trim();
  // collapse leading table noise (bullets, indices)
  loc = loc.replace(/^\s*[\d.)\-•]+\s*/, '').trim();
  return loc.slice(0, 160);
}

// [#29 7.4] A reference delta stated alongside the rise: "ΔT 18C vs 4C
// reference", "18C rise (reference 4C)", "delta 18 / ref 4".
function extractReferenceDelta(line: string): number | null {
  const m = /(?:vs\.?|versus|reference|ref\.?|baseline)\D{0,8}(\d+(?:\.\d+)?)\s*(?:°|deg(?:rees)?|º)?\s*c\b/i.exec(line);
  if (m) { const n = Number(m[1]); if (Number.isFinite(n)) return n; }
  return null;
}

/**
 * [#29 7.4] Best-effort survey-header extraction.
 *
 * Example lines these patterns were written against (FLIR / Fluke / Testo
 * exports and typical contractor report headers) -- each `//` line is matched
 * by the pattern beneath it:
 *
 *   "Camera: FLIR T540 (s/n 12345)"            -> cameraMake FLIR, model T540
 *   "Instrument   Fluke TiX580"                -> cameraMake Fluke, model TiX580
 *   "IR Camera: Testo 890"                     -> cameraMake Testo, model 890
 *   "Emissivity: 0.95   Reflected: 22.0 C"     -> emissivity 0.95, reflected 22.0
 *   "Ambient temperature: 24.5 °C"             -> ambientTempC 24.5
 *   "Relative humidity: 45%"                   -> humidityPct 45
 *   "Load at time of survey: 78%"              -> loadPercent 78
 *   "Thermographer: Jane Roe, NETA Level II"   -> name Jane Roe, qual NETA Level II
 *
 * Anything unmatched stays null (confidence 0) so the capture form asks a
 * human rather than guessing. Never throws.
 */
export function parseSurveyHeader(text: string): { header: ParsedSurveyHeader; confidence: HeaderConfidence } {
  const src = String(text || '');
  const header: ParsedSurveyHeader = {
    thermographerName: null, thermographerQual: null, cameraMake: null, cameraModel: null,
    emissivity: null, ambientTempC: null, humidityPct: null, reflectedTempC: null,
    loadPercent: null, surveyDate: null,
  };
  const confidence: HeaderConfidence = {};

  const num = (re: RegExp): number | null => {
    const m = re.exec(src);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const set = <K extends keyof ParsedSurveyHeader>(k: K, v: ParsedSurveyHeader[K], c: number) => {
    if (v !== null && v !== undefined && v !== '') { header[k] = v; confidence[k] = c; }
  };

  // Camera: a known vendor token anywhere wins; the model is the token run
  // after it on the same line. Vendor list is the electrical-IR mainstream.
  const cam = /\b(FLIR|Fluke|Testo|Seek|Hikmicro|InfraTec|Optris|Keysight|Fotric)\b[\s:_-]*([A-Za-z0-9][A-Za-z0-9.\-]{1,20})?/i.exec(src);
  if (cam) {
    set('cameraMake', cam[1], 0.9);
    // Reject a trailing word that is obviously not a model ("camera", "was").
    const model = (cam[2] || '').trim();
    if (model && !/^(camera|thermal|imager|was|is|s\/n|sn)$/i.test(model)) set('cameraModel', model, 0.7);
  }

  // Emissivity 0..1 (occasionally written as a percentage; only accept <=1).
  const emis = num(/\bemissivit(?:y|e)\b\D{0,10}(\d(?:\.\d+)?)/i);
  if (emis !== null && emis > 0 && emis <= 1) set('emissivity', emis, 0.9);

  set('ambientTempC',   num(/\bambient(?:\s+(?:air\s+)?temp(?:erature)?)?\b\D{0,12}(-?\d+(?:\.\d+)?)/i), 0.85);
  set('reflectedTempC', num(/\breflected(?:\s+(?:apparent\s+)?temp(?:erature)?)?\b\D{0,12}(-?\d+(?:\.\d+)?)/i), 0.85);

  const hum = num(/\b(?:relative\s+)?humidity\b\D{0,12}(\d+(?:\.\d+)?)/i);
  if (hum !== null && hum >= 0 && hum <= 100) set('humidityPct', hum, 0.85);

  // Load: "load 78%", "load at time of survey: 78%", "% load 78". NETA/HSB
  // want load at scan time recorded (the >=40% rule).
  const load = num(/\bload\b[^\n%]{0,28}?(\d+(?:\.\d+)?)\s*%/i) ?? num(/(\d+(?:\.\d+)?)\s*%\s*load\b/i);
  if (load !== null && load >= 0 && load <= 100) set('loadPercent', load, 0.8);

  // Thermographer + certification level. Qual is read from the same line.
  const th = /\b(?:thermographer|technician|inspector|surveyed\s+by|performed\s+by)\b\s*[:\-]?\s*([A-Za-z][A-Za-z.'\- ]{1,60})/i.exec(src);
  if (th) {
    const raw = th[1].trim().replace(/[,;].*$/, '').trim();
    if (raw && raw.length > 1) set('thermographerName', raw.slice(0, 120), 0.6);
    const line = (src.split(/\r?\n/).find((l) => l.includes(th[1].slice(0, 12))) || '');
    const qual = /\b((?:ASNT|NETA|Infraspection)?\s*Level\s+(?:I{1,3}|IV|[1-4])\b[A-Za-z ]{0,24})/i.exec(line)
              || /\b(Level\s+(?:I{1,3}|IV|[1-4])\s+Thermographer)\b/i.exec(src);
    if (qual) set('thermographerQual', qual[1].trim().replace(/\s+/g, ' ').slice(0, 80), 0.7);
  }

  return { header, confidence };
}

export function parseThermographyText(text: string): {
  hotspots: ParsedHotspot[];
  surveyDate: string | null;
  header: ParsedSurveyHeader;
  confidence: HeaderConfidence;
} {
  const src = String(text || '');
  const hotspots: ParsedHotspot[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const deltaT = extractDelta(line);
    if (deltaT == null) continue;
    const location = cleanLocation(line) || 'Unspecified location';
    const reference = extractReference(line);
    hotspots.push({ location, component: location, deltaT, reference, referenceDeltaT: extractReferenceDelta(line) });
  }

  let surveyDate: string | null = null;
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(src);
  const us = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(src);
  if (iso) surveyDate = iso[1];
  else if (us) { const d = new Date(us[1]); if (!Number.isNaN(d.getTime())) surveyDate = d.toISOString().slice(0, 10); }

  // Header extraction is additive and must never break hot-spot ingest: an
  // unrecognized report degrades to "hotspots only, header all-null".
  let header: ParsedSurveyHeader;
  let confidence: HeaderConfidence;
  try {
    ({ header, confidence } = parseSurveyHeader(src));
  } catch (_e) {
    header = {
      thermographerName: null, thermographerQual: null, cameraMake: null, cameraModel: null,
      emissivity: null, ambientTempC: null, humidityPct: null, reflectedTempC: null,
      loadPercent: null, surveyDate: null,
    };
    confidence = {};
  }
  if (surveyDate) { header.surveyDate = surveyDate; confidence.surveyDate = 0.8; }

  return { hotspots, surveyDate, header, confidence };
}
