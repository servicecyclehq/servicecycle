'use strict';

/**
 * Unit coverage for lib/measurementSanity.ts — physical-plausibility validator
 * for test-report measurements and nameplate OCR confidence downgrades.
 *
 * Pure-function suite: no DB, no server.  Esbuild transform handles the TS.
 * Pattern mirrors server/tests/arcFlashSanity.test.js.
 */

const {
  checkMeasurement,
  checkMeasurements,
  applyNameplateDowngrades,
} = require('../lib/measurementSanity');

// ── helpers ───────────────────────────────────────────────────────────────────

function codes(findings) {
  return findings.map((f) => f.code);
}

function severity(findings, code) {
  const f = findings.find((x) => x.code === code);
  return f ? f.severity : null;
}

// ── checkMeasurement: insulation resistance ───────────────────────────────────

describe('checkMeasurement — insulation resistance', () => {
  test('flags IR = 0 (physically impossible)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 0 });
    expect(codes(f)).toContain('ir_not_positive');
    expect(severity(f, 'ir_not_positive')).toBe('error');
  });

  test('flags IR < 0 (deliberately impossible value: −5 MΩ)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: -5 });
    expect(codes(f)).toContain('ir_not_positive');
  });

  test('does NOT flag valid IR of 1250 MΩ', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 1250 });
    expect(codes(f)).not.toContain('ir_not_positive');
  });

  test('does NOT flag very small positive IR (0.01 MΩ — marginal but possible)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 0.01 });
    expect(codes(f)).not.toContain('ir_not_positive');
  });

  test('does NOT flag when value is absent (null)', () => {
    expect(checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: null })).toHaveLength(0);
  });
});

// ── checkMeasurement: polarization index ─────────────────────────────────────

describe('checkMeasurement — polarization index', () => {
  test('flags PI = 0.5 as error (physically impossible: ratio cannot be < 1)', () => {
    const f = checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 0.5 });
    expect(codes(f)).toContain('pi_below_minimum');
    expect(severity(f, 'pi_below_minimum')).toBe('error');
  });

  test('flags PI = 0 as error', () => {
    const f = checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 0 });
    expect(codes(f)).toContain('pi_below_minimum');
  });

  test('flags PI = −1 as error (deliberately impossible)', () => {
    const f = checkMeasurement({ measurementType: 'polarization_index', asFoundValue: -1 });
    expect(codes(f)).toContain('pi_below_minimum');
  });

  test('flags PI = 15 as warning (extreme; OCR artefact)', () => {
    const f = checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 15 });
    expect(codes(f)).toContain('pi_above_maximum');
    expect(severity(f, 'pi_above_maximum')).toBe('warning');
  });

  test('boundary: PI = 1.0 is valid', () => {
    expect(codes(checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 1.0 }))).not.toContain('pi_below_minimum');
  });

  test('boundary: PI = 10.0 is valid', () => {
    expect(codes(checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 10.0 }))).not.toContain('pi_above_maximum');
  });

  test('does NOT flag PI = 2.5 (typical acceptable reading)', () => {
    expect(checkMeasurement({ measurementType: 'polarization_index', asFoundValue: 2.5 })).toHaveLength(0);
  });
});

// ── checkMeasurement: contact resistance ─────────────────────────────────────

describe('checkMeasurement — contact resistance', () => {
  test('flags negative contact resistance (deliberately impossible: −1 µΩ)', () => {
    const f = checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: -1 });
    expect(codes(f)).toContain('contact_resistance_negative');
    expect(severity(f, 'contact_resistance_negative')).toBe('error');
  });

  test('flags OCR artefact: 480,000,000 µΩ (digit duplication)', () => {
    const f = checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: 480_000_000 });
    expect(codes(f)).toContain('contact_resistance_excessive');
    expect(severity(f, 'contact_resistance_excessive')).toBe('error');
  });

  test('flags value just above 10,000 µΩ (10,001)', () => {
    const f = checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: 10_001 });
    expect(codes(f)).toContain('contact_resistance_excessive');
  });

  test('boundary: 10,000 µΩ exactly is accepted', () => {
    expect(codes(checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: 10_000 }))).not.toContain('contact_resistance_excessive');
  });

  test('does NOT flag 0 µΩ (new contacts can read at instrument floor)', () => {
    const f = checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: 0 });
    expect(codes(f)).not.toContain('contact_resistance_negative');
    expect(codes(f)).not.toContain('contact_resistance_excessive');
  });

  test('does NOT flag typical healthy reading (50 µΩ)', () => {
    expect(checkMeasurement({ measurementType: 'contact_resistance', asFoundValue: 50 })).toHaveLength(0);
  });
});

// ── checkMeasurement: power factor ───────────────────────────────────────────

describe('checkMeasurement — power factor', () => {
  test('flags negative power factor (deliberately impossible: −1%)', () => {
    const f = checkMeasurement({ measurementType: 'power_factor', asFoundValue: -1 });
    expect(codes(f)).toContain('power_factor_negative');
    expect(severity(f, 'power_factor_negative')).toBe('error');
  });

  test('flags power factor of 101% (physically impossible)', () => {
    const f = checkMeasurement({ measurementType: 'power_factor', asFoundValue: 101 });
    expect(codes(f)).toContain('power_factor_exceeds_100');
    expect(severity(f, 'power_factor_exceeds_100')).toBe('error');
  });

  test('boundary: 0% is valid', () => {
    expect(checkMeasurement({ measurementType: 'power_factor', asFoundValue: 0 })).toHaveLength(0);
  });

  test('boundary: 100% is valid', () => {
    expect(checkMeasurement({ measurementType: 'power_factor', asFoundValue: 100 })).toHaveLength(0);
  });

  test('does NOT flag typical PF reading (4.5%)', () => {
    expect(checkMeasurement({ measurementType: 'power_factor', asFoundValue: 4.5 })).toHaveLength(0);
  });
});

// ── checkMeasurement: dissolved gas (DGA) ────────────────────────────────────

describe('checkMeasurement — dissolved gas (DGA)', () => {
  test('flags negative DGA (deliberately impossible: −5 ppm)', () => {
    const f = checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: -5 });
    expect(codes(f)).toContain('dga_negative');
    expect(severity(f, 'dga_negative')).toBe('error');
  });

  test('flags DGA of 50,000 ppm (OCR digit-duplication artefact)', () => {
    const f = checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: 50_000 });
    expect(codes(f)).toContain('dga_excessive');
    expect(severity(f, 'dga_excessive')).toBe('error');
  });

  test('flags DGA just above 10,000 ppm (10,001)', () => {
    expect(codes(checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: 10_001 }))).toContain('dga_excessive');
  });

  test('boundary: 10,000 ppm exactly is accepted', () => {
    expect(codes(checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: 10_000 }))).not.toContain('dga_excessive');
  });

  test('boundary: 0 ppm is accepted', () => {
    expect(checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: 0 })).toHaveLength(0);
  });

  test('does NOT flag normal acetylene reading (2 ppm)', () => {
    expect(checkMeasurement({ measurementType: 'dissolved_gas', asFoundValue: 2 })).toHaveLength(0);
  });
});

// ── checkMeasurement: test voltage ───────────────────────────────────────────

describe('checkMeasurement — test voltage plausibility', () => {
  test('flags test voltage of "0 VDC" (not positive)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 500, testVoltage: '0 VDC' });
    expect(codes(f)).toContain('test_voltage_not_positive');
    expect(severity(f, 'test_voltage_not_positive')).toBe('error');
  });

  test('flags deliberately impossible test voltage (100,000 VDC = 100 kV)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 1000, testVoltage: '100000 VDC' });
    expect(codes(f)).toContain('test_voltage_excessive');
    expect(severity(f, 'test_voltage_excessive')).toBe('error');
  });

  test('does NOT flag normal 1 kV test voltage', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 5000, testVoltage: '1000 VDC' });
    expect(codes(f)).not.toContain('test_voltage_not_positive');
    expect(codes(f)).not.toContain('test_voltage_excessive');
  });

  test('does NOT flag 25 kV test voltage (MV field test equipment)', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 9000, testVoltage: '25000 V' });
    expect(codes(f)).not.toContain('test_voltage_excessive');
  });

  test('boundary: 50 kV is accepted', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 9000, testVoltage: '50000 V' });
    expect(codes(f)).not.toContain('test_voltage_excessive');
  });

  test('does NOT flag when testVoltage is absent', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 5000 });
    expect(codes(f)).not.toContain('test_voltage_not_positive');
  });

  test('does NOT flag null testVoltage', () => {
    const f = checkMeasurement({ measurementType: 'insulation_resistance', asFoundValue: 5000, testVoltage: null });
    expect(codes(f)).not.toContain('test_voltage_not_positive');
  });
});

// ── checkMeasurements (batch) ─────────────────────────────────────────────────

describe('checkMeasurements — batch wrapper', () => {
  test('returns all findings across a mixed batch', () => {
    const measurements = [
      { measurementType: 'insulation_resistance', asFoundValue: -1 },       // error
      { measurementType: 'contact_resistance',    asFoundValue: 999_999 },  // error
      { measurementType: 'power_factor',          asFoundValue: 3.5 },      // clean
    ];
    const findings = checkMeasurements(measurements);
    expect(codes(findings)).toContain('ir_not_positive');
    expect(codes(findings)).toContain('contact_resistance_excessive');
    expect(findings).toHaveLength(2);
  });

  test('returns empty array for a batch of valid measurements', () => {
    const measurements = [
      { measurementType: 'insulation_resistance', asFoundValue: 1000 },
      { measurementType: 'contact_resistance',    asFoundValue: 75 },
      { measurementType: 'power_factor',          asFoundValue: 2.1 },
      { measurementType: 'dissolved_gas',         asFoundValue: 42 },
    ];
    expect(checkMeasurements(measurements)).toHaveLength(0);
  });

  test('handles empty array', () => {
    expect(checkMeasurements([])).toHaveLength(0);
  });

  test('handles null/undefined gracefully', () => {
    expect(checkMeasurements([null, undefined, {}])).toHaveLength(0);
  });
});

// ── applyNameplateDowngrades: voltage ─────────────────────────────────────────

describe('applyNameplateDowngrades — voltage', () => {
  function run(v) {
    const fields = { voltage: v };
    const conf = { voltage: 'high' };
    applyNameplateDowngrades(fields, conf);
    return conf.voltage;
  }

  test('flags zero voltage', () => { expect(run('0')).toBe('low'); });
  test('flags negative voltage string', () => { expect(run('-480')).toBe('low'); });
  test('flags OCR artefact: "480 million" (480000000 V)', () => { expect(run('480000000')).toBe('low'); });
  test('does NOT flag 480V', () => { expect(run('480')).toBe('high'); });
  test('does NOT flag 4.16kV (parsed to 4160 V)', () => { expect(run('4.16kV')).toBe('high'); });
  test('does NOT flag 13800V (13.8 kV class)', () => { expect(run('13800')).toBe('high'); });
  test('does NOT flag 480 VAC (with unit suffix)', () => { expect(run('480 VAC')).toBe('high'); });
  test('does NOT flag null voltage field (not present)', () => {
    const fields = {};
    const conf = { voltage: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.voltage).toBe('high');
  });
});

// ── applyNameplateDowngrades: kva ─────────────────────────────────────────────

describe('applyNameplateDowngrades — kva', () => {
  function run(k) {
    const fields = { kva: k };
    const conf = { kva: 'high' };
    applyNameplateDowngrades(fields, conf);
    return conf.kva;
  }

  test('flags kva = 0', () => { expect(run('0')).toBe('low'); });
  test('flags negative kva', () => { expect(run('-100')).toBe('low'); });
  test('flags deliberately impossible kva (999,999,999,999)', () => { expect(run('999999999999')).toBe('low'); });
  test('does NOT flag 500 kVA', () => { expect(run('500')).toBe('high'); });
  test('does NOT flag 1000 kVA', () => { expect(run('1000')).toBe('high'); });
  test('does NOT flag 75 kVA (distribution transformer)', () => { expect(run('75')).toBe('high'); });
});

// ── applyNameplateDowngrades: amperage ────────────────────────────────────────

describe('applyNameplateDowngrades — amperage', () => {
  function run(a) {
    const fields = { amperage: a };
    const conf = { amperage: 'high' };
    applyNameplateDowngrades(fields, conf);
    return conf.amperage;
  }

  test('flags zero amperage', () => { expect(run('0')).toBe('low'); });
  test('flags deliberately impossible amperage (9,999,999 A)', () => { expect(run('9999999')).toBe('low'); });
  test('flags negative amperage', () => { expect(run('-100')).toBe('low'); });
  test('does NOT flag 800A', () => { expect(run('800')).toBe('high'); });
  test('does NOT flag 2000A', () => { expect(run('2000')).toBe('high'); });
  test('does NOT flag 100A (small panel breaker)', () => { expect(run('100')).toBe('high'); });
});

// ── applyNameplateDowngrades: enclosureRating ─────────────────────────────────

describe('applyNameplateDowngrades — enclosureRating', () => {
  function run(e) {
    const fields = { enclosureRating: e };
    const conf = { enclosureRating: 'high' };
    applyNameplateDowngrades(fields, conf);
    return conf.enclosureRating;
  }

  // Valid NEMA types
  test('does NOT flag NEMA type 1', () => { expect(run('1')).toBe('high'); });
  test('does NOT flag NEMA type 4', () => { expect(run('4')).toBe('high'); });
  test('does NOT flag NEMA type 4X', () => { expect(run('4X')).toBe('high'); });
  test('does NOT flag NEMA type 3R', () => { expect(run('3R')).toBe('high'); });
  test('does NOT flag NEMA type 3RX', () => { expect(run('3RX')).toBe('high'); });
  test('does NOT flag NEMA type 3S', () => { expect(run('3S')).toBe('high'); });
  test('does NOT flag NEMA type 12', () => { expect(run('12')).toBe('high'); });
  test('does NOT flag NEMA type 12K', () => { expect(run('12K')).toBe('high'); });
  test('does NOT flag NEMA type 13', () => { expect(run('13')).toBe('high'); });
  test('does NOT flag NEMA type 6P', () => { expect(run('6P')).toBe('high'); });
  test('does NOT flag "NEMA 4X" (with prefix)', () => { expect(run('NEMA 4X')).toBe('high'); });

  // Valid IP codes
  test('does NOT flag IP65', () => { expect(run('IP65')).toBe('high'); });
  test('does NOT flag IP67', () => { expect(run('IP67')).toBe('high'); });
  test('does NOT flag IP69K', () => { expect(run('IP69K')).toBe('high'); });
  test('does NOT flag IP54', () => { expect(run('IP54')).toBe('high'); });

  // Invalid / garbage
  test('flags free-form text "weatherproof"', () => { expect(run('weatherproof')).toBe('low'); });
  test('flags OCR garbage "4X77Z"', () => { expect(run('4X77Z')).toBe('low'); });
  test('flags arbitrary string "sealed"', () => { expect(run('sealed')).toBe('low'); });
  test('flags empty string', () => { expect(run('')).toBe('low'); });
  test('flags whitespace-only string', () => { expect(run('   ')).toBe('low'); });
});

// ── applyNameplateDowngrades: existing checks still work ─────────────────────

describe('applyNameplateDowngrades — existing checks preserved', () => {
  test('serial number with no digits → low confidence', () => {
    const fields = { serialNumber: 'ABCDEF' };
    const conf = { serialNumber: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.serialNumber).toBe('low');
  });

  test('serial number with digits → unchanged', () => {
    const fields = { serialNumber: 'ABC123' };
    const conf = { serialNumber: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.serialNumber).toBe('high');
  });

  test('year outside 1900–2100 → low confidence', () => {
    const fields = { year: 1800 };
    const conf = { year: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.year).toBe('low');
  });

  test('year within 1900–2100 → unchanged', () => {
    const fields = { year: 2015 };
    const conf = { year: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.year).toBe('high');
  });

  test('phases = 2 (invalid) → low confidence', () => {
    const fields = { phases: 2 };
    const conf = { phases: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.phases).toBe('low');
  });

  test('phases = 3 (valid) → unchanged', () => {
    const fields = { phases: 3 };
    const conf = { phases: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.phases).toBe('high');
  });

  test('phases = 1 (valid single-phase) → unchanged', () => {
    const fields = { phases: 1 };
    const conf = { phases: 'high' };
    applyNameplateDowngrades(fields, conf);
    expect(conf.phases).toBe('high');
  });

  test('absent fields → unchanged confidence', () => {
    const fields = {};
    const conf = { serialNumber: 'high', year: 'medium', phases: 'high', voltage: 'medium', kva: 'medium', amperage: 'high', enclosureRating: 'medium' };
    applyNameplateDowngrades(fields, conf);
    // Nothing should be downgraded when fields are absent
    expect(conf.serialNumber).toBe('high');
    expect(conf.voltage).toBe('medium');
    expect(conf.enclosureRating).toBe('medium');
  });
});
