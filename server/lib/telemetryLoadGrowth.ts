'use strict';

/**
 * telemetryLoadGrowth.ts — derive a load-growth signal from continuous
 * condition-monitoring telemetry, to flag when an arc-flash study may need
 * re-evaluating (NFPA 70E §130.5: review when load changes alter incident
 * energy). LIGHT + in-lane: SC surfaces the signal and raises a flag; it never
 * recomputes incident energy (that's the IEEE 1584 study / a PE). Pure helpers.
 */

const LOAD_UNITS = ['a', 'ka', 'ma', 'amp', 'amps', 'amperes', 'kw', 'mw', 'kva', 'mva'];

// Is this channel measuring electrical load (vs temperature, vibration, etc.)?
function isLoadChannel(ch: any): boolean {
  const u = String(ch?.unit || '').trim().toLowerCase();
  if (LOAD_UNITS.includes(u)) return true;
  const text = `${ch?.key || ''} ${ch?.label || ''}`.toLowerCase();
  return /(^|[^a-z])(load|current|amp|amps|demand|kw|kva)([^a-z]|$)/.test(text);
}

function avg(nums: number[]): number | null {
  const f = nums.filter((n) => Number.isFinite(n));
  return f.length ? f.reduce((s, n) => s + n, 0) / f.length : null;
}
function round(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Estimate sustained load growth from a reading series by comparing the oldest
 * window's average against the newest window's average. Pure.
 * @param readings [{ value, recordedAt }] (any order)
 * @param opts { windowSize=5, minReadings=6 }
 * Returns { ok, baseline, current, growthPct, readingCount } or { ok:false, reason }.
 */
function assessLoadGrowth(readings: any[], opts: any = {}): any {
  const win = opts.windowSize || 5;
  const minReadings = opts.minReadings || 6;
  const list = (readings || [])
    .map((r: any) => ({ value: Number(r.value), t: new Date(r.recordedAt).getTime() }))
    .filter((r: any) => Number.isFinite(r.value) && Number.isFinite(r.t))
    .sort((a: any, b: any) => a.t - b.t);
  if (list.length < minReadings) return { ok: false, reason: 'insufficient data', readingCount: list.length };
  const baseline = avg(list.slice(0, win).map((r: any) => r.value));
  const current = avg(list.slice(-win).map((r: any) => r.value));
  if (baseline == null || current == null || baseline <= 0) return { ok: false, reason: 'no usable baseline', readingCount: list.length };
  const growthPct = Math.round(((current - baseline) / baseline) * 1000) / 10;
  return { ok: true, baseline: round(baseline), current: round(current), growthPct, readingCount: list.length };
}

module.exports = { isLoadChannel, assessLoadGrowth, LOAD_UNITS };

export {};
