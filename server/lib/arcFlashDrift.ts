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
      maxPctDelta: null, busChanges: [],
      summary: 'No prior confirmed revision for this site — this is the baseline.',
    };
  }

  const priorByKey = new Map<string, any>();
  for (const b of prior.buses || []) priorByKey.set(busKey(b.busName), b);
  const curByKey = new Map<string, any>();
  for (const b of current.buses || []) curByKey.set(busKey(b.busName), b);

  const busChanges: BusDrift[] = [];
  let addedCount = 0, removedCount = 0, changedCount = 0;
  let maxPctDelta: number | null = null;

  // Added + changed (iterate current).
  for (const [k, cur] of curByKey) {
    const prev = priorByKey.get(k);
    if (!prev) {
      addedCount++;
      busChanges.push({ busName: cur.busName || '(unnamed)', change: 'added', fields: [], maxPct: null });
      continue;
    }
    const fields = diffBus(prev, cur);
    if (fields.length) {
      changedCount++;
      const pcts = fields.map((f) => f.pct).filter((p): p is number => p != null);
      const busMax = pcts.length ? Math.max(...pcts) : null;
      if (busMax != null && (maxPctDelta == null || busMax > maxPctDelta)) maxPctDelta = busMax;
      busChanges.push({ busName: cur.busName || '(unnamed)', change: 'changed', fields, maxPct: busMax });
    }
  }
  // Removed (in prior, gone from current).
  for (const [k, prev] of priorByKey) {
    if (!curByKey.has(k)) {
      removedCount++;
      busChanges.push({ busName: prev.busName || '(unnamed)', change: 'removed', fields: [], maxPct: null });
    }
  }

  const materialChange = addedCount > 0 || removedCount > 0 || changedCount > 0;
  const reStudyRecommended = materialChange;

  return {
    hasPrior: true,
    comparedToIngestId: prior.id || null,
    comparedToConfirmedAt: prior.confirmedAt ?? null,
    addedCount, removedCount, changedCount, materialChange, reStudyRecommended, maxPctDelta,
    busChanges,
    summary: buildSummary({ addedCount, removedCount, changedCount, maxPctDelta }),
  };
}

function buildSummary(r: { addedCount: number; removedCount: number; changedCount: number; maxPctDelta: number | null }): string {
  if (!r.addedCount && !r.removedCount && !r.changedCount) {
    return 'No material change vs the prior confirmed revision — the study still reflects the field.';
  }
  const parts: string[] = [];
  if (r.changedCount) parts.push(`${r.changedCount} bus${r.changedCount === 1 ? '' : 'es'} changed`);
  if (r.addedCount) parts.push(`${r.addedCount} added`);
  if (r.removedCount) parts.push(`${r.removedCount} removed`);
  const head = parts.join(', ');
  const pct = r.maxPctDelta != null ? ` (up to ${r.maxPctDelta}% off a modeled input)` : '';
  return `${head}${pct} vs the prior confirmed revision — re-study recommended.`;
}
