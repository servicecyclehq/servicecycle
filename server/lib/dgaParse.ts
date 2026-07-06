/**
 * dgaParse.ts — #28 extract DGA gas concentrations from lab-report text.
 *
 * Vendor-agnostic, conservative: for each gas it finds the gas name/alias and
 * the nearest ppm number that follows it on the same line (or just after). Also
 * pulls a sample date and lab name when present. Built to read the common
 * SDMyers / Doble / generic lab layouts; tune against real reports as they
 * arrive (existence not quality — same posture as the test-report parser).
 */

import type { GasKey, Gases } from './dgaEvaluate';

// Gas -> ordered aliases (longest/most-specific first so "Carbon Dioxide"
// matches before "Carbon ..."; formulae like C2H2 are matched case-insensitively).
const ALIASES: Array<[GasKey, string[]]> = [
  ['c2h2', ['acetylene', 'c2h2']],
  ['c2h4', ['ethylene', 'c2h4']],
  ['c2h6', ['ethane', 'c2h6']],
  ['ch4',  ['methane', 'ch4']],
  ['h2',   ['hydrogen', 'h2']],
  ['co2',  ['carbon dioxide', 'co2']],
  ['co',   ['carbon monoxide', 'co']],
  ['o2',   ['oxygen', 'o2']],
  ['n2',   ['nitrogen', 'n2']],
];

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// A standalone ppm number: NOT glued to letters/digits on either side, so the
// digits inside a chemical formula ("H2", "C2H2") are never captured as a value.
const STANDALONE_NUM = /(?<![A-Za-z0-9.])(\d[\d,]*(?:\.\d+)?)(?![A-Za-z0-9])/;

/** The gas's value: anchor on the alias (not glued to a formula), then take the
 *  first standalone number on the rest of that line. */
function findValueFor(text: string, alias: string): number | null {
  // (?<![A-Za-z0-9]) so 'h2' doesn't match the "H2" inside "C2H2".
  const re = new RegExp(`(?<![A-Za-z0-9])${esc(alias)}\\b([^\\n]*)`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const num = STANDALONE_NUM.exec(m[1]);
  if (!num) return null;
  const n = Number(num[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// TDCG (Total Dissolved Combustible Gas) is a derived summary figure, not one
// of the 9 individual gases -- kept separate from ALIASES/GasKey. [Resolved
// 2026-07-05, Dustin's call: "reports, if certified/stamped, need to take
// precedence... we're a data org, not an engineering firm."] Captures the
// report's OWN stated TDCG so dgaEvaluate.ts can prefer it over always
// recomputing from individual gases -- previously never captured at all.
const TDCG_ALIASES = ['total dissolved combustible gas', 'total combustible gas', 'tdcg'];

function findTdcg(text: string): number | null {
  for (const a of TDCG_ALIASES) {
    const v = findValueFor(text, a);
    if (v != null) return v;
  }
  return null;
}

export function parseDgaText(text: string): { gases: Gases; sampleDate: string | null; labName: string | null; reportedTdcg: number | null } {
  const src = String(text || '');
  const gases: Gases = {};
  const used = new Set<GasKey>();
  for (const [key, aliases] of ALIASES) {
    if (used.has(key)) continue;
    for (const a of aliases) {
      const v = findValueFor(src, a);
      if (v != null) { gases[key] = v; used.add(key); break; }
    }
  }
  const reportedTdcg = findTdcg(src);

  // Sample date — first ISO or US date.
  let sampleDate: string | null = null;
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(src);
  const us = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/.exec(src);
  if (iso) sampleDate = iso[1];
  else if (us) {
    const d = new Date(us[1]);
    if (!Number.isNaN(d.getTime())) sampleDate = d.toISOString().slice(0, 10);
  }

  // Lab name — a line mentioning a known lab or "Laboratory".
  let labName: string | null = null;
  const lab = /(SDMyers|S\.?D\.? Myers|Doble|ESCO|Weidmann|TJ\|H2b|[A-Z][A-Za-z&. ]*Laborator(?:y|ies))/.exec(src);
  if (lab) labName = lab[1].trim().slice(0, 80);

  return { gases, sampleDate, labName, reportedTdcg };
}
