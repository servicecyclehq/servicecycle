/**
 * Unit tests for the Slice 2.8b drift engine — material-change detection between
 * a new ingest revision and the prior confirmed one. Pure logic, no DB.
 */
import { diffIngestRevisions, NUMERIC_MATERIAL_PCT } from '../../lib/arcFlashDrift';

const busA = {
  busName: 'MCC-7', equipmentTypeGuess: 'MCC', nominalVoltage: '480V',
  boltedFaultCurrentKA: 25, clearingTimeMs: 80, deviceType: 'breaker', tripUnitType: 'electronic_lsig',
  deviceRatingA: 800, deviceSettings: { lt: 0.9, st: 6 }, fedFromBusName: 'SWGR-1A',
};

function rev(buses: any[], extra: any = {}) { return { id: 'ing_prior', confirmedAt: '2025-01-01T00:00:00Z', buses, ...extra }; }

describe('diffIngestRevisions — baseline', () => {
  test('no prior revision -> baseline, no material change', () => {
    const r = diffIngestRevisions(null, { buses: [busA] });
    expect(r.hasPrior).toBe(false);
    expect(r.materialChange).toBe(false);
    expect(r.reStudyRecommended).toBe(false);
    expect(r.summary).toMatch(/baseline/i);
  });

  test('identical revisions -> no material change', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA }] });
    expect(r.materialChange).toBe(false);
    expect(r.changedCount).toBe(0);
    expect(r.summary).toMatch(/no material change/i);
  });
});

describe('diffIngestRevisions — added / removed buses', () => {
  test('a new bus is flagged added + material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [busA, { busName: 'MCC-8', nominalVoltage: '480V' }] });
    expect(r.addedCount).toBe(1);
    expect(r.materialChange).toBe(true);
    expect(r.busChanges.find((b) => b.change === 'added')?.busName).toBe('MCC-8');
  });

  test('a dropped bus is flagged removed + material', () => {
    const r = diffIngestRevisions(rev([busA, { busName: 'MCC-8' }]), { buses: [busA] });
    expect(r.removedCount).toBe(1);
    expect(r.materialChange).toBe(true);
  });

  test('bus matching is case/whitespace insensitive', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, busName: '  mcc-7 ' }] });
    expect(r.addedCount).toBe(0);
    expect(r.removedCount).toBe(0);
  });
});

describe('diffIngestRevisions — numeric thresholds', () => {
  test('small fault-current change below tolerance is NOT material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, boltedFaultCurrentKA: 25 * (1 + (NUMERIC_MATERIAL_PCT - 2) / 100) }] });
    expect(r.materialChange).toBe(false);
  });

  test('fault-current change above tolerance IS material with a pct', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, boltedFaultCurrentKA: 32 }] });
    expect(r.materialChange).toBe(true);
    expect(r.changedCount).toBe(1);
    expect(r.maxPctDelta).toBeGreaterThanOrEqual(NUMERIC_MATERIAL_PCT);
    const ch = r.busChanges[0].fields.find((f) => f.field === 'boltedFaultCurrentKA');
    expect(ch?.pct).toBeGreaterThan(0);
  });

  test('voltage change is material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, nominalVoltage: '600V' }] });
    expect(r.materialChange).toBe(true);
    expect(r.busChanges[0].fields.some((f) => f.field === 'nominalVoltage')).toBe(true);
  });
});

describe('diffIngestRevisions — device + topology', () => {
  test('trip-setting change is material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, deviceSettings: { lt: 0.8, st: 6 } }] });
    expect(r.materialChange).toBe(true);
    expect(r.busChanges[0].fields.some((f) => f.field === 'deviceSettings')).toBe(true);
  });

  test('reordered identical settings are NOT material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, deviceSettings: { st: 6, lt: 0.9 } }] });
    expect(r.materialChange).toBe(false);
  });

  test('device-type swap is material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, deviceType: 'fuse' }] });
    expect(r.materialChange).toBe(true);
  });

  test('feed-topology change is material', () => {
    const r = diffIngestRevisions(rev([busA]), { buses: [{ ...busA, fedFromBusName: 'SWGR-2B' }] });
    expect(r.materialChange).toBe(true);
    expect(r.reStudyRecommended).toBe(true);
  });
});
