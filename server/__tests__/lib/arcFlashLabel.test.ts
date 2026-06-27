/**
 * Unit tests for the Slice 3.5c label snapshot + printed-vs-current mismatch.
 */
import { labelSnapshot, computeLabelMismatch, shockApproachBoundaries, LABEL_FIELDS } from '../../lib/arcFlashLabel';

describe('labelSnapshot', () => {
  test('coerces decimals and keeps the canonical fields', () => {
    const s = labelSnapshot({ nominalVoltage: '480V', incidentEnergyCalCm2: '8.40', arcFlashBoundaryIn: 36, ppeCategory: 2, labelSeverity: 'warning', extra: 'ignored' });
    // [NETA-8-8] 480 V derives shock boundaries from NFPA 70E Table 130.4 (151–750 V band).
    expect(s).toEqual({
      nominalVoltage: '480V', incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: null,
      ppeCategory: 2, requiredArcRatingCalCm2: null, labelSeverity: 'warning',
      shockLimitedApproachIn: 42, shockRestrictedApproachIn: 12,
    });
    expect(Object.keys(s).sort()).toEqual([...LABEL_FIELDS].sort());
  });

  test('[NETA-8-8] a stored shock boundary overrides the Table 130.4 default', () => {
    const s = labelSnapshot({ nominalVoltage: '480V', shockLimitedApproachIn: 40, shockRestrictedApproachIn: 10 });
    expect(s.shockLimitedApproachIn).toBe(40);
    expect(s.shockRestrictedApproachIn).toBe(10);
  });
});

describe('shockApproachBoundaries (NFPA 70E Table 130.4)', () => {
  test('per-band values by nominal voltage', () => {
    expect(shockApproachBoundaries('480V')).toEqual({ limitedIn: 42, restrictedIn: 12, bandMaxVolts: 750 });
    expect(shockApproachBoundaries('13.8kV')).toEqual({ limitedIn: 60, restrictedIn: 26, bandMaxVolts: 15000 });
    expect(shockApproachBoundaries(208)).toEqual({ limitedIn: 42, restrictedIn: 12, bandMaxVolts: 750 });
    // 120 V: limited applies, restricted is "avoid contact" (null distance).
    expect(shockApproachBoundaries('120V')).toEqual({ limitedIn: 42, restrictedIn: null, bandMaxVolts: 150 });
  });
  test('outside the table (below 50 V / above 72.5 kV) yields no fabricated value', () => {
    expect(shockApproachBoundaries('24V')).toEqual({ limitedIn: null, restrictedIn: null, bandMaxVolts: null });
    expect(shockApproachBoundaries('115kV')).toEqual({ limitedIn: null, restrictedIn: null, bandMaxVolts: null });
    expect(shockApproachBoundaries(null)).toEqual({ limitedIn: null, restrictedIn: null, bandMaxVolts: null });
  });
});

describe('computeLabelMismatch', () => {
  const printed = { nominalVoltage: '480V', incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, workingDistanceIn: 18, ppeCategory: 2, requiredArcRatingCalCm2: 8, labelSeverity: 'warning' };

  test('identical current -> no mismatch (decimal-string equal)', () => {
    const r = computeLabelMismatch(printed, { ...printed, incidentEnergyCalCm2: '8.40' });
    expect(r.isMismatch).toBe(false);
    expect(r.changes).toHaveLength(0);
  });

  test('changed incident energy + severity -> flagged with both', () => {
    const r = computeLabelMismatch(printed, { ...printed, incidentEnergyCalCm2: 45, labelSeverity: 'danger' });
    expect(r.isMismatch).toBe(true);
    expect(r.changes.map(c => c.field).sort()).toEqual(['incidentEnergyCalCm2', 'labelSeverity']);
    const ie = r.changes.find(c => c.field === 'incidentEnergyCalCm2');
    expect(ie).toMatchObject({ printed: 8.4, current: 45 });
  });

  test('never-printed (empty snapshot) -> no mismatch', () => {
    expect(computeLabelMismatch(null, printed).isMismatch).toBe(false);
    expect(computeLabelMismatch({}, printed).isMismatch).toBe(false);
  });
});
