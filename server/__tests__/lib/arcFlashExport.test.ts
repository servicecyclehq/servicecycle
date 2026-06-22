/**
 * Unit tests for the Slice 3.5a arc-flash model export (CSV/JSON builder).
 */
import { buildExportRows, toCsv, EXPORT_COLUMNS } from '../../lib/arcFlashExport';

const studyAsset = {
  busName: 'MCC-7', nominalVoltage: '480V', boltedFaultCurrentKA: 25, arcingCurrentKA: 18,
  electrodeConfig: 'VCB', conductorGapMm: 25, workingDistanceIn: 18, clearingTimeMs: 80,
  deviceType: 'breaker', tripUnitType: 'electronic_lsig', deviceRatingA: 800, deviceSettings: { lt: 0.9, st: 6 },
  cableLengthFt: 120, cableSize: '500 kcmil', incidentEnergyCalCm2: 8.4, ppeCategory: 2,
  asset: { equipmentType: 'MCC', site: { name: 'Riverside, OH' } },
  study: { sourceModel: { utilityMaxFaultKA: 32, utilityMinFaultKA: 20, utilityXr: 6.1, transformerKva: 1500, transformerImpedancePct: 5.75 } },
};

describe('buildExportRows', () => {
  test('flattens a bound study-asset incl. source model + JSON settings', () => {
    const [r] = buildExportRows([studyAsset]);
    expect(r.site).toBe('Riverside, OH');
    expect(r.busName).toBe('MCC-7');
    expect(r.nominalVoltageV).toBe(480);
    expect(r.boltedFaultCurrentKA).toBe(25);
    expect(r.deviceSettings).toBe(JSON.stringify({ lt: 0.9, st: 6 }));
    expect(r.utilityMaxFaultKA).toBe(32);
    expect(r.transformerKva).toBe(1500);
    expect(r.incidentEnergyCalCm2).toBe(8.4);
  });

  test('kV voltage normalizes to volts', () => {
    const [r] = buildExportRows([{ ...studyAsset, nominalVoltage: '13.8kV' }]);
    expect(r.nominalVoltageV).toBe(13800);
  });

  test('missing source model yields blank source fields, not a throw', () => {
    const [r] = buildExportRows([{ busName: 'B', asset: {}, study: {} }]);
    expect(r.utilityMaxFaultKA).toBeNull();
    expect(r.site).toBe('');
  });
});

describe('toCsv', () => {
  test('header matches the stable column order', () => {
    const csv = toCsv(buildExportRows([studyAsset]));
    const header = csv.split('\r\n')[0];
    expect(header).toBe(EXPORT_COLUMNS.map(([, l]) => l).join(','));
  });

  test('quotes cells containing commas / quotes', () => {
    const csv = toCsv(buildExportRows([{ ...studyAsset, busName: 'Bus, A "main"', asset: { site: { name: 'X' } } }]));
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toContain('"Bus, A ""main"""');
  });

  test('one header + one row per record', () => {
    const csv = toCsv(buildExportRows([studyAsset, studyAsset]));
    expect(csv.split('\r\n').length).toBe(3);
  });
});
