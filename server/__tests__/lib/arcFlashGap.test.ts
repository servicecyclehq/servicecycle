/**
 * Unit tests for the IEEE 1584 gap-analysis engine (arc-flash Slice 2).
 * Pure logic — no DB or app boot.
 */
import { analyzeBusGaps, ieee1584Defaults, summarizeIngestBands, MUST_OBTAIN, TYPICAL } from '../../lib/arcFlashGap';

// A fully-specified medium-voltage switchgear bus.
const fullMvSwgr = {
  busName: 'SWGR-1A Main',
  equipmentTypeGuess: 'SWITCHGEAR',
  nominalVoltage: '13.8kV',
  boltedFaultCurrentKA: 22,
  clearingTimeMs: 200,
  electrodeConfig: 'VCB',
  conductorGapMm: 152,
  workingDistanceIn: 36,
};

describe('ieee1584Defaults — typical-by-class table', () => {
  test('LV switchgear -> 32 mm gap, 24 in working distance, VCB', () => {
    const d = ieee1584Defaults('SWITCHGEAR', '480V');
    expect(d.available).toBe(true);
    expect(d.conductorGapMm).toBe(32);
    expect(d.workingDistanceIn).toBe(24);
    expect(d.electrodeConfig).toBe('VCB');
  });

  test('LV MCC/panelboard -> 25 mm gap, 18 in working distance', () => {
    const d = ieee1584Defaults('MCC', '480V');
    expect(d.conductorGapMm).toBe(25);
    expect(d.workingDistanceIn).toBe(18);
  });

  test('15 kV switchgear -> 152 mm gap, 36 in working distance', () => {
    const d = ieee1584Defaults('SWITCHGEAR', '13.8kV');
    expect(d.conductorGapMm).toBe(152);
    expect(d.workingDistanceIn).toBe(36);
  });

  test('5 kV switchgear -> 104 mm gap', () => {
    expect(ieee1584Defaults('SWITCHGEAR', '4.16kV').conductorGapMm).toBe(104);
  });

  test('cable -> 13 mm gap, 18 in', () => {
    const d = ieee1584Defaults('CABLE_MV_HV', '13.8kV');
    expect(d.conductorGapMm).toBe(13);
    expect(d.workingDistanceIn).toBe(18);
  });

  test('unknown equipment type -> no defaults available', () => {
    expect(ieee1584Defaults('MOTOR', '480V').available).toBe(false);
    expect(ieee1584Defaults('SWITCHGEAR', null).available).toBe(false); // no voltage class
  });
});

describe('analyzeBusGaps — readiness + deterministic confidence', () => {
  test('all inputs present -> ready / green, nothing missing', () => {
    const r = analyzeBusGaps(fullMvSwgr);
    expect(r.readiness).toBe('ready');
    expect(r.confidence).toBe('green');
    expect(r.missingRequired).toHaveLength(0);
    expect(r.defaultsApplied).toHaveLength(0);
  });

  test('only typicals missing on a known class -> defaultable / yellow, defaults filled', () => {
    const r = analyzeBusGaps({
      busName: 'SWGR-1A', equipmentTypeGuess: 'SWITCHGEAR', nominalVoltage: '13.8kV',
      boltedFaultCurrentKA: 22, clearingTimeMs: 200, // must-obtain all present
      // electrodeConfig / conductorGapMm / workingDistanceIn omitted
    });
    expect(r.readiness).toBe('defaultable');
    expect(r.confidence).toBe('yellow');
    expect(r.missingRequired).toHaveLength(0); // typicals were defaulted, not "missing"
    expect(r.defaultsApplied.sort()).toEqual(['conductorGapMm', 'electrodeConfig', 'workingDistanceIn']);
    const gapField = r.fields.find((f: any) => f.field === 'conductorGapMm');
    expect(gapField.status).toBe('defaulted');
    expect(gapField.defaultValue).toBe(152);
  });

  test('missing bolted fault current -> blocked / red, on the punch list', () => {
    const r = analyzeBusGaps({ ...fullMvSwgr, boltedFaultCurrentKA: null });
    expect(r.readiness).toBe('blocked');
    expect(r.confidence).toBe('red');
    expect(r.missingRequired).toContain('boltedFaultCurrentKA');
  });

  test('missing clearing time -> blocked / red', () => {
    const r = analyzeBusGaps({ ...fullMvSwgr, clearingTimeMs: undefined });
    expect(r.readiness).toBe('blocked');
    expect(r.confidence).toBe('red');
    expect(r.missingRequired).toContain('clearingTimeMs');
  });

  test('unknown equipment type with missing typicals -> blocked / red, equipment unconfirmed', () => {
    const r = analyzeBusGaps({
      busName: 'Bus X', equipmentTypeGuess: null, nominalVoltage: '480V',
      boltedFaultCurrentKA: 30, clearingTimeMs: 50,
    });
    expect(r.equipmentKnown).toBe(false);
    expect(r.readiness).toBe('blocked');
    expect(r.confidence).toBe('red');
    // can't default typicals without a known class
    expect(r.missingRequired).toEqual(expect.arrayContaining(['electrodeConfig', 'conductorGapMm', 'workingDistanceIn']));
  });

  test('must-obtain inputs are never silently defaulted', () => {
    const r = analyzeBusGaps({ equipmentTypeGuess: 'SWITCHGEAR', nominalVoltage: '480V' });
    for (const f of MUST_OBTAIN) {
      const fld = r.fields.find((x: any) => x.field === f);
      expect(['present', 'missing']).toContain(fld.status);
      expect(fld.status).not.toBe('defaulted');
    }
  });
});

describe('summarizeIngestBands — worst band wins', () => {
  test('green + yellow + red -> red overall; ready count correct', () => {
    const results = [
      analyzeBusGaps(fullMvSwgr),                                  // green / ready
      analyzeBusGaps({ ...fullMvSwgr, conductorGapMm: null }),     // yellow / defaultable
      analyzeBusGaps({ ...fullMvSwgr, clearingTimeMs: null }),     // red / blocked
    ];
    const s = summarizeIngestBands(results);
    expect(s.overallBand).toBe('red');
    expect(s.readyBusCount).toBe(1);
    expect(s.totalBusCount).toBe(3);
  });

  test('all green -> green overall', () => {
    const s = summarizeIngestBands([analyzeBusGaps(fullMvSwgr), analyzeBusGaps(fullMvSwgr)]);
    expect(s.overallBand).toBe('green');
    expect(s.readyBusCount).toBe(2);
  });

  test('empty -> red (nothing extracted)', () => {
    expect(summarizeIngestBands([]).overallBand).toBe('red');
  });
});
