// v8 acquisition-readiness — arc-flash safety audit-trail slice (FIX AGENT 1).
// Pure-function coverage for the behavior changes that carry liability weight:
//   - LEGAL-8-12: the permit issuance gate must block on an unreviewed system
//     change (drift) since the study, not just on date/supersession.
//   - DEMO-8-9: the mitigation what-if must distinguish an incident-energy-driven
//     DANGER (clearable by reducing energy) from a voltage-driven DANGER (not
//     clearable by reducing energy) so the ROI headline is honest.
const { validatePermitIssuance, buildEnergizedWorkPermit } = require('../lib/arcFlashPermit');
const { estimateMitigationRoi } = require('../lib/arcFlashMitigation');

describe('[LEGAL-8-12] permit issuance gate — unreviewed system-change drift', () => {
  const okStudy = { performedDate: '2025-01-01', expiresAt: '2030-01-01' };
  const okBus = { busName: 'SWGR-1A', incidentEnergyCalCm2: 12, nominalVoltage: '480V' };

  test('canIssue=true for a valid current study with no drift (back-compat, opts omitted)', () => {
    const v = validatePermitIssuance(okBus, okStudy, new Date('2026-06-01'));
    expect(v.canIssue).toBe(true);
    expect(v.unreviewedDrift).toBe(false);
    expect(v.reasons).toHaveLength(0);
  });

  test('unreviewed drift blocks issuance and surfaces a reason', () => {
    const v = validatePermitIssuance(okBus, okStudy, new Date('2026-06-01'), {
      unreviewedDrift: true,
      driftReason: 'Device setting collected after the study date.',
    });
    expect(v.canIssue).toBe(false);
    expect(v.unreviewedDrift).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/Device setting collected after the study date/);
  });

  test('buildEnergizedWorkPermit threads drift into validation and downgrades canIssue', () => {
    const permit = buildEnergizedWorkPermit({
      bus: okBus, study: okStudy, asset: { equipmentType: 'SWITCHGEAR', site: { name: 'Riverside' } },
      unreviewedDrift: true,
    });
    expect(permit.validation.canIssue).toBe(false);
    expect(permit.validation.unreviewedDrift).toBe(true);
  });
});

describe('[DEMO-8-9] mitigation what-if — IE-driven vs voltage-driven DANGER', () => {
  test('voltage-driven DANGER bus (IE already <40) can never "remove DANGER", but PPE improves', () => {
    // 19.6 cal/cm2 bus that is DANGER only because of 13.8 kV (>600 V): reducing
    // incident energy cannot clear the DANGER label, so removesDanger stays false
    // and ieDrivenDanger is false — the UI shows the PPE drop instead.
    const r = estimateMitigationRoi({ currentIeCalCm2: 19.6, estReductionPct: 60 });
    expect(r.ok).toBe(true);
    expect(r.ieDrivenDanger).toBe(false);
    expect(r.removesDanger).toBe(false);
    expect(r.ieAfterCalCm2).toBeCloseTo(7.84, 2);
    expect(r.ppeImproved).toBe(true); // 19.6 (PPE 3) -> 7.84 (PPE 2)
  });

  test('incident-energy-driven DANGER bus (IE>40) can clear DANGER with a real reduction', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 55, estReductionPct: 50 });
    expect(r.ieDrivenDanger).toBe(true);
    expect(r.ieAfterCalCm2).toBeCloseTo(27.5, 2);
    expect(r.removesDanger).toBe(true); // 55 -> 27.5 crosses the >40 line
  });

  test('IE>40 with too-small a reduction does not falsely clear DANGER', () => {
    const r = estimateMitigationRoi({ currentIeCalCm2: 55, estReductionPct: 10 });
    expect(r.ieDrivenDanger).toBe(true);
    expect(r.ieAfterCalCm2).toBeCloseTo(49.5, 2);
    expect(r.removesDanger).toBe(false);
  });
});
