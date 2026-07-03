/**
 * Unit tests for Slice 4/4.5 mitigation recommendation + what-if ROI.
 */
import { recommendMitigations, estimateMitigationRoi, requiredArcRatingCalCm2 } from '../../lib/arcFlashMitigation';

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
    // danger here tracks incident energy (> 40 cal/cm2), not system voltage;
    // the MV-only options above are what voltage gates.
    expect(r.danger).toBe(false); // 15 cal/cm2 <= 40
  });

  test('every option carries a mechanism + caveat', () => {
    const r = recommendMitigations({ nominalVoltage: '480V', incidentEnergyCalCm2: 10, deviceType: 'breaker', tripUnitType: 'electronic_lsi' });
    for (const o of r.options) { expect(o.mechanism).toBeTruthy(); expect(o.caveat).toBeTruthy(); }
  });
});

// ServiceCycle deliberately does NOT compute NFPA 70E PPE categories (liability
// posture; see lib/arcFlashMitigation.ts). It reports the minimum required arc
// rating snapped UP to stocked garment tiers (4 / 8 / 25 / 40 cal/cm2).
describe('requiredArcRatingCalCm2', () => {
  test('snaps incident energy up to standard arc-rated garment tiers', () => {
    expect(requiredArcRatingCalCm2(0.5)).toBe(0); // < 1.2 -> no arc-rated clothing required
    expect(requiredArcRatingCalCm2(3)).toBe(4);
    expect(requiredArcRatingCalCm2(8)).toBe(8);
    expect(requiredArcRatingCalCm2(20)).toBe(25);
    expect(requiredArcRatingCalCm2(38)).toBe(40);
    expect(requiredArcRatingCalCm2(50)).toBeNull(); // > 40 -> de-energize; no PPE applies
    expect(requiredArcRatingCalCm2(null)).toBeNull();
  });
});

describe('estimateMitigationRoi', () => {
  test('reduction drops energy + clears the DANGER line + lowers required arc rating', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 52, estReductionPct: 60, mitigationCostUsd: 8000 });
    expect(r.ok).toBe(true);
    expect(r.ieAfterCalCm2).toBeCloseTo(20.8, 1);
    expect(r.ieDrivenDanger).toBe(true);
    expect(r.removesDanger).toBe(true);
    expect(r.requiredArcRatingBeforeCalCm2).toBeNull(); // >40 -> de-energize; no arc rating applies
    expect(r.requiredArcRatingAfterCalCm2).toBe(25);    // 20.8 -> next stocked tier (25 cal/cm2)
    expect(r.arcRatingReduced).toBe(false);             // before was null (no rating), not strictly reduced
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

  test('reduction within the same realm lowers the required arc rating', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 20, estReductionPct: 70 });
    expect(r.requiredArcRatingBeforeCalCm2).toBe(25); // 20 cal -> 25 cal tier
    expect(r.requiredArcRatingAfterCalCm2).toBe(8);   // 6 cal -> 8 cal tier
    expect(r.arcRatingReduced).toBe(true);
  });
});
