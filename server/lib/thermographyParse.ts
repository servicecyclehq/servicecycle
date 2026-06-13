/**
 * thermographyParse.ts — #29 extract IR hot-spots from survey-report text.
 *
 * Conservative line scanner: any line carrying a temperature-rise token
 * (deltaT / dT / rise / "N C over") becomes a hot-spot, with the text before
 * the token taken as the location. Built to read common FLIR / contractor IR
 * report layouts; tune against real reports as they arrive (existence not
 * quality — same posture as the DGA + test-report parsers).
 */

export interface ParsedHotspot {
  location: string;
  deltaT: number;
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

function cleanLocation(line: string): string {
  // Strip the delta token and trailing severity words to leave the location.
  let loc = line
    .replace(/(?:Δ\s*t|delta[\s-]?t|\bd\s*t)\b.*$/i, '')
    .replace(/\d+(?:\.\d+)?\s*(?:°|deg(?:rees)?|º)?\s*c\b.*$/i, '')
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
    hotspots.push({ location, deltaT });
  }

  let surveyDate: string | null = null;
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(src);
  const us = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(src);
  if (iso) surveyDate = iso[1];
  else if (us) { const d = new Date(us[1]); if (!Number.isNaN(d.getTime())) surveyDate = d.toISOString().slice(0, 10); }

  return { hotspots, surveyDate };
}
