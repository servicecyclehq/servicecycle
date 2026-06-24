// AFX v1.2 — multi-table builder (related Bus/Cable/Transformer/Device tables).
const { sanitizeId, buildMultiTable, renderForTool } = require('../lib/arcFlashAfxMultiTable');

describe('sanitizeId (exact-match-safe)', () => {
  test('trims, collapses whitespace, strips junk', () => {
    expect(sanitizeId('  SWGR 1A ', 'x')).toBe('SWGR_1A');
    expect(sanitizeId('Bus#1/A', 'x')).toBe('Bus1A');
    expect(sanitizeId('', 'FALLBACK')).toBe('FALLBACK');
  });
});

describe('buildMultiTable', () => {
  const rows = [
    { busName: 'MAIN SWGR', assetId: 'a1', fedFromAssetId: null, nominalVoltage: '13.8kV', equipmentType: 'SWITCHGEAR',
      incidentEnergyCalCm2: 8, labelSeverity: 'warning',
      sourceModel: { transformerKva: 2500, transformerPrimaryV: '13.8kV', transformerSecondaryV: '480V', transformerImpedancePct: 5.75 },
      devices: [] },
    { busName: 'MCC 1', assetId: 'a2', fedFromAssetId: 'a1', nominalVoltage: '480V', equipmentType: 'MCC',
      incidentEnergyCalCm2: 12, labelSeverity: 'warning',
      cableLengthFt: 120, cableSize: '500', cableMaterial: 'Cu', conductorsPerPhase: 2,
      devices: [{ label: 'Main CB', deviceType: 'breaker', manufacturer: 'SqD', sensorRatingA: 800, settings: { ltPickupA: 640 } }] },
  ];
  const t = buildMultiTable(rows);

  test('one bus row per input, IDs sanitized + unique', () => {
    expect(t.buses.map(b => b.busId)).toEqual(['MAIN_SWGR', 'MCC_1']);
    expect(t.buses[0].nominalVoltageV).toBe(13800);
  });

  test('cable keys From/To by bus ID via the feed graph', () => {
    expect(t.cables).toHaveLength(1);
    expect(t.cables[0].fromBusId).toBe('MAIN_SWGR'); // a2 fed from a1
    expect(t.cables[0].toBusId).toBe('MCC_1');
    expect(t.cables[0].cableLengthFt).toBe(120);
  });

  test('transformer + device tables populate with bus references', () => {
    expect(t.transformers).toHaveLength(1);
    expect(t.transformers[0].toBusId).toBe('MAIN_SWGR');
    expect(t.transformers[0].transformerKva).toBe(2500);
    expect(t.devices).toHaveLength(1);
    expect(t.devices[0].protectsBusId).toBe('MCC_1');
    expect(t.devices[0].deviceRatingA).toBe(800);
    expect(t.devices[0].deviceSettings).toContain('ltPickupA');
  });

  test('collision-safe IDs when two buses share a name', () => {
    const dup = buildMultiTable([
      { busName: 'BUS', assetId: 'x', devices: [] },
      { busName: 'BUS', assetId: 'y', devices: [] },
    ]);
    expect(dup.buses.map(b => b.busId)).toEqual(['BUS', 'BUS_2']);
  });
});

describe('renderForTool', () => {
  const t = buildMultiTable([{ busName: 'B1', assetId: 'a1', nominalVoltage: '480V', equipmentType: 'MCC', devices: [] }]);

  test('AFX uses AFX headers + volts', () => {
    const sheets = renderForTool(t, 'afx');
    const buses = sheets.find(s => s.sheet === 'Buses');
    expect(buses.headers).toContain('Nominal Voltage (V)');
    expect(buses.rows[0][buses.headers.indexOf('Nominal Voltage (V)')]).toBe(480);
  });

  test('ETAP uses ETAP draft headers + converts V to kV', () => {
    const sheets = renderForTool(t, 'etap');
    const buses = sheets.find(s => s.sheet === 'Buses');
    expect(buses.headers).toContain('NomkV');
    expect(buses.rows[0][buses.headers.indexOf('NomkV')]).toBe(0.48); // 480 V -> 0.48 kV
  });

  test('EasyPower drops AFX-only columns (incident energy)', () => {
    const sheets = renderForTool(t, 'easypower');
    const buses = sheets.find(s => s.sheet === 'Buses');
    expect(buses.headers).not.toContain('Incident Energy (cal/cm2)');
    expect(buses.headers).toContain('SystemNominalVoltage');
  });
});
