/**
 * lib/arcFlashSearch.ts — Slice 3e: natural-language facility search.
 *
 * Turn a plain-English query ("480V MCC buckets over 8 cal that are blocked") into
 * a DETERMINISTIC structured filter and match it against the arc-flash label rows.
 * No AI dependency — a transparent keyword/comparator parser whose interpretation
 * is shown back to the user, so results are explainable and reproducible (an LLM
 * parse can be layered on later, but the floor is deterministic).
 *
 * Supported facets: nominal voltage, equipment class, incident-energy comparison
 * (> / < / between, cal/cm^2), DANGER/WARNING severity, data-confidence band /
 * threshold, study expired / expiring, and blocked (missing required inputs).
 */

'use strict';

export interface SearchFilters {
  voltageV?: number;
  equipmentType?: string; // canonical token, e.g. 'MCC'
  ieMin?: number;
  ieMax?: number;
  severity?: 'danger' | 'warning';
  band?: 'green' | 'yellow' | 'red';
  confMax?: number; // trust score below this
  expired?: boolean;
  expiring?: boolean;
  blocked?: boolean;
}

export interface ParsedQuery { filters: SearchFilters; recognized: string[]; unrecognized: boolean; }

// Equipment keyword -> canonical equipmentType substring (matched against the
// asset's equipmentType, which uses tokens like SWITCHGEAR / MCC / PANELBOARD).
const EQUIP_KEYWORDS: Array<[RegExp, string, string]> = [
  [/\bmcc\b|motor control/, 'MCC', 'MCC'],
  [/switchgear|swgr/, 'SWITCHGEAR', 'switchgear'],
  [/switchboard|swbd/, 'SWITCHBOARD', 'switchboard'],
  [/panel(board)?|panelboard/, 'PANELBOARD', 'panelboard'],
  [/transformer|xfmr/, 'TRANSFORMER', 'transformer'],
  [/busway|bus duct/, 'BUSWAY', 'busway'],
  [/\bvfd\b|variable frequency/, 'VFD', 'VFD'],
  [/\bcable\b|feeder/, 'CABLE', 'cable'],
  [/\bmotor\b/, 'MOTOR', 'motor'],
  [/generator|genset/, 'GENERATOR', 'generator'],
];

function parseVolts(s: string): number | null {
  const kv = s.match(/(\d+(?:\.\d+)?)\s*kv/);
  if (kv) return Math.round(Number(kv[1]) * 1000);
  const v = s.match(/(\d+(?:\.\d+)?)\s*v(?:olts?)?\b/);
  if (v) return Math.round(Number(v[1]));
  return null;
}

/**
 * Parse a free-text query into deterministic filters. Pure.
 */
export function parseQuery(raw: any): ParsedQuery {
  const q = String(raw || '').toLowerCase();
  const filters: SearchFilters = {};
  const recognized: string[] = [];

  const volts = parseVolts(q);
  if (volts != null) { filters.voltageV = volts; recognized.push(`voltage ${volts} V`); }

  for (const [re, canon, label] of EQUIP_KEYWORDS) {
    if (re.test(q)) { filters.equipmentType = canon; recognized.push(`equipment ${label}`); break; }
  }

  // Incident-energy comparisons (cal/cm^2). "between A and B cal" first.
  const between = q.match(/between\s*(\d+(?:\.\d+)?)\s*(?:and|-)\s*(\d+(?:\.\d+)?)\s*cal/);
  if (between) {
    filters.ieMin = Number(between[1]); filters.ieMax = Number(between[2]);
    recognized.push(`incident energy ${filters.ieMin}-${filters.ieMax} cal/cm^2`);
  } else {
    const gt = q.match(/(?:>=?|over|above|greater than|more than)\s*(\d+(?:\.\d+)?)\s*cal/);
    if (gt) { filters.ieMin = Number(gt[1]); recognized.push(`incident energy > ${filters.ieMin} cal/cm^2`); }
    const lt = q.match(/(?:<=?|under|below|less than|fewer than)\s*(\d+(?:\.\d+)?)\s*cal/);
    if (lt) { filters.ieMax = Number(lt[1]); recognized.push(`incident energy < ${filters.ieMax} cal/cm^2`); }
  }

  if (/\bdanger\b/.test(q)) { filters.severity = 'danger'; recognized.push('severity DANGER'); }
  else if (/\bwarning\b/.test(q)) { filters.severity = 'warning'; recognized.push('severity WARNING'); }

  const trust = q.match(/(?:trust|confidence)\s*(?:<|under|below|less than)\s*(\d+)/);
  if (trust) { filters.confMax = Number(trust[1]); recognized.push(`confidence < ${filters.confMax}%`); }
  else if (/low (confidence|trust)/.test(q)) { filters.band = 'red'; recognized.push('low confidence'); }
  else if (/high (confidence|trust)/.test(q)) { filters.band = 'green'; recognized.push('high confidence'); }

  if (/expired/.test(q)) { filters.expired = true; recognized.push('study expired'); }
  if (/expiring|expire soon|expires soon/.test(q)) { filters.expiring = true; recognized.push('study expiring'); }
  if (/\bblocked\b|missing (data|inputs?|info)|incomplete|needs data|no data/.test(q)) { filters.blocked = true; recognized.push('blocked / missing inputs'); }

  return { filters, recognized, unrecognized: recognized.length === 0 && q.trim().length > 0 };
}

function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

/**
 * Match an enriched label row against parsed filters. Row fields:
 *   nominalVoltage, equipmentType, incidentEnergyCalCm2, labelSeverity,
 *   confidence {score, band}, expired, expiringSoon, readiness.
 */
export function matchRow(row: any, filters: SearchFilters): boolean {
  if (filters.voltageV != null) {
    const v = voltsOf(row.nominalVoltage);
    // Tolerate small label/nominal differences (e.g. 480 vs 480Y/277).
    if (v == null || Math.abs(v - filters.voltageV) > Math.max(5, filters.voltageV * 0.05)) return false;
  }
  if (filters.equipmentType != null) {
    if (!String(row.equipmentType || '').toUpperCase().includes(filters.equipmentType)) return false;
  }
  if (filters.ieMin != null) {
    if (row.incidentEnergyCalCm2 == null || row.incidentEnergyCalCm2 <= filters.ieMin) return false;
  }
  if (filters.ieMax != null) {
    if (row.incidentEnergyCalCm2 == null || row.incidentEnergyCalCm2 >= filters.ieMax) return false;
  }
  if (filters.severity != null && row.labelSeverity !== filters.severity) return false;
  if (filters.band != null && row.confidence?.band !== filters.band) return false;
  if (filters.confMax != null) {
    if (row.confidence?.score == null || row.confidence.score >= filters.confMax) return false;
  }
  if (filters.expired === true && !row.expired) return false;
  if (filters.expiring === true && !row.expiringSoon) return false;
  if (filters.blocked === true && row.readiness !== 'blocked') return false;
  return true;
}
