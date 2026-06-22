/**
 * Unit tests for the Slice 5 energized-work-permit generator + issuance gate.
 */
import { validatePermitIssuance, buildEnergizedWorkPermit } from '../../lib/arcFlashPermit';

const asOf = new Date('2026-06-22T00:00:00Z');
const bus = { busName: 'SWGR-1A', nominalVoltage: '480V', incidentEnergyCalCm2: 12, arcFlashBoundaryIn: 36, ppeCategory: 2, requiredArcRatingCalCm2: 8, workingDistanceIn: 18 };
const goodStudy = { performedDate: '2024-01-01', expiresAt: '2029-01-01', peName: 'A. Engineer', supersededById: null };

describe('validatePermitIssuance', () => {
  test('valid study -> canIssue', () => {
    const v = validatePermitIssuance(bus, goodStudy, asOf);
    expect(v.canIssue).toBe(true);
    expect(v.reasons).toHaveLength(0);
  });

  test('expired study blocks issuance', () => {
    const v = validatePermitIssuance(bus, { ...goodStudy, expiresAt: '2023-01-01' }, asOf);
    expect(v.canIssue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/expired/i);
  });

  test('superseded study blocks issuance', () => {
    const v = validatePermitIssuance(bus, { ...goodStudy, supersededById: 'x' }, asOf);
    expect(v.canIssue).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/superseded/i);
  });

  test('no study + no hazard data blocks issuance with two reasons', () => {
    const v = validatePermitIssuance({ busName: 'X' }, null, asOf);
    expect(v.canIssue).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildEnergizedWorkPermit', () => {
  test('pre-fills hazard data + flags hazard class + carries validation', () => {
    const p = buildEnergizedWorkPermit({ bus, study: goodStudy, asset: { equipmentType: 'SWITCHGEAR', site: { name: 'Riverside' } }, asOf });
    expect(p.equipment.busName).toBe('SWGR-1A');
    expect(p.equipment.site).toBe('Riverside');
    expect(p.hazard.incidentEnergyCalCm2).toBe(12);
    expect(p.hazard.hazardClass).toBe('WARNING');
    expect(p.standard).toMatch(/130.2/);
    expect(p.validation.canIssue).toBe(true);
    expect(Array.isArray(p.toComplete)).toBe(true);
  });

  test('DANGER class when incident energy > 40', () => {
    const p = buildEnergizedWorkPermit({ bus: { ...bus, incidentEnergyCalCm2: 55 }, study: goodStudy, asOf });
    expect(p.hazard.hazardClass).toBe('DANGER');
  });

  test('expired study yields a permit that cannot be issued', () => {
    const p = buildEnergizedWorkPermit({ bus, study: { ...goodStudy, expiresAt: '2023-01-01' }, asOf });
    expect(p.validation.canIssue).toBe(false);
  });
});
