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
}

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

export function parseThermographyText(text: string): { hotspots: ParsedHotspot[]; surveyDate: string | null } {
  const src = String(text || '');
  const hotspots: ParsedHotspot[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const deltaT = extractDelta(line);
    if (deltaT == null) continue;
    const location = cleanLocation(line) || 'Unspecified location';
    const reference = extractReference(line);
    hotspots.push({ location, deltaT, reference });
  }

  let surveyDate: string | null = null;
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(src);
  const us = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(src);
  if (iso) surveyDate = iso[1];
  else if (us) { const d = new Date(us[1]); if (!Number.isNaN(d.getTime())) surveyDate = d.toISOString().slice(0, 10); }

  return { hotspots, surveyDate };
}
