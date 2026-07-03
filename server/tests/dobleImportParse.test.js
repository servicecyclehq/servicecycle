'use strict';

/**
 * lib/dobleImport pure-parse contract (Doble TestGuide/TDMS import, 2026-07).
 *
 * Covers the format-detection + normalize half of the Doble on-ramp:
 *   - detectFormat: XML vs CSV by content and by filename, with content override
 *   - parseDobleExport of BOTH synthetic fixtures (XML + CSV) yields the SAME
 *     normalized shape: 2 assets, each PF(3) + TTR(3) + DGA(5) = 11 readings
 *   - canonical measurementType mapping (power_factor / turns_ratio /
 *     dissolved_gas) so downstream drift analysis recognizes the readings
 *   - value passthrough (no engineering derivation) + report-verdict mapping
 *     (PASS->GREEN, FAIL->RED)
 *   - toCommitMeasurements shape matches what commitAssetReadings consumes
 *   - a malformed/empty input degrades to issues instead of throwing
 *
 * Pure module — no DB, no express. Reads the committed fixtures from
 * server/data/doble/fixtures.
 */

const fs = require('fs');
const path = require('path');
const {
  detectFormat, parseDobleExport, toCommitMeasurements, assetTestDate, DOBLE_SCHEMA_VERSION,
} = require('../lib/dobleImport');

const FIX = path.join(__dirname, '..', 'data', 'doble', 'fixtures');
const xml = fs.readFileSync(path.join(FIX, 'doble_transformers_testguide.xml'), 'utf8');
const csv = fs.readFileSync(path.join(FIX, 'doble_transformers_testguide.csv'), 'utf8');

describe('detectFormat', () => {
  test('recognizes XML by prolog', () => {
    expect(detectFormat(xml)).toBe('xml');
  });
  test('recognizes CSV by comma header', () => {
    expect(detectFormat(csv)).toBe('csv');
  });
  test('filename .xml forces xml; .csv forces csv', () => {
    expect(detectFormat('anything,at,all', 'x.xml')).toBe('xml');
    expect(detectFormat('a,b,c\n1,2,3', 'x.csv')).toBe('csv');
  });
  test('content overrides a mislabeled .csv that is really XML', () => {
    expect(detectFormat('<?xml version="1.0"?><Root/>', 'export.csv')).toBe('xml');
  });
});

describe('parseDobleExport — XML fixture', () => {
  const r = parseDobleExport(xml, 'doble_transformers_testguide.xml');

  test('detects format + schema version + 2 assets', () => {
    expect(r.format).toBe('xml');
    expect(r.schemaVersion).toBe(DOBLE_SCHEMA_VERSION);
    expect(r.assetCount).toBe(2);
  });

  test('asset identity is read from elements', () => {
    const a = r.assets[0];
    expect(a.identity.serialNumber).toBe('TX-4400-A');
    expect(a.identity.manufacturer).toBe('Fictional Transformer Co');
    expect(a.identity.model).toBe('OA-2500');
    expect(a.identity.location).toContain('Cedar Ridge');
  });

  test('each asset has PF + TTR + DGA = 11 readings', () => {
    for (const a of r.assets) {
      expect(a.tests.length).toBe(3);
      expect(a.measurementCount).toBe(11);
    }
    expect(r.measurementCount).toBe(22);
  });

  test('canonical measurementType mapping', () => {
    const a = r.assets[0];
    const byType = {};
    for (const t of a.tests) for (const rd of t.readings) byType[rd.measurementType] = (byType[rd.measurementType] || 0) + 1;
    expect(byType.power_factor).toBe(3);
    expect(byType.turns_ratio).toBe(3);
    expect(byType.dissolved_gas).toBe(5);
  });

  test('value passthrough + verdict mapping (no derivation)', () => {
    const pf = r.assets[0].tests.find((t) => t.testType.toLowerCase().includes('power'));
    const chl = pf.readings.find((x) => x.name === 'CHL');
    expect(chl.value).toBe(0.31);       // exact passthrough
    expect(chl.unit).toBe('%PF');
    expect(chl.result).toBe('GREEN');   // PASS -> GREEN

    // Asset B CHL is FAIL -> RED
    const pfB = r.assets[1].tests.find((t) => t.testType.toLowerCase().includes('power'));
    const chlB = pfB.readings.find((x) => x.name === 'CHL');
    expect(chlB.value).toBe(0.58);
    expect(chlB.result).toBe('RED');
  });

  test('captures test date, ambient, and instrument provenance', () => {
    const a = r.assets[0];
    expect(assetTestDate(a)).toBe('2026-05-10');
    const pf = a.tests[0];
    expect(pf.ambientC).toBe(21.5);
    expect(pf.testSet).toEqual({ make: 'Doble', model: 'M4100', serial: 'M4100-0001' });
  });
});

describe('parseDobleExport — CSV fixture', () => {
  const r = parseDobleExport(csv, 'doble_transformers_testguide.csv');

  test('detects CSV + 2 assets + same 22 readings as XML', () => {
    expect(r.format).toBe('csv');
    expect(r.assetCount).toBe(2);
    expect(r.measurementCount).toBe(22);
  });

  test('long-form rows collapse into 3 tests per asset', () => {
    for (const a of r.assets) {
      expect(a.tests.length).toBe(3); // PF, TTR, DGA
      expect(a.measurementCount).toBe(11);
    }
  });

  test('CSV and XML normalize to equivalent readings for asset A', () => {
    const rx = parseDobleExport(xml).assets[0];
    const rc = r.assets[0];
    const flat = (a) => a.tests.flatMap((t) => t.readings.map((x) => `${x.measurementType}|${x.phase || ''}|${x.value}|${x.unit || ''}|${x.result || ''}`)).sort();
    expect(flat(rc)).toEqual(flat(rx));
  });
});

describe('toCommitMeasurements', () => {
  test('produces the field shape commitAssetReadings consumes', () => {
    const r = parseDobleExport(xml);
    const ms = toCommitMeasurements(r.assets[0]);
    expect(ms.length).toBe(11);
    const chl = ms.find((m) => m.label.includes('CHL'));
    expect(chl).toMatchObject({
      measurementType: 'power_factor',
      phase: 'H',
      asFoundValue: 0.31,
      asFoundUnit: '%PF',
      passFail: 'GREEN',
    });
    expect(typeof chl.notes).toBe('string');
    expect(chl.notes).toContain('doble:');
  });
});

describe('resilience', () => {
  test('empty/garbage input returns issues, does not throw', () => {
    const r = parseDobleExport('not a real file at all');
    expect(r.assetCount).toBe(0);
    expect(Array.isArray(r.issues)).toBe(true);
  });
  test('XML with no <Asset> notes the shape mismatch', () => {
    const r = parseDobleExport('<?xml version="1.0"?><DobleTestData></DobleTestData>');
    expect(r.format).toBe('xml');
    expect(r.assetCount).toBe(0);
    expect(r.issues.join(' ')).toMatch(/Asset/i);
  });
  test('an asset missing a serial records an identity issue', () => {
    const noSerial = '<?xml version="1.0"?><Root><Asset><Model>OA-1</Model>' +
      '<TestSession><TestDate>2026-01-01</TestDate><Test type="PowerFactor">' +
      '<Reading name="CHL" value="0.3" unit="%PF" result="PASS"/></Test></TestSession></Asset></Root>';
    const r = parseDobleExport(noSerial);
    expect(r.assetCount).toBe(1);
    expect(r.assets[0].identity.serialNumber).toBeNull();
    expect(r.assets[0].issues.join(' ')).toMatch(/serial/i);
  });
});
