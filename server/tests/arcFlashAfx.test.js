// AFX (Arc Flash Data Exchange) v1 — spec integrity + conformance validator.
const { AFX_FIELDS, buildAfxSpec, validateAfxRows, validateAfxCsv } = require('../lib/arcFlashAfx');
const { EXPORT_COLUMNS } = require('../lib/arcFlashExport');

describe('AFX spec', () => {
  test('versioned, standards-anchored, with required identity + voltage', () => {
    const spec = buildAfxSpec();
    // [F-E1] Bumped 1.0 -> 1.1: 12 additive/optional fields added so the
    // export stops silently dropping already-captured data (see arcFlashAfx.ts).
    // [W5] Bumped 1.1 -> 1.2: arcingCurrentReducedKA + governingScenario added.
    expect(spec.afxVersion).toBe('1.2');
    expect(spec.standardsBasis).toEqual(expect.arrayContaining(['IEEE 1584-2018']));
    const req = spec.fields.filter(f => f.required).map(f => f.key).sort();
    expect(req).toEqual(['busName', 'nominalVoltageV']);
  });

  test('AFX field keys stay 1:1 with the export columns (export IS AFX)', () => {
    const afxKeys = AFX_FIELDS.map(f => f.key).sort();
    const exportKeys = EXPORT_COLUMNS.map(([k]) => k).sort();
    expect(afxKeys).toEqual(exportKeys);
  });
});

describe('validateAfxRows', () => {
  test('clean rows pass', () => {
    const r = validateAfxRows(
      ['Bus', 'Nominal Voltage (V)', 'Bolted Fault (kA)', 'Electrode Config'],
      [{ 'Bus': 'SWGR-1A', 'Nominal Voltage (V)': '480', 'Bolted Fault (kA)': '21.9', 'Electrode Config': 'VCB' }],
    );
    expect(r.ok).toBe(true);
    expect(r.summary.recognizedColumns).toBe(4);
    expect(r.summary.unknownColumns).toBe(0);
  });

  test('flags missing required, unknown columns, bad number + bad enum', () => {
    const r = validateAfxRows(
      ['Bolted Fault (kA)', 'Electrode Config', 'Mystery Col'],
      [{ 'Bolted Fault (kA)': 'lots', 'Electrode Config': 'ZZZ', 'Mystery Col': 'x' }],
    );
    expect(r.ok).toBe(false);
    expect(r.missingRequired.map(m => m.key).sort()).toEqual(['busName', 'nominalVoltageV']);
    expect(r.unknownColumns).toContain('Mystery Col');
    const issues = r.rowIssues.map(i => `${i.column}:${i.issue}`);
    expect(issues.some(s => s.startsWith('Bolted Fault (kA):not a number'))).toBe(true);
    expect(issues.some(s => s.startsWith('Electrode Config:not in'))).toBe(true);
  });

  test('matches columns by field key too (case-insensitive)', () => {
    const r = validateAfxRows(['busName', 'nominalvoltagev'], [{ busName: 'B', nominalvoltagev: '208' }]);
    expect(r.summary.recognizedColumns).toBe(2);
    expect(r.missingRequired).toHaveLength(0);
  });
});

describe('validateAfxCsv', () => {
  test('parses a CSV (incl. quoted JSON) and validates', () => {
    const csv = 'Bus,Nominal Voltage (V),Trip Settings (JSON)\r\nSWGR-1A,480,"{""ltPickupA"":320}"';
    const r = validateAfxCsv(csv);
    expect(r.headers).toContain('Bus');
    expect(r.ok).toBe(true);
    expect(r.summary.rowCount).toBe(1);
  });

  test('empty file fails gracefully', () => {
    const r = validateAfxCsv('');
    expect(r.ok).toBe(false);
  });
});
