'use strict';

// AFX per-tool import templates (SKM / ETAP / EasyPower) — schema validity,
// fixture round-trips, exact mechanical unit conversions, the PPE-drop policy,
// and the unknown/missing-required issue paths. Pure lib + data; no DB.
const fs = require('fs');
const path = require('path');
const {
  CONVERSIONS,
  POLICY_FORBIDDEN_TARGETS,
  validateTemplateObject,
  loadToolTemplates,
  listToolTemplates,
  getToolTemplate,
  rowsFromCsv,
  applyTemplate,
  afxRecordsToTables,
} = require('../lib/afxToolTemplates');
const { AFX_FIELDS } = require('../lib/arcFlashAfx');
const { validateMultiTable } = require('../lib/arcFlashAfxMultiTable');

const FIXTURES = path.join(__dirname, '..', 'data', 'afx', 'fixtures');
const readFixture = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

const AFX_KEYS = new Set(AFX_FIELDS.map((f) => f.key));

describe('template pack: loads, zod-valid, honest labels', () => {
  test('all three tools load and validate', () => {
    const tools = loadToolTemplates().map((t) => t.tool).sort();
    expect(tools).toEqual(['easypower', 'etap', 'skm']);
  });

  test('every mapping targets a real AFX field, never a policy-forbidden one', () => {
    for (const tpl of loadToolTemplates()) {
      for (const m of tpl.mappings) {
        expect(AFX_KEYS.has(m.afxField)).toBe(true);
        expect(POLICY_FORBIDDEN_TARGETS.has(m.afxField)).toBe(false);
        expect(['verified', 'probable', 'assumed']).toContain(m.confidence);
        expect(m.source.length).toBeGreaterThan(10);
      }
      // Policy is stated on the template itself and a PPE drop-list exists.
      expect(tpl.policyNote).toMatch(/PPE/);
      expect(tpl.ignoredByPolicy.length).toBeGreaterThan(0);
      const dropAliases = tpl.ignoredByPolicy.flatMap((d) => d.aliases.map((a) => a.toLowerCase()));
      expect(dropAliases.some((a) => a.includes('ppe') || a.includes('hazard'))).toBe(true);
    }
  });

  test('declared conversions exist and agree on units', () => {
    for (const tpl of loadToolTemplates()) {
      for (const m of tpl.mappings) {
        if (!m.convert) continue;
        const c = CONVERSIONS[m.convert.id];
        expect(c).toBeTruthy();
        expect(c.from).toBe(m.convert.from);
        expect(c.to).toBe(m.convert.to);
      }
    }
  });

  test('SKM/EasyPower carry verified mappings; ETAP is honestly draft (no verified)', () => {
    const skm = getToolTemplate('skm');
    const ezp = getToolTemplate('easypower');
    const etap = getToolTemplate('etap');
    expect(skm.mappings.some((m) => m.confidence === 'verified')).toBe(true);
    expect(ezp.mappings.some((m) => m.confidence === 'verified')).toBe(true);
    expect(etap.mappings.some((m) => m.confidence === 'verified')).toBe(false);
    expect(etap.toolVersionRange).toMatch(/[Cc]onfirm/);
  });

  test('schema rejects a template that maps a PPE column to ppeCategory', () => {
    const bad = {
      templateFormatVersion: '1.0', afxVersion: '1.0', tool: 'badtool', label: 'x', toolVersionRange: 'x',
      policyNote: 'this is long enough', frequencyAssumptionHz: 60, sourceNotes: ['s'],
      mappings: [{ afxField: 'ppeCategory', aliases: ['PPE Level'], confidence: 'verified', source: 'somewhere over there', convert: null, note: null }],
      ignoredByPolicy: [{ aliases: ['X'], reason: 'r', note: 'n' }], knownUnmapped: [], rowChecks: [],
    };
    expect(() => validateTemplateObject(bad, 'bad')).toThrow(/policy/i);
  });

  test('schema rejects unknown conversion ids and cross-bucket duplicate aliases', () => {
    const base = {
      templateFormatVersion: '1.0', afxVersion: '1.0', tool: 'badtool', label: 'x', toolVersionRange: 'x',
      policyNote: 'this is long enough', frequencyAssumptionHz: 60, sourceNotes: ['s'],
      ignoredByPolicy: [{ aliases: ['PPE Level'], reason: 'r', note: 'n' }], knownUnmapped: [], rowChecks: [],
    };
    expect(() => validateTemplateObject({
      ...base,
      mappings: [{ afxField: 'busName', aliases: ['Bus'], confidence: 'verified', source: 'somewhere over there', convert: { id: 'nope', from: 'a', to: 'b' }, note: null }],
    }, 'bad')).toThrow(/unknown conversion/);
    expect(() => validateTemplateObject({
      ...base,
      mappings: [{ afxField: 'busName', aliases: ['PPE Level'], confidence: 'verified', source: 'somewhere over there', convert: null, note: null }],
    }, 'bad')).toThrow(/appears in both/);
  });

  test('listToolTemplates summarizes with confidence histogram', () => {
    const list = listToolTemplates();
    expect(list).toHaveLength(3);
    const skm = list.find((t) => t.tool === 'skm');
    expect(skm.mappedFieldCount).toBeGreaterThan(8);
    expect(skm.confidence.verified).toBeGreaterThan(0);
    expect(skm.ignoredByPolicyCount).toBeGreaterThan(0);
    expect(skm.policyNote).toMatch(/PPE/);
  });
});

describe('mechanical conversions are exact', () => {
  const tpl60 = { frequencyAssumptionHz: 60 };
  test('declared factors', () => {
    expect(CONVERSIONS.kvToV.apply(13.8)).toBeCloseTo(13800, 9);
    expect(CONVERSIONS.sToMs.apply(0.05)).toBeCloseTo(50, 9);
    expect(CONVERSIONS.ftToIn.apply(7.4)).toBeCloseTo(88.8, 9);
    expect(CONVERSIONS.mmToIn.apply(25.4)).toBe(1);
    expect(CONVERSIONS.jPerCm2ToCalPerCm2.apply(41.84)).toBeCloseTo(10, 9);
    expect(CONVERSIONS.cyclesToMs.apply(6, tpl60)).toBeCloseTo(100, 9);
  });

  test('applyTemplate stores rounded exact values (no IEEE-754 drift)', () => {
    const etap = getToolTemplate('etap');
    const { records } = applyTemplate([{ 'Bus ID': 'FICTION-X', 'Nominal kV': '0.208', 'FCT (cycles)': '5' }], etap);
    expect(records[0].nominalVoltageV).toBe(208); // not 208.00000000000003
    expect(records[0].clearingTimeMs).toBe(83.333333333); // 5 * (1000/60) rounded to 9 dp, 60 Hz declared
  });
});

describe('SKM fixture → AFX records', () => {
  const tpl = getToolTemplate('skm');
  const { headers, rows } = rowsFromCsv(readFixture('skm_arc_flash_evaluation_sample.csv'));
  const out = applyTemplate(rows, tpl, { headers });

  test('all rows map; no unknown columns; PPE column provably dropped', () => {
    expect(out.summary.rowCount).toBe(5);
    expect(out.records).toHaveLength(5);
    expect(out.columnReport.unknown).toEqual([]);
    const dropped = out.columnReport.ignoredByPolicy.map((c) => c.header);
    expect(dropped).toContain('PPE Level / Notes (*N)');
    for (const r of out.records) expect(r).not.toHaveProperty('ppeCategory');
  });

  test('exact values + conversions (kV→V, s→ms)', () => {
    const r0 = out.records[0];
    expect(r0.busName).toBe('FICTION-MDP-A');
    expect(r0.deviceModel).toBe('FICTION-MAIN-52A');
    expect(r0.nominalVoltageV).toBe(480);
    expect(r0.boltedFaultCurrentKA).toBe(32.5);
    expect(r0.arcingCurrentKA).toBe(18.2);
    expect(r0.clearingTimeMs).toBe(50);
    expect(r0.equipmentType).toBe('SWG');
    expect(r0.electrodeConfig).toBe('VCB');
    expect(r0.conductorGapMm).toBe(32);
    expect(r0.arcFlashBoundaryIn).toBe(52);
    expect(r0.workingDistanceIn).toBe(18);
    expect(r0.incidentEnergyCalCm2).toBe(6.7);
    expect(out.records[1].nominalVoltageV).toBe(208);
    expect(out.records[1].clearingTimeMs).toBe(8.3);
    expect(out.records[3].nominalVoltageV).toBe(13800);
  });

  test('device-side + box-dimension columns are recognized-but-unmapped, not unknown', () => {
    const known = out.columnReport.knownUnmapped.map((c) => c.header);
    expect(known).toEqual(expect.arrayContaining([
      'Prot Dev Bolted Fault (kA)', 'Prot Dev Arcing Fault (kA)',
      'Breaker Opening Time/Tol (sec.)', 'Box Width (in)', 'Box Height (in)', 'Box Depth (in)',
    ]));
  });

  test('nonzero breaker opening time raises the declared per-row warning (row 4 only)', () => {
    const warns = out.issues.filter((i) => i.checkId === 'skm_breaker_opening_time_nonzero');
    expect(warns).toHaveLength(1);
    expect(warns[0].row).toBe(4);
    expect(warns[0].issue).toMatch(/UNDERSTATES total clearing time/);
  });

  test('SKM threshold cells like "< 1.2" surface as per-row issues, not coerced numbers', () => {
    const withThreshold = applyTemplate([
      { 'Bus Name': 'FICTION-T', 'Bus kV': '0.208', 'Incident Energy (cal/cm2)': '< 1.2' },
    ], tpl);
    expect(withThreshold.records[0]).not.toHaveProperty('incidentEnergyCalCm2');
    expect(withThreshold.issues.some((i) => i.kind === 'error' && i.column === 'Incident Energy (cal/cm2)' && /not a number/.test(i.issue))).toBe(true);
  });
});

describe('EasyPower fixture → AFX records', () => {
  const tpl = getToolTemplate('easypower');
  const { rows } = rowsFromCsv(readFixture('easypower_arc_flash_hazard_report_sample.csv'));
  const out = applyTemplate(rows, tpl);

  test('all rows map; PPE Level dropped; component times recognized-but-unmapped', () => {
    expect(out.records).toHaveLength(6);
    expect(out.columnReport.unknown).toEqual([]);
    expect(out.columnReport.ignoredByPolicy.map((c) => c.header)).toContain('PPE Level');
    for (const r of out.records) expect(r).not.toHaveProperty('ppeCategory');
    const known = out.columnReport.knownUnmapped.map((c) => c.header);
    expect(known).toEqual(expect.arrayContaining(['Trip Time (sec)', 'Opening Time (sec)', 'Upstream Trip Device Function']));
  });

  test('Arc Time (the tool-defined TOTAL) maps to clearingTimeMs; components do not', () => {
    expect(out.records[0].clearingTimeMs).toBe(340); // 0.34 s
    expect(out.records[1].clearingTimeMs).toBe(99); // 0.099 s = trip 0.016 + opening 0.083
    expect(out.records[2].clearingTimeMs).toBe(737);
  });

  test('exact values (kV→V; mm gap passthrough; inches passthrough)', () => {
    const r1 = out.records[1];
    expect(r1.busName).toBe('FICTION-BUS-7');
    expect(r1.nominalVoltageV).toBe(13800);
    expect(r1.deviceModel).toBe('FICTION-R-7');
    expect(r1.equipmentType).toBe('Open Air');
    expect(r1.electrodeConfig).toBe('VOA');
    expect(r1.conductorGapMm).toBe(153);
    expect(r1.boltedFaultCurrentKA).toBe(9.914);
    expect(r1.arcingCurrentKA).toBe(8.262);
    expect(r1.arcFlashBoundaryIn).toBe(30.5);
    expect(r1.workingDistanceIn).toBe(26);
    expect(r1.incidentEnergyCalCm2).toBe(1.5);
  });

  test('J/cm2 export variant converts mechanically; bare "Incident Energy" stays unmapped (ambiguous units)', () => {
    const joule = applyTemplate([
      { 'Arc Fault Bus Name': 'FICTION-J', 'Arc Fault Bus kV': '0.48', 'Incident Energy (J/cm2)': '41.84', 'Incident Energy': '99' },
    ], tpl);
    expect(joule.records[0].incidentEnergyCalCm2).toBe(10); // 41.84 / 4.184
    expect(joule.columnReport.knownUnmapped.map((c) => c.header)).toContain('Incident Energy');
  });

  test('when both cal/cm2 and J/cm2 columns exist, template order wins and the loser is flagged', () => {
    const both = applyTemplate([
      { 'Arc Fault Bus Name': 'FICTION-B', 'Arc Fault Bus kV': '0.48', 'Incident Energy (cal/cm2)': '5', 'Incident Energy (J/cm2)': '41.84' },
    ], tpl);
    expect(both.records[0].incidentEnergyCalCm2).toBe(5);
    expect(both.issues.some((i) => /duplicate source for incidentEnergyCalCm2/.test(i.issue))).toBe(true);
  });
});

describe('ETAP fixture → AFX records (draft captions)', () => {
  const tpl = getToolTemplate('etap');
  const { rows } = rowsFromCsv(readFixture('etap_result_analyzer_sample.csv'));
  const out = applyTemplate(rows, tpl);

  test('all rows map; PPE Category dropped; shock boundaries recognized-but-unmapped', () => {
    expect(out.records).toHaveLength(5);
    expect(out.columnReport.unknown).toEqual([]);
    expect(out.columnReport.ignoredByPolicy.map((c) => c.header)).toContain('PPE Category');
    for (const r of out.records) expect(r).not.toHaveProperty('ppeCategory');
    const known = out.columnReport.knownUnmapped.map((c) => c.header);
    expect(known).toEqual(expect.arrayContaining(['Limited Approach Boundary', 'Restricted Approach Boundary']));
  });

  test('exact values + conversions (kV→V, s→ms, ft→in)', () => {
    const r0 = out.records[0];
    expect(r0.busName).toBe('FICTION-SUB2A');
    expect(r0.nominalVoltageV).toBe(13800);
    expect(r0.boltedFaultCurrentKA).toBe(18.241);
    expect(r0.arcingCurrentKA).toBe(16.506);
    expect(r0.clearingTimeMs).toBe(350); // 0.35 s
    expect(r0.workingDistanceIn).toBe(36);
    expect(r0.incidentEnergyCalCm2).toBe(8.9);
    expect(r0.arcFlashBoundaryIn).toBe(88.8); // 7.4 ft * 12
    expect(r0.conductorGapMm).toBe(152);
    expect(r0.electrodeConfig).toBe('HCB');
    expect(r0.deviceModel).toBe('FICTION-REL-86A');
    expect(out.records[2].clearingTimeMs).toBe(8.3); // 0.0083 s
  });
});

describe('issue paths: unknown columns and missing required fields', () => {
  const tpl = getToolTemplate('etap');

  test('unknown columns are reported by header', () => {
    const out = applyTemplate([{ 'Bus ID': 'FICTION-X', 'Nominal kV': '0.48', 'Mystery Column': '42' }], tpl);
    expect(out.columnReport.unknown).toEqual(['Mystery Column']);
    expect(out.summary.unknownColumns).toBe(1);
  });

  test('no bus-name column → clear aggregate error naming the AFX field', () => {
    const out = applyTemplate([{ 'Ibf (kA)': '10' }], tpl);
    expect(out.summary.missingRequired).toEqual(expect.arrayContaining(['busName', 'nominalVoltageV']));
    expect(out.issues.some((i) => i.kind === 'error' && /required AFX field busName/.test(i.issue))).toBe(true);
  });

  test('bus column present but a row leaves it blank → per-row error', () => {
    const out = applyTemplate([
      { 'Bus ID': 'FICTION-OK', 'Nominal kV': '0.48' },
      { 'Bus ID': '', 'Nominal kV': '0.48' },
    ], tpl);
    const rowErrs = out.issues.filter((i) => i.kind === 'error' && i.row === 2);
    expect(rowErrs.some((i) => /missing busName/.test(i.issue))).toBe(true);
  });

  test('non-numeric value in a converted column → per-row error naming the unit', () => {
    const out = applyTemplate([{ 'Bus ID': 'FICTION-X', 'Nominal kV': 'lots' }], tpl);
    expect(out.records[0]).not.toHaveProperty('nominalVoltageV');
    expect(out.issues.some((i) => i.row === 1 && /not a number \(expected kV/.test(i.issue))).toBe(true);
  });
});

describe('afxRecordsToTables → existing multi-table pipeline', () => {
  test('fixture-derived tables pass validateMultiTable (the source of truth)', () => {
    const tpl = getToolTemplate('etap');
    const { rows } = rowsFromCsv(readFixture('etap_result_analyzer_sample.csv'));
    const { records } = applyTemplate(rows, tpl);
    const tables = afxRecordsToTables(records);
    expect(tables.buses).toHaveLength(5);
    expect(tables.devices).toHaveLength(5);
    expect(tables.cables).toHaveLength(0);
    expect(tables.transformers).toHaveLength(0);
    expect(tables.buses[0].busId).toBe('FICTION-SUB2A');
    expect(tables.buses[0].nominalVoltageV).toBe(13800);
    expect(tables.devices[0].protectsBusId).toBe('FICTION-SUB2A');
    const v = validateMultiTable(tables);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  test('duplicate device names get collision-safe ids', () => {
    const tables = afxRecordsToTables([
      { busName: 'A', deviceModel: 'BRK-1' },
      { busName: 'B', deviceModel: 'BRK-1' },
    ]);
    expect(tables.devices.map((d) => d.deviceId)).toEqual(['BRK-1', 'BRK-1_2']);
  });
});
