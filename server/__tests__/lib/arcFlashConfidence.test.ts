/**
 * Unit tests for the Slice 2.8a per-bus arc-flash confidence score. Pure logic —
 * no DB or app boot. Deterministic factors: completeness, study age, field
 * verification, drift.
 */
import { scoreBusConfidence, pickDeviceSource, CONFIDENCE_WEIGHTS, RE_EVAL_YEARS } from '../../lib/arcFlashConfidence';

// A fully data-collected LV switchgear bus (all IEEE 1584 inputs present).
const fullBus = {
  busName: 'SWGR-1A Main',
  equipmentTypeGuess: 'SWITCHGEAR',
  nominalVoltage: '480V',
  boltedFaultCurrentKA: 22,
  deviceType: 'breaker',
  tripUnitType: 'electronic_lsig',
  deviceRatingA: 1200,
  deviceSettings: { longTime: 0.9, shortTime: 6, instantaneous: 8 },
  electrodeConfig: 'VCB',
  conductorGapMm: 32,
  workingDistanceIn: 24,
};

const asOf = new Date('2026-06-22T00:00:00Z');
const freshStudy = { performedDate: '2026-01-01T00:00:00Z', expiresAt: '2031-01-01T00:00:00Z', superseded: false };

describe('scoreBusConfidence — banding', () => {
  test('fresh study + complete inputs + field-verified device -> high/green ~100', () => {
    const r = scoreBusConfidence({ bus: fullBus, study: freshStudy, deviceSource: 'field', driftFlagged: false, asOf });
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(r.band).toBe('green');
    expect(r.capped).toBe(false);
    // factor maxes match the documented weights
    const maxByKey = Object.fromEntries(r.factors.map((f) => [f.key, f.max]));
    expect(maxByKey.completeness).toBe(CONFIDENCE_WEIGHTS.completeness);
    expect(maxByKey.studyAge).toBe(CONFIDENCE_WEIGHTS.studyAge);
    expect(maxByKey.verification).toBe(CONFIDENCE_WEIGHTS.verification);
    expect(maxByKey.drift).toBe(CONFIDENCE_WEIGHTS.drift);
  });

  test('no bound study zeroes the freshness factor', () => {
    const r = scoreBusConfidence({ bus: fullBus, study: null, deviceSource: 'field', driftFlagged: false, asOf });
    const age = r.factors.find((f) => f.key === 'studyAge');
    expect(age?.points).toBe(0);
    // 40 completeness + 0 age + 20 verification + 10 drift = 70 -> yellow
    expect(r.band).toBe('yellow');
  });

  test('expired study zeroes freshness', () => {
    const expired = { performedDate: '2018-01-01T00:00:00Z', expiresAt: '2023-01-01T00:00:00Z', superseded: false };
    const r = scoreBusConfidence({ bus: fullBus, study: expired, deviceSource: 'field', asOf });
    expect(r.factors.find((f) => f.key === 'studyAge')?.points).toBe(0);
  });

  test('study exactly at the re-eval horizon scores 0 freshness', () => {
    const old = { performedDate: new Date(asOf.getTime() - RE_EVAL_YEARS * 365.25 * 864e5 - 1000).toISOString(), expiresAt: null, superseded: false };
    const r = scoreBusConfidence({ bus: fullBus, study: old, deviceSource: 'field', asOf });
    expect(r.factors.find((f) => f.key === 'studyAge')?.points).toBe(0);
  });

  test('superseded study zeroes freshness', () => {
    const r = scoreBusConfidence({ bus: fullBus, study: { ...freshStudy, superseded: true }, deviceSource: 'field', asOf });
    expect(r.factors.find((f) => f.key === 'studyAge')?.points).toBe(0);
  });
});

describe('scoreBusConfidence — drift caps the band', () => {
  test('drift zeroes its factor and forbids green', () => {
    const r = scoreBusConfidence({ bus: fullBus, study: freshStudy, deviceSource: 'field', driftFlagged: true, asOf });
    expect(r.factors.find((f) => f.key === 'drift')?.points).toBe(0);
    expect(r.capped).toBe(true);
    expect(r.band).not.toBe('green');
  });
});

describe('scoreBusConfidence — verification provenance ladder', () => {
  test('field > photo > manual > import > none', () => {
    const base = { bus: fullBus, study: freshStudy, driftFlagged: false, asOf };
    const field = scoreBusConfidence({ ...base, deviceSource: 'field' }).score;
    const photo = scoreBusConfidence({ ...base, deviceSource: 'photo' }).score;
    const manual = scoreBusConfidence({ ...base, deviceSource: 'manual' }).score;
    const imp = scoreBusConfidence({ ...base, deviceSource: 'import' }).score;
    const none = scoreBusConfidence({ ...base, deviceSource: null }).score;
    expect(field).toBeGreaterThan(photo);
    expect(photo).toBeGreaterThan(manual);
    expect(manual).toBeGreaterThan(imp);
    expect(imp).toBeGreaterThan(none);
  });
});

describe('scoreBusConfidence — completeness drives low scores', () => {
  test('a near-empty bus with no study lands red', () => {
    const r = scoreBusConfidence({ bus: { busName: 'X', nominalVoltage: '480V' }, study: null, deviceSource: null, asOf });
    expect(r.band).toBe('red');
    expect(r.score).toBeLessThan(50);
    expect(r.summary).toContain('low confidence');
  });

  test('factors always sum to the score (within rounding)', () => {
    const r = scoreBusConfidence({ bus: fullBus, study: freshStudy, deviceSource: 'manual', asOf });
    const sum = r.factors.reduce((a, f) => a + f.points, 0);
    expect(Math.abs(sum - r.score)).toBeLessThanOrEqual(2);
  });
});

describe('pickDeviceSource', () => {
  test('prefers field over photo/manual/import', () => {
    expect(pickDeviceSource([{ source: 'import' }, { source: 'field' }, { source: 'manual' }])).toBe('field');
    expect(pickDeviceSource([{ source: 'manual' }, { source: 'photo' }])).toBe('photo');
    expect(pickDeviceSource([])).toBe(null);
    expect(pickDeviceSource([{ source: 'bogus' }])).toBe(null);
  });
});
