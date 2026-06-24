/**
 * Unit tests for the Slice 10 risk-score + anonymized benchmark.
 */
import { computeRiskScore, buildBenchmark, BENCHMARK_MIN_ACCOUNTS, INCIDENT_MAX_PENALTY } from '../../lib/arcFlashRiskScore';

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

  test('incidents factor absent when incidents omitted', () => {
    const r = computeRiskScore({ labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0 });
    const incFactor = r.factors.find(f => f.key === 'incidents')!;
    expect(incFactor).toBeDefined();
    expect(incFactor.penalty).toBe(0);
    expect(incFactor.detail).toBe('No open incidents');
  });

  test('injury incident subtracts 6 pts per injury', () => {
    const base = computeRiskScore({ labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0 });
    const with1Injury = computeRiskScore({
      labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0,
      incidents: { openWithInjury: 1, openNoInjury: 0 },
    });
    expect(base.score - with1Injury.score).toBe(6);
    expect(with1Injury.factors.find(f => f.key === 'incidents')!.penalty).toBe(6);
  });

  test('non-injury incident subtracts 2 pts each', () => {
    const r = computeRiskScore({
      labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0,
      incidents: { openWithInjury: 0, openNoInjury: 3 },
    });
    expect(r.factors.find(f => f.key === 'incidents')!.penalty).toBe(6); // 3 * 2
  });

  test('incident penalty capped at INCIDENT_MAX_PENALTY (15)', () => {
    const r = computeRiskScore({
      labelledBuses: 20, dangerBuses: 0, totalStudies: 3, expiredStudies: 0,
      incidents: { openWithInjury: 10, openNoInjury: 20 }, // would be 10*6+20*2=100 without cap
    });
    const incFactor = r.factors.find(f => f.key === 'incidents')!;
    expect(incFactor.penalty).toBe(INCIDENT_MAX_PENALTY);
    expect(incFactor.penalty).toBe(15);
  });

  test('already-high-risk account is not pushed below 0', () => {
    const r = computeRiskScore({
      labelledBuses: 10, dangerBuses: 10, totalStudies: 4, expiredStudies: 4,
      incidents: { openWithInjury: 5, openNoInjury: 5 },
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test('incident detail string describes open counts', () => {
    const r = computeRiskScore({
      labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0,
      incidents: { openWithInjury: 1, openNoInjury: 2 },
    });
    const detail = r.factors.find(f => f.key === 'incidents')!.detail as string;
    expect(detail).toContain('3 open incident');
    expect(detail).toContain('1 with injury');
    expect(detail).toContain('2 without injury');
  });

  test('closing all incidents restores score to no-incident baseline', () => {
    const base = computeRiskScore({ labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0 });
    const withIncidents = computeRiskScore({
      labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0,
      incidents: { openWithInjury: 2, openNoInjury: 1 },
    });
    const allClosed = computeRiskScore({
      labelledBuses: 10, dangerBuses: 0, totalStudies: 2, expiredStudies: 0,
      incidents: { openWithInjury: 0, openNoInjury: 0 }, // incidents present but all closed
    });
    expect(withIncidents.score).toBeLessThan(base.score);
    expect(allClosed.score).toBe(base.score); // penalty clears when all closed
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
