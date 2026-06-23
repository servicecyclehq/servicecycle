// AFX v1.1 — per-tool crosswalk (ARCAD / SKM / EasyPower) + alias-aware validate.
const { buildAliasIndex, buildToolTemplate, toolTemplateCsv } = require('../lib/afxProfiles');
const { validateAfxCsv } = require('../lib/arcFlashAfx');

describe('AFX tool crosswalk', () => {
  test('alias index maps real vendor headers to AFX keys', () => {
    const idx = buildAliasIndex();
    expect(idx.get('system voltage, v')).toBe('nominalVoltageV');            // ARCAD
    expect(idx.get('<systemnominalvoltage>')).toBe('nominalVoltageV');       // SKM
    expect(idx.get('incident energy @ afb, cal/cm2')).toBe('incidentEnergyCalCm2');
    expect(idx.get('<length>')).toBe('cableLengthFt');                       // SKM
  });

  test('per-tool template lists the fields that tool covers', () => {
    const arcad = buildToolTemplate('arcad');
    const keys = arcad.fields.map(f => f.afxKey);
    expect(keys).toEqual(expect.arrayContaining(['nominalVoltageV', 'incidentEnergyCalCm2', 'electrodeConfig']));
    const nv = arcad.fields.find(f => f.afxKey === 'nominalVoltageV');
    expect(nv.header).toBe('System voltage, V');
    expect(buildToolTemplate('nope')).toBeNull();
  });

  test('template CSV has the tool header row', () => {
    const csv = toolTemplateCsv('skm');
    expect(csv.split('\r\n')[0]).toContain('<SystemNominalVoltage>');
  });
});

describe('alias-aware AFX validation', () => {
  const idx = buildAliasIndex();

  test('an ARCAD-flavored CSV is recognized (required voltage satisfied via alias)', () => {
    const csv = '"System voltage, V","Available 3-phase short circuit current (ASCC), kA","Electrode configuration (VCB | VCCB | HCB | VOA | HOA)"\r\n480,21.9,VCCB';
    const r = validateAfxCsv(csv, { aliasIndex: idx });
    expect(r.summary.recognizedColumns).toBe(3);
    expect(r.summary.unknownColumns).toBe(0);
    // nominalVoltageV satisfied via the ARCAD alias; only busName remains required.
    expect(r.missingRequired.map(m => m.key)).toEqual(['busName']);
  });

  test('VCCB passes the electrode-config enum (ARCAD spelling of VCBB)', () => {
    const csv = 'Bus,Nominal Voltage (V),Electrode Config\r\nSWGR-1A,480,VCCB';
    const r = validateAfxCsv(csv, { aliasIndex: idx });
    expect(r.ok).toBe(true);
    expect(r.rowIssues).toHaveLength(0);
  });

  test('without the alias index, vendor headers are unknown (back-compat)', () => {
    const csv = '"System voltage, V"\r\n480';
    const r = validateAfxCsv(csv);
    expect(r.unknownColumns).toContain('System voltage, V');
  });
});
