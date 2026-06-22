/**
 * Unit tests for Slice 4/4.5 mitigation recommendation + what-if ROI.
 */
import { recommendMitigations, estimateMitigationRoi, ppeCategoryFor } from '../../lib/arcFlashMitigation';

describe('recommendMitigations', () => {
  test('DANGER LV breaker bus -> energy-reduction options, excludes present ones', () => {
    const r = recommendMitigations({ nominalVoltage: '480V', incidentEnergyCalCm2: 52, deviceType: 'breaker', tripUnitType: 'electronic_lsig', ermsPresent: true });
    expect(r.danger).toBe(true);
    const keys = r.options.map((o: any) => o.key);
    expect(keys).not.toContain('maintenance_mode_erms'); // already present
    expect(keys).toContain('lower_instantaneous');
    expect(keys).toContain('zsi');
    expect(r.note).toMatch(/DANGER/);
  });

  test('MV bus surfaces differential + arc-resistant', () => {
    const r = recommendMitigations({ nominalVoltage: '13.8kV', incidentEnergyCalCm2: 15, deviceType: 'breaker', tripUnitType: 'electronic_lsig' });
    const keys = r.options.map((o: any) => o.key);
    expect(keys).toContain('differential_relay');
    expect(keys).toContain('arc_resistant');
    expect(r.danger).toBe(true); // >600 V
  });

  test('every option carries a mechanism + caveat', () => {
    const r = recommendMitigations({ nominalVoltage: '480V', incidentEnergyCalCm2: 10, deviceType: 'breaker', tripUnitType: 'electronic_lsi' });
    for (const o of r.options) { expect(o.mechanism).toBeTruthy(); expect(o.caveat).toBeTruthy(); }
  });
});

describe('ppeCategoryFor', () => {
  test('maps incident energy to NFPA 70E category bands', () => {
    expect(ppeCategoryFor(3)).toBe(1);
    expect(ppeCategoryFor(8)).toBe(2);
    expect(ppeCategoryFor(20)).toBe(3);
    expect(ppeCategoryFor(38)).toBe(4);
    expect(ppeCategoryFor(50)).toBeNull();
  });
});

describe('estimateMitigationRoi', () => {
  test('reduction drops energy + clears the DANGER line + improves PPE', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 52, estReductionPct: 60, mitigationCostUsd: 8000 });
    expect(r.ok).toBe(true);
    expect(r.ieAfterCalCm2).toBeCloseTo(20.8, 1);
    expect(r.removesDanger).toBe(true);
    expect(r.ppeBefore).toBeNull();      // >40 -> no category
    expect(r.ppeAfter).toBe(3);          // 20.8 -> Cat 3
    expect(r.ppeImproved).toBe(false);   // before was null (no category), not strictly improved by number
    expect(r.calReduced).toBeCloseTo(31.2, 1);
    expect(r.costPerCalReduced).toBeGreaterThan(0);
  });

  test('clamps reduction to 0-100 and handles no cost', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 10, estReductionPct: 150 });
    expect(r.estReductionPct).toBe(100);
    expect(r.ieAfterCalCm2).toBe(0);
    expect(r.costPerCalReduced).toBeNull();
  });

  test('no incident energy -> not ok', () => {
    expect(estimateMitigationRoi({ currentIeCalCm2: null, estReductionPct: 50 }).ok).toBe(false);
  });

  test('reduction within the same realm improves PPE category', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 20, estReductionPct: 70 });
    expect(r.ppeBefore).toBe(3);     // 20 cal -> Cat 3
    expect(r.ppeAfter).toBe(2);      // 6 cal -> Cat 2
    expect(r.ppeImproved).toBe(true);
  });
});
