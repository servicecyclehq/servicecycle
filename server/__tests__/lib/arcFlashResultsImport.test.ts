/**
 * Unit tests for the Slice 3.5b stamped-results CSV import (parser + matcher).
 */
import { parseCsv, parseResultsCsv, matchResults } from '../../lib/arcFlashResultsImport';

describe('parseCsv', () => {
  test('handles quoted commas and escaped quotes', () => {
    const m = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n');
    expect(m).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });
});

describe('parseResultsCsv — tolerant headers', () => {
  test('maps common header aliases', () => {
    const csv = 'Site,Bus,Incident Energy (cal/cm2),AFB,PPE Category,Arc Rating\nRiverside,MCC-7,8.4,36,2,8';
    const { rows, recognized, errors } = parseResultsCsv(csv);
    expect(errors).toHaveLength(0);
    expect(recognized).toEqual(expect.arrayContaining(['incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'ppeCategory', 'requiredArcRatingCalCm2']));
    expect(rows[0]).toMatchObject({ site: 'Riverside', busName: 'MCC-7', incidentEnergyCalCm2: 8.4, arcFlashBoundaryIn: 36, ppeCategory: 2, requiredArcRatingCalCm2: 8 });
  });

  test('errors when no Bus column', () => {
    const { errors } = parseResultsCsv('Foo,Bar\n1,2');
    expect(errors[0]).toMatch(/bus/i);
  });

  test('skips rows with no bus name', () => {
    const { rows } = parseResultsCsv('Bus,IE\nMCC-7,8\n,5\nMCC-8,12');
    expect(rows.map(r => r.busName)).toEqual(['MCC-7', 'MCC-8']);
  });
});

describe('matchResults', () => {
  const buses = [
    { id: 'b1', busName: 'MCC-7', site: 'Riverside', incidentEnergyCalCm2: 6, arcFlashBoundaryIn: null, ppeCategory: null, requiredArcRatingCalCm2: null, workingDistanceIn: 18 },
    { id: 'b2', busName: 'SWGR-1', site: 'Riverside', incidentEnergyCalCm2: null },
    { id: 'b3', busName: 'MCC-7', site: 'Other Plant', incidentEnergyCalCm2: null },
  ];

  test('matches on (site, bus) and reports only changed fields', () => {
    const { rows } = parseResultsCsv('Site,Bus,IE,AFB\nRiverside,MCC-7,8.4,36');
    const { updates, unmatched } = matchResults(rows, buses);
    expect(unmatched).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0].busId).toBe('b1');
    expect(updates[0].changes.incidentEnergyCalCm2).toEqual({ from: 6, to: 8.4 });
    expect(updates[0].changes.arcFlashBoundaryIn).toEqual({ from: null, to: 36 });
  });

  test('ambiguous bus-only match (duplicate name, no site) is left unmatched', () => {
    const { rows } = parseResultsCsv('Bus,IE\nMCC-7,9');
    const { updates, unmatched } = matchResults(rows, buses);
    expect(updates).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  test('unique bus-only match works', () => {
    const { rows } = parseResultsCsv('Bus,IE\nSWGR-1,10');
    const { updates } = matchResults(rows, buses);
    expect(updates[0]?.busId).toBe('b2');
  });

  test('no-op when values already match', () => {
    const { rows } = parseResultsCsv('Site,Bus,IE\nRiverside,MCC-7,6');
    const { updates } = matchResults(rows, buses);
    expect(updates).toHaveLength(0);
  });
});
