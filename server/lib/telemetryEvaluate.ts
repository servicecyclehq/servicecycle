/**
 * lib/telemetryEvaluate.ts -- Phase 4 #8 pure reading grader.
 *
 * Grades a continuous-monitoring sample against a channel's warn/crit bands.
 * Bands come in HIGH and LOW pairs so one model handles "higher is worse"
 * (temperature, vibration, partial discharge) and "lower is worse" (insulation
 * resistance, oil level). A reading is graded to the WORST band it trips.
 *
 * Pure + DB-free so the threshold logic is unit-testable in isolation.
 */

'use strict';

export type TelemetryStatus = 'OK' | 'WARN' | 'CRIT';

const RANK: Record<TelemetryStatus, number> = { OK: 0, WARN: 1, CRIT: 2 };

/** Worst (highest-rank) of two statuses. */
function worseStatus(a: TelemetryStatus, b: TelemetryStatus): TelemetryStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Coerce a Prisma Decimal | number | string | null to a finite number or null. */
function num(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface ChannelThresholds {
  warnHigh?: any; critHigh?: any; warnLow?: any; critLow?: any;
}

export interface Grade {
  status: TelemetryStatus;
  thresholdKind: 'warnHigh' | 'critHigh' | 'warnLow' | 'critLow' | null;
  threshold: number | null;
}

/**
 * Grade one value. Evaluates the high side and the low side independently and
 * returns the worse of the two (with the band that produced it). When nothing
 * is tripped, returns OK with no threshold.
 */
function gradeReading(value: any, channel: ChannelThresholds): Grade {
  const v = num(value);
  if (v === null) return { status: 'OK', thresholdKind: null, threshold: null };

  const warnHigh = num(channel.warnHigh);
  const critHigh = num(channel.critHigh);
  const warnLow  = num(channel.warnLow);
  const critLow  = num(channel.critLow);

  let best: Grade = { status: 'OK', thresholdKind: null, threshold: null };

  // High side: higher is worse.
  if (critHigh !== null && v >= critHigh)      best = pick(best, { status: 'CRIT', thresholdKind: 'critHigh', threshold: critHigh });
  else if (warnHigh !== null && v >= warnHigh) best = pick(best, { status: 'WARN', thresholdKind: 'warnHigh', threshold: warnHigh });

  // Low side: lower is worse.
  if (critLow !== null && v <= critLow)        best = pick(best, { status: 'CRIT', thresholdKind: 'critLow', threshold: critLow });
  else if (warnLow !== null && v <= warnLow)   best = pick(best, { status: 'WARN', thresholdKind: 'warnLow', threshold: warnLow });

  return best;
}

/** Keep whichever grade is worse; ties keep the existing one. */
function pick(a: Grade, b: Grade): Grade {
  return RANK[b.status] > RANK[a.status] ? b : a;
}

module.exports = { gradeReading, worseStatus: worseStatus, RANK };

export { gradeReading, worseStatus, RANK };
