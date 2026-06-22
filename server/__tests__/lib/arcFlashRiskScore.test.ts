/**
 * Unit tests for the Slice 10 risk-score + anonymized benchmark.
 */
import { computeRiskScore, buildBenchmark, BENCHMARK_MIN_ACCOUNTS } from '../../lib/arcFlashRiskScore';

describe('computeRiskScore', () => {
  test('fully labelled, no DANGER, no expired -> low risk ~100', () => {
    const r = computeRiskScore({ labelledBuses: 40, dangerBuses: 0, totalStudies: 5, expiredStudies: 0 });
    expect(r.score).toBe(100);
    expect(r.band).toBe('low');
  });

  test('high DANGER share + expired studies -> high risk', () => {
    const r = computeRiskScore({ labelledBuses: 20, dangerBuses: 14, totalStudies: 4, expiredStudies: 3 });
    expect(r.score).toBeLessThan(55);
    expect(r.band).toBe('high');
    expect(r.dangerRatio).toBeCloseTo(0.7, 1);
  });

  test('zero coverage is penalized, not rewarded', () => {
    const r = computeRiskScore({ labelledBuses: 0, dangerBuses: 0, totalStudies: 0, expiredStudies: 0 });
    expect(r.score).toBe(80); // 100 - 20 coverage penalty
    expect(r.factors.find(f => f.key === 'coverage')?.penalty).toBe(20);
  });
});

describe('buildBenchmark — k-anonymity + aggregates only', () => {
  test('withheld below the k-anon floor', () => {
    const b = buildBenchmark([0.1, 0.2], 0.15);
    expect(b.available).toBe(false);
    expect(b.minAccounts).toBe(BENCHMARK_MIN_ACCOUNTS);
  });

  test('emits only aggregates above the floor + a safety percentile', () => {
    const ratios = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    const b = buildBenchmark(ratios, 0.2);
    expect(b.available).toBe(true);
    expect(b.accountCount).toBe(7);
    expect(b).toHaveProperty('medianDangerPct');
    // no per-account values leak
    expect(b).not.toHaveProperty('ratios');
    // 0.2 is safer than the 4 accounts at 0.3..0.6 -> ~57th safety percentile
    expect(b.yourSafetyPercentile).toBeGreaterThan(50);
    expect(b.yourDangerPct).toBe(20);
  });

  test('the safest account ranks near the top', () => {
    const ratios = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const b = buildBenchmark(ratios, 0.0);
    expect(b.yourSafetyPercentile).toBeGreaterThanOrEqual(80);
  });
});
