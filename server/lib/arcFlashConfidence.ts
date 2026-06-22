/**
 * lib/arcFlashConfidence.ts — Slice 2.8a: per-bus arc-flash CONFIDENCE / TRUST
 * score (0-100, fully DETERMINISTIC).
 *
 * The gap engine (lib/arcFlashGap.ts) answers "can the engineer RUN the study
 * yet?" — readiness blocked/defaultable/ready over the INPUTS. This module answers
 * the different question the field actually asks of an existing label: "how much
 * should I TRUST this bus's posted arc-flash result TODAY?" It blends four
 * deterministic factors, each with an explicit weight (returned in `factors` so
 * the UI can show the why):
 *
 *   completeness (40) — are the IEEE 1584 inputs actually captured (vs defaulted /
 *                       missing)? Reuses analyzeBusGaps so the two stay consistent.
 *   studyAge     (30) — how fresh is the bound study? NFPA 70E 130.5 recommends a
 *                       re-evaluation at least every 5 years; expired / none = 0.
 *   verification (20) — was the upstream device FIELD-verified (door opened + read,
 *                       or photo) vs typed-in / imported / absent?
 *   drift        (10) — any NETA as-found != as-left or study-mismatch flag (stale
 *                       settings) zeroes this AND caps the band below green.
 *
 * Deterministic per engineering-guidelines #7 — never an LLM self-score. SC is the
 * DATA layer; a licensed PE still runs + stamps the study. A high score means the
 * captured data is fresh and verified, NOT that the calculation is certified.
 */

'use strict';

import { analyzeBusGaps } from './arcFlashGap';

export const CONFIDENCE_WEIGHTS = { completeness: 40, studyAge: 30, verification: 20, drift: 10 };
// NFPA 70E 130.5: arc-flash risk assessment reviewed at least every 5 years.
export const RE_EVAL_YEARS = 5;
// Field-verified provenance is worth more than typed-in or imported data.
const VERIFICATION_POINTS: Record<string, number> = { field: 20, photo: 16, manual: 10, import: 6 };
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export interface ConfidenceInput {
  bus: any; // IEEE 1584 input fields (analyzeBusGaps shape)
  study?: { performedDate?: any; expiresAt?: any; superseded?: boolean } | null;
  deviceSource?: string | null; // best device provenance: field|photo|manual|import
  driftFlagged?: boolean;
  asOf?: Date;
}

export interface ConfidenceFactor { key: string; label: string; points: number; max: number; detail: string; }
export interface ConfidenceResult { score: number; band: 'green' | 'yellow' | 'red'; capped: boolean; factors: ConfidenceFactor[]; summary: string; }

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

function toDate(v: any): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

// 40 pts: 30 across the three must-obtain inputs (present only), 10 across the
// three typicals (present full / IEEE-defaulted half / missing none).
function scoreCompleteness(bus: any) {
  const g = analyzeBusGaps(bus || {});
  const fields: any[] = Array.isArray(g.fields) ? g.fields : [];
  const musts = fields.filter((f) => f.category === 'must_obtain');
  const mustMax = musts.length || 3;
  const mustPresent = musts.filter((f) => f.status === 'present').length;
  const mustPts = (mustPresent / mustMax) * 30;

  const typ = fields.filter((f) => f.category === 'typical');
  const typMax = typ.length || 3;
  let typRaw = 0;
  for (const f of typ) { if (f.status === 'present') typRaw += 1; else if (f.status === 'defaulted') typRaw += 0.5; }
  const typPts = (typRaw / typMax) * 10;

  return { points: mustPts + typPts, mustPresent, mustMax, readiness: g.readiness };
}

function scoreStudyAge(study: ConfidenceInput['study'], asOf: Date) {
  if (!study) return { points: 0, detail: 'No bound study' };
  if (study.superseded) return { points: 0, detail: 'Latest study superseded' };
  const perf = toDate(study.performedDate);
  if (!perf) return { points: 0, detail: 'Study date unknown' };
  const exp = toDate(study.expiresAt);
  if (exp && asOf.getTime() > exp.getTime()) return { points: 0, detail: 'Study expired' };
  const ageYears = (asOf.getTime() - perf.getTime()) / MS_PER_YEAR;
  if (ageYears >= RE_EVAL_YEARS) return { points: 0, detail: `Study ${ageYears.toFixed(1)} yr old (>= ${RE_EVAL_YEARS} yr re-eval)` };
  const eff = Math.max(0, ageYears); // a future-dated study counts as brand new
  const pts = clamp(CONFIDENCE_WEIGHTS.studyAge * (1 - eff / RE_EVAL_YEARS), 0, CONFIDENCE_WEIGHTS.studyAge);
  return { points: pts, detail: eff < 1 ? 'Study < 1 yr old' : `Study ${eff.toFixed(1)} yr old` };
}

function scoreVerification(src: any) {
  const s = String(src || '').toLowerCase();
  const p = VERIFICATION_POINTS[s] ?? 0;
  if (!p) return { points: 0, detail: 'No field-verified device' };
  return { points: p, detail: `Device ${s}-verified` };
}

function scoreDrift(driftFlagged: boolean) {
  return driftFlagged ? { points: 0, detail: 'Device-setting drift flagged' } : { points: CONFIDENCE_WEIGHTS.drift, detail: 'No drift flagged' };
}

function buildSummary(score: number, band: string, factors: ConfidenceFactor[], capped: boolean): string {
  const label = band === 'green' ? 'high' : band === 'yellow' ? 'moderate' : 'low';
  const weak = factors
    .filter((f) => f.points < f.max)
    .sort((a, b) => (b.max - b.points) - (a.max - a.points))
    .slice(0, 2);
  const why = weak.length ? ' — ' + weak.map((f) => f.detail).join('; ') : '';
  return `${score}% ${label} confidence${capped ? ' (capped by drift)' : ''}${why}.`;
}

/**
 * Deterministic per-bus confidence score. Pure: no DB, no clock except asOf.
 */
export function scoreBusConfidence(input: ConfidenceInput): ConfidenceResult {
  const asOf = input.asOf instanceof Date ? input.asOf : new Date();
  const comp = scoreCompleteness(input.bus || {});
  const age = scoreStudyAge(input.study || null, asOf);
  const ver = scoreVerification(input.deviceSource);
  const driftFlagged = !!input.driftFlagged;
  const drift = scoreDrift(driftFlagged);

  const raw = comp.points + age.points + ver.points + drift.points;
  const score = Math.round(clamp(raw, 0, 100));

  let band: 'green' | 'yellow' | 'red' = score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red';
  let capped = false;
  if (driftFlagged && band === 'green') { band = 'yellow'; capped = true; }

  const factors: ConfidenceFactor[] = [
    { key: 'completeness', label: 'Input data completeness', points: Math.round(comp.points), max: CONFIDENCE_WEIGHTS.completeness, detail: `${comp.mustPresent}/${comp.mustMax} required inputs captured (${comp.readiness})` },
    { key: 'studyAge', label: 'Study freshness', points: Math.round(age.points), max: CONFIDENCE_WEIGHTS.studyAge, detail: age.detail },
    { key: 'verification', label: 'Field verification', points: Math.round(ver.points), max: CONFIDENCE_WEIGHTS.verification, detail: ver.detail },
    { key: 'drift', label: 'Setting drift', points: Math.round(drift.points), max: CONFIDENCE_WEIGHTS.drift, detail: drift.detail },
  ];

  return { score, band, capped, factors, summary: buildSummary(score, band, factors, capped) };
}

/**
 * Pick the most-trusted device provenance from a set of collected devices:
 * field > photo > manual > import. Returns null if none.
 */
export function pickDeviceSource(devices: any[]): string | null {
  const order = ['field', 'photo', 'manual', 'import'];
  let best: string | null = null;
  let bi = order.length;
  for (const d of devices || []) {
    const i = order.indexOf(String(d && d.source || '').toLowerCase());
    if (i >= 0 && i < bi) { bi = i; best = order[i]; }
  }
  return best;
}
