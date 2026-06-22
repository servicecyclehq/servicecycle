/**
 * Unit tests for the IEEE 1584 gap engine (arc-flash), reworked in 2.6 for the
 * real data-collection inputs: device + settings, cable-or-fault-current, utility.
 * Pure logic — no DB or app boot.
 */
import { analyzeBusGaps, analyzeSystemGaps, ieee1584Defaults, summarizeIngestBands, MUST_OBTAIN, TYPICAL } from '../../lib/arcFlashGap';

// A fully data-collected MV switchgear bus.
const fullBus = {
  busName: 'SWGR-1A Main',
  equipmentTypeGuess: 'SWITCHGEAR',
  nominalVoltage: '13.8kV',
  boltedFaultCurrentKA: 22,
  deviceType: 'breaker',
  deviceRatingA: 1200,
  deviceSettings: { longTime: 0.9, shortTime: 6, instantaneous: 8 },
  electrodeConfig: 'VCB',
  conductorGapMm: 152,
  workingDistanceIn: 36,
};

describe('ieee1584Defaults — typical-by-class table', () => {
  test('LV switchgear 32mm/24in; LV MCC 25mm/18in; 15kV 152mm/36in; cable 13mm', () => {
    expect(ieee1584Defaults('SWITCHGEAR', '480V')).toMatchObject({ conductorGapMm: 32, workingDistanceIn: 24, electrodeConfig: 'VCB' });
    expect(ieee1584Defaults('MCC', '480V')).toMatchObject({ conductorGapMm: 25, workingDistanceIn: 18 });
    expect(ieee1584Defaults('SWITCHGEAR', '13.8kV')).toMatchObject({ conductorGapMm: 152, workingDistanceIn: 36 });
    expect(ieee1584Defaults('CABLE_MV_HV', '13.8kV').conductorGapMm).toBe(13);
    expect(ieee1584Defaults('MOTOR', '480V').available).toBe(false);
  });
});

describe('analyzeBusGaps — composite must-obtain inputs', () => {
  test('fully collected bus -> ready / green, nothing missing', () => {
    const r = analyzeBusGaps(fullBus);
    expect(r.readiness).toBe('ready');
    expect(r.confidence).toBe('green');
    expect(r.missingRequired).toHaveLength(0);
  });

  test('typicals omitted on a known class -> defaultable / yellow, defaults filled', () => {
    const r = analyzeBusGaps({ ...fullBus, electrodeConfig: null, conductorGapMm: null, workingDistanceIn: null });
    expect(r.readiness).toBe('defaultable');
    expect(r.confidence).toBe('yellow');
    expect(r.missingRequired).toHaveLength(0); // typicals defaulted, not missing
    expect(r.defaultsApplied.sort()).toEqual(['conductorGapMm', 'electrodeConfig', 'workingDistanceIn']);
  });

  test('fault current: missing value AND no cable -> blocked, on the punch list', () => {
    const r = analyzeBusGaps({ ...fullBus, boltedFaultCurrentKA: null });
    expect(r.readiness).toBe('blocked');
    expect(r.missingRequired).toContain('faultCurrent');
  });

  test('fault current: satisfied by feeder cable (length + size) when no direct value', () => {
    const r = analyzeBusGaps({ ...fullBus, boltedFaultCurrentKA: null, cableLengthFt: 120, cableSize: '500 kcmil' });
    expect(r.missingRequired).not.toContain('faultCurrent');
    const f = r.fields.find((x: any) => x.field === 'faultCurrent');
    expect(f.status).toBe('present');
    expect(f.via).toMatch(/cable/i);
  });

  test('protective device: missing device + no clearing time -> blocked, names the device ask', () => {
    const r = analyzeBusGaps({ ...fullBus, deviceType: null, deviceRatingA: null, deviceSettings: null });
    expect(r.readiness).toBe('blocked');
    expect(r.missingRequired).toContain('protectiveDevice');
    const f = r.fields.find((x: any) => x.field === 'protectiveDevice');
    expect(f.note).toMatch(/trip settings|frame\/sensor|fuse/i);
  });

  test('protective device: satisfied by an explicit clearing time (study already has it)', () => {
    const r = analyzeBusGaps({ ...fullBus, deviceType: null, deviceRatingA: null, deviceSettings: null, clearingTimeMs: 200 });
    expect(r.missingRequired).not.toContain('protectiveDevice');
    expect(r.fields.find((x: any) => x.field === 'protectiveDevice').via).toMatch(/clearing/i);
  });

  test('protective device: satisfied by device type + rating + settings', () => {
    const r = analyzeBusGaps({ ...fullBus, clearingTimeMs: null });
    expect(r.missingRequired).not.toContain('protectiveDevice');
    expect(r.fields.find((x: any) => x.field === 'protectiveDevice').via).toMatch(/device/i);
  });

  test('unknown equipment type with missing typicals -> blocked / red, equip unconfirmed', () => {
    const r = analyzeBusGaps({ busName: 'X', equipmentTypeGuess: null, nominalVoltage: '480V', boltedFaultCurrentKA: 30, clearingTimeMs: 50 });
    expect(r.equipmentKnown).toBe(false);
    expect(r.readiness).toBe('blocked');
    expect(r.confidence).toBe('red');
    expect(r.missingRequired).toEqual(expect.arrayContaining(['electrodeConfig', 'conductorGapMm', 'workingDistanceIn']));
  });

  test('the three must-obtains are voltage, fault current, protective device', () => {
    expect(MUST_OBTAIN).toEqual(['nominalVoltage', 'faultCurrent', 'protectiveDevice']);
    expect(TYPICAL).toContain('conductorGapMm');
  });
});

describe('analyzeSystemGaps — utility source at the PCC', () => {
  test('flags missing utility min + X/R when only max is provided', () => {
    const s = analyzeSystemGaps({ utility: { maxFaultKA: 25 } });
    expect(s.complete).toBe(false);
    expect(s.missing).toEqual(expect.arrayContaining(['utilityMinFaultKA', 'utilityXR']));
  });
  test('complete when max + min + X/R present', () => {
    expect(analyzeSystemGaps({ utility: { maxFaultKA: 25, minFaultKA: 14, xr: 12 } }).complete).toBe(true);
  });
});

describe('summarizeIngestBands — worst band wins; readyBusCount = data-complete', () => {
  test('mix -> red overall; counts non-blocked buses as ready', () => {
    const results = [
      analyzeBusGaps(fullBus),                                  // ready
      analyzeBusGaps({ ...fullBus, conductorGapMm: null }),     // defaultable (still data-complete)
      analyzeBusGaps({ ...fullBus, boltedFaultCurrentKA: null }), // blocked
    ];
    const s = summarizeIngestBands(results);
    expect(s.overallBand).toBe('red');
    expect(s.readyBusCount).toBe(2); // ready + defaultable
    expect(s.totalBusCount).toBe(3);
  });
  test('empty -> red', () => { expect(summarizeIngestBands([]).overallBand).toBe('red'); });
});
