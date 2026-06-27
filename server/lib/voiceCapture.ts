'use strict';

/**
 * lib/voiceCapture.ts
 * -------------------
 * Deterministic keyword/regex parser for structured voice field-entry shortcuts.
 *
 * Honest scope (COMP-8-8): this is NOT speech understanding or ML — it is a
 * fixed lexicon of regular expressions over an already-transcribed string.
 * Phrasing outside the hard-coded synonym tables yields a null field (the tech
 * then just types it). Describe it to users as "structured voice shortcuts,"
 * not "natural-language voice" / "AI voice."
 *
 * Two hard dependencies worth setting expectations on:
 *   - Speech→text is done on the phone by the browser-native Web Speech API,
 *     which is effectively Chrome/Chromium-only and (in Chrome) ships the audio
 *     to Google for recognition — so the speech step needs a network round-trip
 *     and is NOT available in the fully-offline field flow.
 *   - This module receives only the resulting TRANSCRIPT and turns it into a
 *     structured, pre-filled measurement PROPOSAL the tech confirms before
 *     anything is written. We never auto-commit compliance data from a voice guess.
 *
 *   parseVoiceReading("Breaker 42, IR normal, 68")
 *     → { assetHint: "breaker 42", measurementType: "insulation_resistance",
 *         unit: "MΩ", value: 68, passFail: "GREEN", confidence: 0.x, raw: ... }
 *
 * Pure + synchronous — fully unit-testable. Asset matching against the tech's
 * SCOPED inventory happens in the route (it needs the DB); this module only
 * extracts the spoken intent.
 */

// ── measurement-type lexicon (canonical → spoken synonyms) ─────────────────────
// Order matters: more specific phrases are tested before the bare "ir" alias so
// "IR temperature" resolves to temperature, not insulation resistance.
const MEASUREMENT_LEXICON: Array<{ type: string; unit: string; patterns: RegExp[] }> = [
  { type: 'temperature', unit: '°C', patterns: [
      /\binfrared\b/, /\bthermal\b/, /\bthermograph/, /\bhot\s?spot\b/, /\bir\s+(temp|temperature|scan)\b/,
      /\btemperature\b/, /\btemp\b/, /\bdelta\s?t\b/, /\b(deg|degrees?|celsius|fahrenheit)\b/ ] },
  { type: 'contact_resistance', unit: 'μΩ', patterns: [
      /\bcontact\s+resistance\b/, /\bductor\b/, /\bdlro\b/, /\bmicro\s?-?\s?ohm/ ] },
  { type: 'power_factor', unit: '%', patterns: [
      /\bpower\s+factor\b/, /\btan\s?(delta|δ)\b/, /\bdissipation\s+factor\b/, /\bpf\b/ ] },
  { type: 'insulation_resistance', unit: 'MΩ', patterns: [
      /\binsulation\s+resistance\b/, /\binsulation\b/, /\bmegg?er\b/, /\bmeg\s?ohm/, /\bmegohm/, /\bi\.?\s?r\.?\b/ ] },
  { type: 'load_current', unit: 'A', patterns: [
      /\bload\s+current\b/, /\bload\b/, /\bcurrent\b/, /\bamp(s|erage)?\b/ ] },
  { type: 'voltage', unit: 'V', patterns: [ /\bvoltage\b/, /\bvolts?\b/, /\bkv\b/, /\bkilovolts?\b/ ] },
  { type: 'timing', unit: 'ms', patterns: [ /\btiming\b/, /\btrip\s+time\b/, /\boperate\s+time\b/, /\bmilliseconds?\b/ ] },
];

// ── result lexicon → NETA decal rating ────────────────────────────────────────
const RESULT_LEXICON: Array<{ rating: string; patterns: RegExp[] }> = [
  { rating: 'RED',    patterns: [ /\bfail(ed|ure)?\b/, /\bout\s+of\s+spec\b/, /\bdefective\b/, /\bno\s+good\b/, /\bbad\b/, /\bred\b/ ] },
  { rating: 'YELLOW', patterns: [ /\bmarginal\b/, /\bborderline\b/, /\bwatch\b/, /\bmonitor\b/, /\bcaution\b/, /\byellow\b/ ] },
  { rating: 'GREEN',  patterns: [ /\bnormal\b/, /\bpass(ed|es)?\b/, /\bgood\b/, /\bokay\b/, /\bok\b/, /\b(with)?in\s+spec\b/, /\bsatisfactory\b/, /\bacceptable\b/, /\bgreen\b/ ] },
];

// Explicit spoken units → canonical unit symbol (overrides the type default).
const UNIT_LEXICON: Array<{ unit: string; pattern: RegExp }> = [
  { unit: 'MΩ', pattern: /\b(meg\s?ohms?|megohms?|m\s?ohms?)\b/ },
  { unit: 'μΩ', pattern: /\b(micro\s?-?\s?ohms?|u\s?ohms?)\b/ },
  { unit: 'kΩ', pattern: /\b(kilo\s?ohms?|k\s?ohms?)\b/ },
  { unit: 'Ω',  pattern: /\bohms?\b/ },
  { unit: 'kV', pattern: /\b(kilovolts?|kv)\b/ },
  { unit: 'V',  pattern: /\bvolts?\b/ },
  { unit: 'A',  pattern: /\b(amp(s|erage|eres?)?)\b/ },
  { unit: 'ms', pattern: /\b(milliseconds?|ms)\b/ },
  { unit: '°C', pattern: /\b(deg(rees?)?\s*(c|celsius)?|celsius)\b/ },
  { unit: '%',  pattern: /\b(percent|%)\b/ },
];

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// Convert a run of number-words to a value, e.g. ["sixty","eight"]→68,
// ["one","hundred","twenty"]→120, ["one","point","two"]→1.2. Returns null if the
// run isn't a number.
function wordsToNumber(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  // Decimal: "<int> point <digits>"
  const pointIdx = tokens.indexOf('point');
  if (pointIdx !== -1) {
    const whole = wordsToNumber(tokens.slice(0, pointIdx));
    const fracDigits = tokens.slice(pointIdx + 1).map((t) => ONES[t]).filter((n) => n !== undefined && n < 10);
    if (whole === null || fracDigits.length === 0) return null;
    return parseFloat(`${whole}.${fracDigits.join('')}`);
  }
  let total = 0;
  let current = 0;
  let saw = false;
  for (const t of tokens) {
    if (ONES[t] !== undefined) { current += ONES[t]; saw = true; }
    else if (TENS[t] !== undefined) { current += TENS[t]; saw = true; }
    else if (t === 'hundred') { current = (current || 1) * 100; saw = true; }
    else if (t === 'thousand') { total += (current || 1) * 1000; current = 0; saw = true; }
    else return null; // a non-number word breaks the run
  }
  return saw ? total + current : null;
}

// Pull the first numeric value out of the transcript — a digit run (handles
// commas + decimals) or a run of number-words.
function extractValue(raw: string, tokens: string[]): number | null {
  const digit = raw.match(/-?\d[\d,]*(?:\.\d+)?/);
  const numberWords = new Set([...Object.keys(ONES), ...Object.keys(TENS), 'hundred', 'thousand', 'point']);
  // Find the first contiguous run of number-words.
  let wordRun: string[] | null = null;
  let runStart = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (numberWords.has(tokens[i])) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      wordRun = tokens.slice(runStart, i);
      break;
    }
  }
  if (wordRun === null && runStart !== -1) wordRun = tokens.slice(runStart);

  const digitVal = digit ? parseFloat(digit[0].replace(/,/g, '')) : null;
  const wordVal  = wordRun ? wordsToNumber(wordRun) : null;
  // Prefer whichever appears first in the transcript.
  if (digitVal !== null && wordVal !== null) {
    return raw.indexOf(digit![0]) <= raw.indexOf(wordRun![0]) ? digitVal : wordVal;
  }
  return digitVal !== null ? digitVal : wordVal;
}

// The first measurement / result cue word. Everything BEFORE it is most likely
// the asset name ("breaker 42"); everything FROM it onward is the reading body
// where the value lives — so the asset's own number ("42") never gets mistaken
// for the measured value ("68").
const CUE_RE =
  /\b(insulation|contact|power\s+factor|tan|load|current|voltage|volts|temperature|temp|thermal|infrared|timing|amps?|megg?er|i\.?\s?r\.?|pf|normal|pass|fail|good|marginal|red|green|yellow)\b/;

function extractAssetHint(lcHead: string): string | null {
  // Strip a leading filler verb and trailing punctuation.
  const cleaned = lcHead.replace(/^(the|a|an|on|at|for|record|reading|log|note)\s+/i, '').replace(/[,.;:]+$/, '').trim();
  return cleaned.length ? cleaned : null;
}

function firstMatch<T extends { patterns: RegExp[] }>(text: string, lexicon: T[]): T | null {
  for (const entry of lexicon) {
    if (entry.patterns.some((p) => p.test(text))) return entry;
  }
  return null;
}

interface VoiceReading {
  raw: string;
  assetHint: string | null;
  measurementType: string | null;
  unit: string | null;
  value: number | null;
  passFail: string | null; // GREEN | YELLOW | RED
  confidence: number;      // 0..1 heuristic — how much we actually recognized
}

/**
 * Parse a spoken field reading into a structured measurement proposal.
 * Deterministic and side-effect-free.
 */
function parseVoiceReading(transcript: string): VoiceReading {
  const raw = String(transcript == null ? '' : transcript).trim();
  const lc = raw.toLowerCase();

  // Split at the first measurement/result cue: head = asset name, body = reading.
  const cueIdx = lc.search(CUE_RE);
  const head = (cueIdx === -1 ? '' : lc.slice(0, cueIdx)).trim();
  const body = cueIdx === -1 ? lc : lc.slice(cueIdx);
  const bodyTokens = body.replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/).filter(Boolean);

  const m = firstMatch(lc, MEASUREMENT_LEXICON);
  const r = firstMatch(lc, RESULT_LEXICON);
  const explicitUnit = UNIT_LEXICON.find((u) => u.pattern.test(lc));
  // Extract the value from the BODY so a leading asset number ("breaker 42")
  // is never mistaken for the reading ("68").
  const value = extractValue(body, bodyTokens);

  const measurementType = m ? m.type : null;
  const unit = explicitUnit ? explicitUnit.unit : (m ? m.unit : null);
  const passFail = r ? r.rating : null;
  const assetHint = extractAssetHint(head);

  // Confidence: reward each recognized facet. A reading with type + value is the
  // useful minimum; asset + result push it higher.
  let confidence = 0;
  if (measurementType) confidence += 0.4;
  if (value !== null)  confidence += 0.3;
  if (passFail)        confidence += 0.2;
  if (assetHint)       confidence += 0.1;

  return { raw, assetHint, measurementType, unit, value, passFail, confidence: Math.round(confidence * 100) / 100 };
}

// Tokenize an asset hint into lowercase search terms. Drops 1-char word noise
// ("a", "on") but KEEPS single digits — "breaker 7" needs the "7".
function hintTokens(hint: string): string[] {
  return String(hint || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 || /^\d+$/.test(t));
}

module.exports = { parseVoiceReading, hintTokens };

export {};
