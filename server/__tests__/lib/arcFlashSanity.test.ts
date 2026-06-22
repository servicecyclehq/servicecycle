/**
 * Unit tests for the Slice 2.8c contradiction / sanity-check engine. Pure logic.
 */
import { checkBusContradictions, checkSystemContradictions } from '../../lib/arcFlashSanity';

function codes(findings: any[]) { return findings.map((f) => f.code); }

describe('checkBusContradictions — physical impossibilities (errors)', () => {
  test('arcing current > bolted fault current', () => {
    const f = checkBusContradictions({ busName: 'B1', boltedFaultCurrentKA: 20, arcingCurrentKA: 25 });
    expect(codes(f)).toContain('arcing_gt_bolted');
    expect(f.find((x) => x.code === 'arcing_gt_bolted')?.severity).toBe('error');
  });

  test('reduced arcing current > arcing current', () => {
    const f = checkBusContradictions({ busName: 'B1', arcingCurrentKA: 10, arcingCurrentReducedKA: 12 });
    expect(codes(f)).toContain('reduced_gt_arcing');
  });

  test('required arc rating below incident energy', () => {
    const f = checkBusContradictions({ busName: 'B1', incidentEnergyCalCm2: 12, requiredArcRatingCalCm2: 8 });
    expect(codes(f)).toContain('arc_rating_below_ie');
  });

  test('a clean bus produces no findings', () => {
    const f = checkBusContradictions({ busName: 'B1', boltedFaultCurrentKA: 25, arcingCurrentKA: 18, incidentEnergyCalCm2: 6, requiredArcRatingCalCm2: 8, ppeCategory: 2, clearingTimeMs: 80 });
    expect(f).toHaveLength(0);
  });
});

describe('checkBusContradictions — PPE category vs incident energy', () => {
  test('Cat 1 cannot cover 12 cal/cm^2', () => {
    const f = checkBusContradictions({ busName: 'B1', incidentEnergyCalCm2: 12, ppeCategory: 1 });
    expect(codes(f)).toContain('ppe_under_ie');
    expect(f.find((x) => x.code === 'ppe_under_ie')?.severity).toBe('error');
  });

  test('IE > 40 with any PPE category is dangerous (no category applies)', () => {
    const f = checkBusContradictions({ busName: 'B1', incidentEnergyCalCm2: 55, ppeCategory: 4 });
    expect(codes(f)).toContain('ppe_above_cat4');
  });

  test('Cat 3 covers 20 cal/cm^2 -> no finding', () => {
    const f = checkBusContradictions({ busName: 'B1', incidentEnergyCalCm2: 20, ppeCategory: 3 });
    expect(codes(f)).not.toContain('ppe_under_ie');
  });
});

describe('checkBusContradictions — settings/device + plausibility (warnings)', () => {
  test('trip settings on a fuse is flagged', () => {
    const f = checkBusContradictions({ busName: 'B1', deviceType: 'fuse', deviceSettings: { lt: 0.9 } });
    expect(codes(f)).toContain('settings_without_trip_unit');
  });

  test('trip settings on an electronic LSIG breaker is fine', () => {
    const f = checkBusContradictions({ busName: 'B1', deviceType: 'breaker', tripUnitType: 'electronic_lsig', deviceSettings: { lt: 0.9 } });
    expect(codes(f)).not.toContain('settings_without_trip_unit');
  });

  test('incident energy without inputs is flagged', () => {
    const f = checkBusContradictions({ busName: 'B1', incidentEnergyCalCm2: 8 });
    expect(codes(f)).toContain('ie_without_inputs');
  });

  test('implausible clearing time is flagged', () => {
    expect(codes(checkBusContradictions({ busName: 'B1', clearingTimeMs: 5000 }))).toContain('clearing_implausible');
    expect(codes(checkBusContradictions({ busName: 'B1', clearingTimeMs: 0 }))).toContain('clearing_implausible');
  });

  test('bus fault current exceeding utility source max is flagged', () => {
    const f = checkBusContradictions({ busName: 'B1', boltedFaultCurrentKA: 50 }, { utilityMaxFaultKA: 40 });
    expect(codes(f)).toContain('bus_fault_gt_source');
  });
});

describe('checkSystemContradictions — cross-bus + rollup', () => {
  test('downstream device rated higher than upstream is flagged', () => {
    const buses = [
      { busName: 'SWGR-1A', deviceRatingA: 1200 },
      { busName: 'MCC-7', fedFromBusName: 'SWGR-1A', deviceRatingA: 2000 },
    ];
    const r = checkSystemContradictions(buses, {});
    expect(codes(r.findings)).toContain('downstream_over_upstream');
    expect(r.warningCount).toBeGreaterThanOrEqual(1);
  });

  test('proper coordination produces no cross-bus finding', () => {
    const buses = [
      { busName: 'SWGR-1A', deviceRatingA: 2000 },
      { busName: 'MCC-7', fedFromBusName: 'SWGR-1A', deviceRatingA: 800 },
    ];
    const r = checkSystemContradictions(buses, {});
    expect(codes(r.findings)).not.toContain('downstream_over_upstream');
  });

  test('rollup counts errors and warnings and threads the utility source', () => {
    const buses = [
      { busName: 'B1', boltedFaultCurrentKA: 20, arcingCurrentKA: 25 }, // error
      { busName: 'B2', boltedFaultCurrentKA: 60 }, // warning (> source)
    ];
    const r = checkSystemContradictions(buses, { utility: { maxFaultKA: 40 } });
    expect(r.errorCount).toBe(1);
    expect(r.warningCount).toBeGreaterThanOrEqual(1);
  });
});
