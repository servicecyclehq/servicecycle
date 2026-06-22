/**
 * lib/arcFlashRiskScore.ts — Slice 10: a deterministic arc-flash portfolio /
 * insurer risk-score, plus privacy-safe benchmark helpers.
 *
 * The score (0-100, higher = SAFER, like a credit score) summarizes an account's
 * arc-flash posture for an insurer / executive: how much equipment carries a
 * current label (coverage), how much of it is in the DANGER class, and how much
 * of the study base has expired. Deterministic + explainable (factors returned).
 *
 * The benchmark side is AGGREGATE-ONLY and k-anonymized: the network distribution
 * is computed from per-account ratios but never exposes any single account's data,
 * and is withheld entirely until at least K accounts contribute. SC never reveals
 * who is in the network — only where you sit in the distribution.
 */

'use strict';

export const BENCHMARK_MIN_ACCOUNTS = 5; // k-anonymity floor

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }

export interface RiskInput { labelledBuses: number; dangerBuses: number; totalStudies: number; expiredStudies: number; }

/**
 * Deterministic 0-100 safety score (higher = lower risk). Pure.
 *  - DANGER ratio (up to -45): share of labelled buses in the DANGER class.
 *  - Expired-study ratio (up to -35): share of the study base past expiry.
 *  - Coverage floor (up to -20): no labelled equipment at all is itself a risk
 *    (unknown hazard), so a zero-coverage account is penalized, not rewarded.
 */
export function computeRiskScore(input: RiskInput): { score: number; band: 'low' | 'moderate' | 'high'; factors: any[]; dangerRatio: number } {
  const labelled = Math.max(0, Number(input.labelledBuses) || 0);
  const danger = Math.max(0, Number(input.dangerBuses) || 0);
  const studies = Math.max(0, Number(input.totalStudies) || 0);
  const expired = Math.max(0, Number(input.expiredStudies) || 0);

  const dangerRatio = labelled > 0 ? danger / labelled : 0;
  const expiredRatio = studies > 0 ? expired / studies : 0;

  const dangerPenalty = Math.round(dangerRatio * 45);
  const expiredPenalty = Math.round(expiredRatio * 35);
  const coveragePenalty = labelled === 0 ? 20 : 0;

  const score = clamp(100 - dangerPenalty - expiredPenalty - coveragePenalty, 0, 100);
  const band: 'low' | 'moderate' | 'high' = score >= 80 ? 'low' : score >= 55 ? 'moderate' : 'high';

  const factors = [
    { key: 'danger', label: 'DANGER exposure', penalty: dangerPenalty, detail: labelled > 0 ? `${Math.round(dangerRatio * 100)}% of ${labelled} labelled buses are DANGER` : 'No labelled buses' },
    { key: 'expired', label: 'Expired studies', penalty: expiredPenalty, detail: studies > 0 ? `${expired} of ${studies} studies expired` : 'No studies on record' },
    { key: 'coverage', label: 'Label coverage', penalty: coveragePenalty, detail: labelled === 0 ? 'No arc-flash labels — unknown hazard' : `${labelled} labelled buses` },
  ];

  return { score, band, factors, dangerRatio };
}

function percentile(sorted: number[], v: number): number {
  if (!sorted.length) return 0;
  let below = 0;
  for (const x of sorted) if (x < v) below++;
  return Math.round((below / sorted.length) * 100);
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

/**
 * Build the anonymized network benchmark from each account's DANGER ratio.
 * `ratios` = every contributing account's danger ratio (0..1). `yours` = the
 * requesting account's ratio. Returns null (withheld) below the k-anon floor.
 * Emits ONLY aggregates — never any per-account value or identity. Pure.
 */
export function buildBenchmark(ratios: number[], yours: number): any {
  const valid = (ratios || []).filter((r) => Number.isFinite(r));
  if (valid.length < BENCHMARK_MIN_ACCOUNTS) {
    return { available: false, accountCount: valid.length, minAccounts: BENCHMARK_MIN_ACCOUNTS };
  }
  const sorted = valid.slice().sort((a, b) => a - b);
  // Lower danger ratio is better -> a SAFER percentile = share of accounts with a
  // HIGHER (worse) ratio than yours.
  const worseThanYou = sorted.filter((r) => r > yours).length;
  return {
    available: true,
    accountCount: sorted.length,
    medianDangerPct: Math.round(quantile(sorted, 0.5) * 100),
    p25DangerPct: Math.round(quantile(sorted, 0.25) * 100),
    p75DangerPct: Math.round(quantile(sorted, 0.75) * 100),
    yourDangerPct: Math.round(yours * 100),
    yourSafetyPercentile: Math.round((worseThanYou / sorted.length) * 100), // higher = safer than more of the network
    rawPercentile: percentile(sorted, yours),
  };
}
