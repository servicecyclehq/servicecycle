/**
 * Unit tests for the Slice 3e deterministic NL facility-search parser + matcher.
 */
import { parseQuery, matchRow } from '../../lib/arcFlashSearch';

describe('parseQuery — facet extraction', () => {
  test('voltage in V and kV', () => {
    expect(parseQuery('480v panels').filters.voltageV).toBe(480);
    expect(parseQuery('13.8kv switchgear').filters.voltageV).toBe(13800);
  });

  test('equipment class keywords', () => {
    expect(parseQuery('MCC buckets').filters.equipmentType).toBe('MCC');
    expect(parseQuery('show me switchgear').filters.equipmentType).toBe('SWITCHGEAR');
    expect(parseQuery('panelboards').filters.equipmentType).toBe('PANELBOARD');
  });

  test('incident-energy comparisons', () => {
    expect(parseQuery('over 8 cal').filters.ieMin).toBe(8);
    expect(parseQuery('under 25 cal').filters.ieMax).toBe(25);
    const b = parseQuery('between 8 and 40 cal').filters;
    expect(b.ieMin).toBe(8); expect(b.ieMax).toBe(40);
  });

  test('severity, confidence, lifecycle, blocked', () => {
    expect(parseQuery('danger buses').filters.severity).toBe('danger');
    expect(parseQuery('low confidence').filters.band).toBe('red');
    expect(parseQuery('trust under 50').filters.confMax).toBe(50);
    expect(parseQuery('expired studies').filters.expired).toBe(true);
    expect(parseQuery('expiring soon').filters.expiring).toBe(true);
    expect(parseQuery('missing inputs').filters.blocked).toBe(true);
  });

  test('compound query records every recognized facet', () => {
    const p = parseQuery('480V MCC over 8 cal that are blocked with low confidence');
    expect(p.filters.voltageV).toBe(480);
    expect(p.filters.equipmentType).toBe('MCC');
    expect(p.filters.ieMin).toBe(8);
    expect(p.filters.blocked).toBe(true);
    expect(p.filters.band).toBe('red');
    expect(p.recognized.length).toBeGreaterThanOrEqual(5);
    expect(p.unrecognized).toBe(false);
  });

  test('gibberish is flagged unrecognized', () => {
    expect(parseQuery('asdf qwerty').unrecognized).toBe(true);
    expect(parseQuery('').unrecognized).toBe(false);
  });
});

describe('matchRow', () => {
  const row = {
    nominalVoltage: '480V', equipmentType: 'MCC', incidentEnergyCalCm2: 12,
    labelSeverity: 'warning', confidence: { score: 40, band: 'red' }, expired: false, expiringSoon: true, readiness: 'blocked',
  };

  test('matches a compound query', () => {
    const { filters } = parseQuery('480V MCC over 8 cal blocked low confidence');
    expect(matchRow(row, filters)).toBe(true);
  });

  test('voltage tolerance accepts 480Y/277 style labels', () => {
    expect(matchRow({ ...row, nominalVoltage: '480Y/277V' }, { voltageV: 480 })).toBe(true);
    expect(matchRow({ ...row, nominalVoltage: '208V' }, { voltageV: 480 })).toBe(false);
  });

  test('ieMin is strict greater-than', () => {
    expect(matchRow({ ...row, incidentEnergyCalCm2: 8 }, { ieMin: 8 })).toBe(false);
    expect(matchRow({ ...row, incidentEnergyCalCm2: 9 }, { ieMin: 8 })).toBe(true);
  });

  test('severity / band / blocked filters', () => {
    expect(matchRow(row, { severity: 'danger' })).toBe(false);
    expect(matchRow(row, { severity: 'warning' })).toBe(true);
    expect(matchRow(row, { band: 'green' })).toBe(false);
    expect(matchRow({ ...row, readiness: 'ready' }, { blocked: true })).toBe(false);
  });

  test('expiring vs expired', () => {
    expect(matchRow(row, { expiring: true })).toBe(true);
    expect(matchRow(row, { expired: true })).toBe(false);
  });
});
