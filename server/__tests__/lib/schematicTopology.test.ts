const { reconcileSchematicTopology } = require('../../lib/schematicTopology');

// a confidently-named schematic read (nameConfidence high enough to match by name)
const schConf = {
  ok: true, isSchematic: true, nameConfidence: 1.0, feedCount: 2, tieCount: 0, page: 0,
  notes: [],
  buses: [
    { busName: 'MSB', equipmentTypeGuess: 'SWITCHBOARD', fedFromBusName: null,  nominalVoltage: '480V', level: 0 },
    { busName: 'MCC-1', equipmentTypeGuess: 'SWITCHBOARD', fedFromBusName: 'MSB', nominalVoltage: '480V', level: 1 },
    { busName: 'DP-2', equipmentTypeGuess: 'SWITCHBOARD', fedFromBusName: 'MSB', nominalVoltage: null,   level: 1 },
  ],
};

describe('reconcileSchematicTopology', () => {
  test('geometry overrides AI connectivity when confident and records disagreement', () => {
    const ai = [
      { busName: 'MSB', equipmentTypeGuess: 'SWITCHBOARD', fedFromBusName: null },
      { busName: 'MCC-1', equipmentTypeGuess: 'MCC', fedFromBusName: 'MSB' },
      { busName: 'DP-2', equipmentTypeGuess: 'PANELBOARD', fedFromBusName: 'MCC-1' }, // AI wrong parent
    ];
    const r = reconcileSchematicTopology(ai, schConf);
    expect(r.applied).toBe(true);
    const dp = r.buses.find((b: any) => b.busName === 'DP-2');
    expect(dp.fedFromBusName).toBe('MSB');
    expect(dp.topologySource).toBe('schematic_geometry');
    const fields = r.disagreements.filter((d: any) => d.busName === 'DP-2').map((d: any) => d.field);
    expect(fields).toEqual(['fedFromBusName']);
    expect(r.advisory).not.toBeNull();
    expect(r.advisory.busCount).toBe(3);
  });

  test('does NOT clobber the AI finer equipment type (only fills a gap)', () => {
    const ai = [
      { busName: 'MCC-1', equipmentTypeGuess: 'MCC', fedFromBusName: 'MSB' },       // AI has finer type
      { busName: 'DP-2', equipmentTypeGuess: null, fedFromBusName: 'MSB' },          // AI missing type
    ];
    const r = reconcileSchematicTopology(ai, schConf);
    const mcc = r.buses.find((b: any) => b.busName === 'MCC-1');
    const dp = r.buses.find((b: any) => b.busName === 'DP-2');
    expect(mcc.equipmentTypeGuess).toBe('MCC');            // untouched (finer than geometry's coarse guess)
    expect(dp.equipmentTypeGuess).toBe('SWITCHBOARD');     // filled the gap
  });

  test('fills voltage only when AI missed it', () => {
    // MCC-1 carries '480V' in the geometry read; AI missed it -> filled.
    const ai = [{ busName: 'MCC-1', equipmentTypeGuess: 'MCC', fedFromBusName: 'MSB', nominalVoltage: null }];
    const r = reconcileSchematicTopology(ai, schConf);
    expect(r.buses[0].nominalVoltage).toBe('480V');
  });

  test('LOW nameConfidence does not override, but still returns the geometry advisory', () => {
    const schLow = { ...schConf, nameConfidence: 0.2, notes: ['low-confidence-maybe-not-oneline'] };
    const ai = [{ busName: 'DP-2', equipmentTypeGuess: 'PANELBOARD', fedFromBusName: 'MCC-1' }];
    const r = reconcileSchematicTopology(ai, schLow);
    expect(r.applied).toBe(false);
    expect(r.buses[0].fedFromBusName).toBe('MCC-1');       // untouched
    expect(r.disagreements.length).toBe(0);
    expect(r.advisory).not.toBeNull();                     // advisory ALWAYS surfaced
    expect(r.advisory.nameConfidence).toBe(0.2);
    expect(r.advisory.notes).toContain('low-confidence-maybe-not-oneline');
  });

  test('non-schematic leaves AI buses untouched (applied=false, advisory=null)', () => {
    const ai = [{ busName: 'X', fedFromBusName: 'Y', equipmentTypeGuess: 'MCC' }];
    const r = reconcileSchematicTopology(ai, { ok: false, isSchematic: false, buses: [], nameConfidence: 0, notes: [], feedCount: 0, tieCount: 0, page: null });
    expect(r.applied).toBe(false);
    expect(r.buses).toBe(ai);
    expect(r.advisory).toBeNull();
    expect(r.disagreements.length).toBe(0);
  });

  test('an AI bus with no geometry match is left as-is (no false override)', () => {
    const ai = [{ busName: 'ZZZ', fedFromBusName: 'Q', equipmentTypeGuess: 'MOTOR' }];
    const r = reconcileSchematicTopology(ai, schConf);
    expect(r.buses[0].fedFromBusName).toBe('Q');
    expect(r.disagreements.length).toBe(0);
  });
});
