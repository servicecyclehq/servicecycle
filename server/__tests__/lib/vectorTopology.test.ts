const { reconcileVectorTopology } = require('../../lib/vectorTopology');

const vec = { ok: true, isCardTree: true, buses: [
  { busName: 'A', equipmentTypeGuess: 'SWITCHGEAR', fedFromBusName: null, nominalVoltage: '480V', level: 0 },
  { busName: 'B', equipmentTypeGuess: 'MCC',        fedFromBusName: 'A',  nominalVoltage: '480V', level: 1 },
  { busName: 'C', equipmentTypeGuess: 'PANELBOARD', fedFromBusName: 'A',  nominalVoltage: null,   level: 1 },
] };

describe('reconcileVectorTopology', () => {
  test('geometry overrides AI connectivity + type and records disagreements', () => {
    const ai = [
      { busName: 'A', equipmentTypeGuess: 'SWITCHGEAR', fedFromBusName: null },
      { busName: 'B', equipmentTypeGuess: 'MCC', fedFromBusName: 'A' },
      { busName: 'C', equipmentTypeGuess: 'DISCONNECT_SWITCH', fedFromBusName: 'B' }, // AI wrong: parent + type
    ];
    const r = reconcileVectorTopology(ai, vec);
    expect(r.applied).toBe(true);
    const c = r.buses.find((b: any) => b.busName === 'C');
    expect(c.fedFromBusName).toBe('A');
    expect(c.equipmentTypeGuess).toBe('PANELBOARD');
    expect(c.topologySource).toBe('vector_geometry');
    const fields = r.disagreements.filter((d: any) => d.busName === 'C').map((d: any) => d.field).sort();
    expect(fields).toEqual(['equipmentTypeGuess', 'fedFromBusName']);
  });

  test('fills voltage only when AI missed it', () => {
    const ai = [{ busName: 'B', equipmentTypeGuess: 'MCC', fedFromBusName: 'A', nominalVoltage: null }];
    const r = reconcileVectorTopology(ai, vec);
    expect(r.buses[0].nominalVoltage).toBe('480V');
  });

  test('non-card-tree leaves AI buses untouched (applied=false)', () => {
    const ai = [{ busName: 'X', fedFromBusName: 'Y', equipmentTypeGuess: 'MCC' }];
    const r = reconcileVectorTopology(ai, { ok: false, isCardTree: false, buses: [] });
    expect(r.applied).toBe(false);
    expect(r.buses).toBe(ai);
    expect(r.disagreements.length).toBe(0);
  });

  test('an AI bus with no vector match is left as-is (no false override)', () => {
    const ai = [{ busName: 'ZZZ', fedFromBusName: 'Q', equipmentTypeGuess: 'MOTOR' }];
    const r = reconcileVectorTopology(ai, vec);
    expect(r.buses[0].fedFromBusName).toBe('Q');
    expect(r.disagreements.length).toBe(0);
  });
});