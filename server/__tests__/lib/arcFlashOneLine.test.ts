/**
 * Unit tests for the Slice 6 one-line graph builder.
 */
import { buildOneLine } from '../../lib/arcFlashOneLine';

const assets = [
  { id: 'main', name: 'Service Main', equipmentType: 'SWITCHGEAR', nominalVoltage: '13.8kV', fedFromAssetId: null, incidentEnergyCalCm2: 30 },
  { id: 'xfmr', name: 'TX-1', equipmentType: 'TRANSFORMER_LIQUID', nominalVoltage: '13.8kV', fedFromAssetId: 'main' },
  { id: 'swgr', name: 'SWGR-1A', equipmentType: 'SWITCHGEAR', nominalVoltage: '480V', fedFromAssetId: 'xfmr', incidentEnergyCalCm2: 52, labelSeverity: 'danger' },
  { id: 'mcc', name: 'MCC-7', equipmentType: 'MCC', nominalVoltage: '480V', fedFromAssetId: 'swgr', incidentEnergyCalCm2: 8 },
];

describe('buildOneLine', () => {
  test('assigns cascading levels from the source', () => {
    const { nodes, maxLevel } = buildOneLine(assets);
    const lvl = Object.fromEntries(nodes.map(n => [n.id, n.level]));
    expect(lvl.main).toBe(0);
    expect(lvl.xfmr).toBe(1);
    expect(lvl.swgr).toBe(2);
    expect(lvl.mcc).toBe(3);
    expect(maxLevel).toBe(3);
  });

  test('emits an edge per in-set feed', () => {
    const { edges } = buildOneLine(assets);
    expect(edges).toEqual(expect.arrayContaining([
      { from: 'main', to: 'xfmr' }, { from: 'xfmr', to: 'swgr' }, { from: 'swgr', to: 'mcc' },
    ]));
    expect(edges).toHaveLength(3);
  });

  test('derives DANGER severity from voltage/IE when not set', () => {
    const { nodes } = buildOneLine(assets);
    expect(nodes.find(n => n.id === 'main')?.labelSeverity).toBe('danger'); // 13.8kV > 600 V
    expect(nodes.find(n => n.id === 'mcc')?.labelSeverity).toBe('warning');
  });

  test('a feed pointing outside the set is treated as a root', () => {
    const { nodes } = buildOneLine([{ id: 'a', name: 'A', fedFromAssetId: 'ghost' }]);
    expect(nodes[0].level).toBe(0);
    expect(nodes[0].fedFromId).toBeNull();
  });

  test('a feed cycle does not infinite-loop', () => {
    const cyc = [
      { id: 'a', name: 'A', fedFromAssetId: 'b' },
      { id: 'b', name: 'B', fedFromAssetId: 'a' },
    ];
    const { nodes } = buildOneLine(cyc);
    expect(nodes).toHaveLength(2);
    for (const n of nodes) expect(Number.isFinite(n.level)).toBe(true);
  });
});
