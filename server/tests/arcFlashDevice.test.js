// lib/arcFlashDevice.ts — [F6, 2026-07-07] trip-unit-type capture fix.
// Previously the photo-extraction contract never asked the model to classify
// the trip unit itself (only its settings), so a photo of an adjustable
// electronic LSIG breaker came back with tripUnitType unset -- arcFlashGap.ts
// then silently treated a bare "breaker" as fixed-trip (satisfied by
// type+rating alone), skipping the follow-up task to record its LSIG
// settings. These tests cover the classifier + the deviceToBusFields
// passthrough + the end-to-end gap-engine behavior change, all against pure
// functions -- no live AI call.
// arcFlashDevice.ts requires ./ai, whose module load triggers
// aiBudgetGuard's fire-and-forget rehydrateOnBoot(). In a lightweight unit
// test with no other async work keeping the process alive, that promise can
// resolve AFTER Jest tears down the test environment ("require a file after
// the Jest environment has been torn down"), which doesn't fail any
// assertion but does poison the process exit code. Same fix pattern as the
// 2026-07-06 cron-hunt session's demoPruneCrashPath.test.ts: explicitly
// await it up front so it settles before Jest's teardown, not after.
beforeAll(async () => {
  const { rehydrateOnBoot } = require('../lib/aiBudgetGuard');
  await rehydrateOnBoot();
});

const { normalizeDevice, deviceToBusFields } = require('../lib/arcFlashDevice');
const { analyzeBusGaps } = require('../lib/arcFlashGap');

describe('normalizeDevice — tripUnitType classification', () => {
  test('recognizes the exact enum values verbatim', () => {
    expect(normalizeDevice({ tripUnitType: 'electronic_lsig' }).tripUnitType).toBe('electronic_lsig');
    expect(normalizeDevice({ tripUnitType: 'electronic_lsi' }).tripUnitType).toBe('electronic_lsi');
    expect(normalizeDevice({ tripUnitType: 'thermal_magnetic' }).tripUnitType).toBe('thermal_magnetic');
    expect(normalizeDevice({ tripUnitType: 'none' }).tripUnitType).toBe('none');
  });

  test('fuzzy-matches free-text a vision model might return', () => {
    expect(normalizeDevice({ tripUnitType: 'LSIG' }).tripUnitType).toBe('electronic_lsig');
    expect(normalizeDevice({ tripUnitType: 'Electronic trip unit with ground fault' }).tripUnitType).toBe('electronic_lsig');
    expect(normalizeDevice({ tripUnitType: 'LSI (no ground fault)' }).tripUnitType).toBe('electronic_lsi');
    expect(normalizeDevice({ tripUnitType: 'Micrologic 6.0 electronic display' }).tripUnitType).toBe('electronic_lsi');
    expect(normalizeDevice({ tripUnitType: 'simple thermal-magnetic, no display' }).tripUnitType).toBe('thermal_magnetic');
  });

  test('unrecognizable or missing input stays null (never guesses)', () => {
    expect(normalizeDevice({ tripUnitType: null }).tripUnitType).toBeNull();
    expect(normalizeDevice({}).tripUnitType).toBeNull();
    expect(normalizeDevice({ tripUnitType: 'unknown' }).tripUnitType).toBeNull();
  });
});

describe('deviceToBusFields — tripUnitType passthrough', () => {
  test('carries the classified tripUnitType onto the bus fields', () => {
    const device = normalizeDevice({ deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameRatingA: 800 });
    const fields = deviceToBusFields(device);
    expect(fields.tripUnitType).toBe('electronic_lsig');
    expect(fields.deviceType).toBe('breaker');
  });

  test('null tripUnitType stays null (not coerced to a default)', () => {
    const device = normalizeDevice({ deviceType: 'breaker', frameRatingA: 800 });
    expect(deviceToBusFields(device).tripUnitType).toBeNull();
  });
});

describe('F6 regression: gap engine now asks for LSIG settings once tripUnitType is known', () => {
  test('a breaker photo-read as electronic_lsig is flagged as needing recorded settings, not treated as fixed-trip-satisfied', () => {
    const device = normalizeDevice({ deviceType: 'breaker', tripUnitType: 'electronic_lsig', frameRatingA: 800, sensorRatingA: 800 });
    const bus = {
      nominalVoltage: '480V', boltedFaultCurrentKA: 25,
      ...deviceToBusFields(device),
      deviceRatingA: 800,
    };
    const result = analyzeBusGaps(bus);
    const deviceField = result.fields.find((f) => f.field === 'protectiveDevice');
    // Before this fix, tripUnitType would have been null and a bare "breaker"
    // + rating alone would satisfy the gap engine (fixedTrip=true path). With
    // tripUnitType correctly classified as adjustable, it must NOT be marked
    // satisfied by rating alone -- it needs recorded trip settings.
    expect(deviceField.status).toBe('missing');
    expect(deviceField.note.toLowerCase()).toContain('lsig');
    expect(result.missingRequired).toContain('protectiveDevice');
  });

  test('a genuinely fixed-trip (thermal-magnetic) breaker IS satisfied by type + rating alone', () => {
    const device = normalizeDevice({ deviceType: 'breaker', tripUnitType: 'thermal_magnetic', frameRatingA: 100, sensorRatingA: 100 });
    const bus = {
      nominalVoltage: '480V', boltedFaultCurrentKA: 25,
      ...deviceToBusFields(device),
      deviceRatingA: 100,
    };
    const result = analyzeBusGaps(bus);
    const deviceField = result.fields.find((f) => f.field === 'protectiveDevice');
    expect(deviceField.status).toBe('present');
  });
});
