/**
 * lib/arcFlashDrift.ts — Slice 2.8b: change -> re-study DRIFT detection.
 *
 * Compare a NEW ingest revision against the PRIOR confirmed one for the same site
 * and flag MATERIAL changes per bus — an added/removed bus, or a changed nominal
 * voltage, available fault current, upstream protective device (type / rating /
 * trip settings), clearing time, or feed topology. A material change to a modeled
 * bus means the stamped study no longer reflects the field: re-study recommended
 * ("Building B MCC-7 is 18% outside the modeled conditions").
 *
 * DETERMINISTIC per engineering-guidelines #7 — a transparent field-by-field diff
 * with documented thresholds, never an LLM judgement. SC surfaces the trigger; a
 * licensed PE decides whether to re-run the study.
 */

'use strict';

// Relative-change tolerance for numeric inputs — below this is treated as noise
// (rounding / re-measurement), at or above it is a material change.
export const NUMERIC_MATERIAL_PCT = 10;

function parseVolts(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function busKey(name: any): string { return String(name == null ? '' : name).trim().toLowerCase(); }

function cleanStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Stable stringify so {a:1,b:2} and {b:2,a:1} compare equal.
function stableSettings(v: any): string {
  if (v == null || typeof v !== 'object') return v == null ? '' : String(v);
  const keys = Object.keys(v).sort();
  return JSON.stringify(keys.map((k) => [k, v[k]]));
}

// Relative % difference between two numbers (vs the prior magnitude). Returns null
// when not computable.
function pctDelta(from: number | null, to: number | null): number | null {
  if (from == null || to == null) return null;
  const base = Math.abs(from);
  if (base === 0) return to === 0 ? 0 : 100;
  return Math.round((Math.abs(to - from) / base) * 1000) / 10;
}

interface FieldChange { field: string; label: string; from: any; to: any; pct?: number | null; material: boolean; }

function diffNumeric(label: string, field: string, fromRaw: any, toRaw: any, parse: (x: any) => number | null): FieldChange | null {
  const from = parse(fromRaw);
  const to = parse(toRaw);
  if (from == null && to == null) return null;
  if (from != null && to != null) {
    const pct = pctDelta(from, to);
    if (pct == null || pct < NUMERIC_MATERIAL_PCT) return null;
    return { field, label, from, to, pct, material: true };
  }
  // Appeared or disappeared — material (we gained/lost a modeled input).
  return { field, label, from, to, pct: null, material: true };
}

function diffCategorical(label: string, field: string, fromRaw: any, toRaw: any): FieldChange | null {
  const from = cleanStr(fromRaw);
  const to = cleanStr(toRaw);
  if ((from || '') === (to || '')) return null;
  return { field, label, from, to, material: true };
}

function diffSettings(fromRaw: any, toRaw: any): FieldChange | null {
  const from = stableSettings(fromRaw);
  const to = stableSettings(toRaw);
  if (from === to) return null;
  return { field: 'deviceSettings', label: 'Trip settings', from: fromRaw ?? null, to: toRaw ?? null, material: true };
}

function diffBus(prior: any, current: any): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (c: FieldChange | null) => { if (c) changes.push(c); };
  push(diffNumeric('Nominal voltage', 'nominalVoltage', prior.nominalVoltage, current.nominalVoltage, parseVolts));
  push(diffNumeric('Available fault current', 'boltedFaultCurrentKA', prior.boltedFaultCurrentKA, current.boltedFaultCurrentKA, num));
  push(diffNumeric('Clearing time', 'clearingTimeMs', prior.clearingTimeMs, current.clearingTimeMs, num));
  push(diffNumeric('Device rating', 'deviceRatingA', prior.deviceRatingA, current.deviceRatingA, num));
  push(diffCategorical('Device type', 'deviceType', prior.deviceType, current.deviceType));
  push(diffCategorical('Trip unit', 'tripUnitType', prior.tripUnitType, current.tripUnitType));
  push(diffCategorical('Feed source (topology)', 'fedFromBusName', prior.fedFromBusName, current.fedFromBusName));
  push(diffSettings(prior.deviceSettings, current.deviceSettings));
  // [D3, resolved 2026-07-05] These 5 feed the incident-energy calculation
  // directly (same fields busForGap already requires for calc-completeness)
  // but were previously untracked here, so a geometry-only change could pass
  // as "no material change." Same materiality threshold as the other numeric
  // inputs above (10% relative-change tolerance via diffNumeric).
  push(diffCategorical('Electrode configuration', 'electrodeConfig', prior.electrodeConfig, current.electrodeConfig));
  push(diffNumeric('Conductor gap', 'conductorGapMm', prior.conductorGapMm, current.conductorGapMm, num));
  push(diffNumeric('Working distance', 'workingDistanceIn', prior.workingDistanceIn, current.workingDistanceIn, num));
  push(diffNumeric('Cable length', 'cableLengthFt', prior.cableLengthFt, current.cableLengthFt, num));
  push(diffCategorical('Cable size', 'cableSize', prior.cableSize, current.cableSize));
  return changes;
}

export interface BusDrift { busName: string; change: 'added' | 'removed' | 'changed'; fields: FieldChange[]; maxPct: number | null; }
export interface DriftReport {
  hasPrior: boolean;
  comparedToIngestId: string | null;
  comparedToConfirmedAt: any;
  addedCount: number; removedCount: number; changedCount: number;
  materialChange: boolean;
  reStudyRecommended: boolean;
  maxPctDelta: number | null;
  busChanges: BusDrift[];
  summary: string;
  // [D1] Bus-name keys (post-normalize: trim+lowercase, so blank/null names all
  // collapse to '') that had MORE THAN ONE bus on either side of the diff.
  // Those rows can't be matched 1:1 by name (which prior row corresponds to
  // which current row?), so they are excluded from busChanges/field-diffing
  // below rather than one silently overwriting another in the lookup map —
  // which could hide a real material change to an unnamed/duplicate-named bus.
  duplicateKeyWarnings: Array<{ key: string; priorCount: number; currentCount: number }>;
}

/**
 * Diff two ingest revisions (each: { id?, confirmedAt?, buses: [...] }). Pure.
 * `prior` may be null when there's no earlier confirmed revision for the site.
 */
export function diffIngestRevisions(prior: { id?: string; confirmedAt?: any; buses: any[] } | null, current: { buses: any[] }): DriftReport {
  if (!prior) {
    return {
      hasPrior: false, comparedToIngestId: null, comparedToConfirmedAt: null,
      addedCount: 0, removedCount: 0, changedCount: 0, materialChange: false, reStudyRecommended: false,
      maxPctDelta: null, busChanges: [], duplicateKeyWarnings: [],
      summary: 'No prior confirmed revision for this site — this is the baseline.',
    };
  }

  // [D1] Group by key instead of a single-value Map so a name collision
  // (most commonly: multiple blank/null busName rows all keying to '') is
  // DETECTED rather than one row silently overwriting another before the
  // diff even runs.
  const priorGroups = new Map<string, any[]>();
  for (const b of prior.buses || []) {
    const k = busKey(b.busName);
    const arr = priorGroups.get(k); if (arr) arr.push(b); else priorGroups.set(k, [b]);
  }
  const curGroups = new Map<string, any[]>();
  for (const b of current.buses || []) {
    const k = busKey(b.busName);
    const arr = curGroups.get(k); if (arr) arr.push(b); else curGroups.set(k, [b]);
  }

  const busChanges: BusDrift[] = [];
  const duplicateKeyWarnings: Array<{ key: string; priorCount: number; currentCount: number }> = [];
  let addedCount = 0, removedCount = 0, changedCount = 0;
  let maxPctDelta: number | null = null;

  const allKeys = new Set<string>([...priorGroups.keys(), ...curGroups.keys()]);
  for (const k of allKeys) {
    const priors = priorGroups.get(k) || [];
    const curs = curGroups.get(k) || [];

    // Ambiguous: more than one bus on either side shares this key — can't be
    // matched 1:1 by name, so don't guess. Report instead of silently diffing
    // (or silently ignoring) an arbitrary pairing.
    if (priors.length > 1 || curs.length > 1) {
      duplicateKeyWarnings.push({ key: k, priorCount: priors.length, currentCount: curs.length });
      continue;
    }

    const prev = priors[0];
    const cur = curs[0];
    if (cur && !prev) {
      addedCount++;
      busChanges.push({ busName: cur.busName || '(unnamed)', change: 'added', fields: [], maxPct: null });
      continue;
    }
    if (prev && !cur) {
      removedCount++;
      busChanges.push({ busName: prev.busName || '(unnamed)', change: 'removed', fields: [], maxPct: null });
      continue;
    }
    if (!prev || !cur) continue; // both empty — unreachable (key wouldn't exist), defensive only
    const fields = diffBus(prev, cur);
    if (fields.length) {
      changedCount++;
      const pcts = fields.map((f) => f.pct).filter((p): p is number => p != null);
      const busMax = pcts.length ? Math.max(...pcts) : null;
      if (busMax != null && (maxPctDelta == null || busMax > maxPctDelta)) maxPctDelta = busMax;
      busChanges.push({ busName: cur.busName || '(unnamed)', change: 'changed', fields, maxPct: busMax });
    }
  }

  // A duplicate-key group means SOME bus went undiffed — that can't honestly
  // read as "no material change," so it forces a review even with zero
  // detected field changes among the cleanly-matched buses.
  const materialChange = addedCount > 0 || removedCount > 0 || changedCount > 0 || duplicateKeyWarnings.length > 0;
  const reStudyRecommended = materialChange;

  return {
    hasPrior: true,
    comparedToIngestId: prior.id || null,
    comparedToConfirmedAt: prior.confirmedAt ?? null,
    addedCount, removedCount, changedCount, materialChange, reStudyRecommended, maxPctDelta,
    busChanges, duplicateKeyWarnings,
    summary: buildSummary({ addedCount, removedCount, changedCount, maxPctDelta, duplicateKeyWarnings }),
  };
}

function buildSummary(r: { addedCount: number; removedCount: number; changedCount: number; maxPctDelta: number | null; duplicateKeyWarnings: Array<{ key: string; priorCount: number; currentCount: number }> }): string {
  const dupNote = r.duplicateKeyWarnings.length
    ? ` ${r.duplicateKeyWarnings.length} bus name${r.duplicateKeyWarnings.length === 1 ? '' : 's'} (e.g. blank/duplicate names) could not be matched 1:1 between revisions and were excluded from the diff — verify those manually.`
    : '';
  if (!r.addedCount && !r.removedCount && !r.changedCount) {
    return r.duplicateKeyWarnings.length
      ? `No material change detected among the matchable buses vs the prior confirmed revision, but${dupNote}`
      : 'No material change vs the prior confirmed revision — the study still reflects the field.';
  }
  const parts: string[] = [];
  if (r.changedCount) parts.push(`${r.changedCount} bus${r.changedCount === 1 ? '' : 'es'} changed`);
  if (r.addedCount) parts.push(`${r.addedCount} added`);
  if (r.removedCount) parts.push(`${r.removedCount} removed`);
  const head = parts.join(', ');
  const pct = r.maxPctDelta != null ? ` (up to ${r.maxPctDelta}% off a modeled input)` : '';
  return `${head}${pct} vs the prior confirmed revision — re-study recommended.${dupNote}`;
}
