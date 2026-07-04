'use strict';

// Nameplate domain-consistency validators (2026-07-03).
// Pure logic — no prisma, no ai, no env. Mirrors the pattern in
// ingestGateDomainValidators.test.js.

jest.mock('../lib/prisma', () => ({ default: {} }));
jest.mock('../lib/ai', () => ({ complete: jest.fn(), completeWithImage: jest.fn(), parseJSON: jest.fn() }));

const {
  checkNameplateConsistency,
  checkNameplateEvidence,
  parseVoltageComponents,
  STD_KVA_1PH,
  STD_KVA_3PH,
  STD_VOLTAGES,
  STD_FREQ,
} = require('../lib/nameplateValidators');

// ── helpers ──────────────────────────────────────────────────────────────
function fresh(fields) {
  // Simulate the { field: 'high'|'medium'|'low' } map the route builds after
  // applyNameplateDowngrades. Start every present field at 'high' so the
  // validators' job (pulling suspects DOWN) is unambiguous.
  const conf = {};
  for (const k of Object.keys(fields)) {
    if (fields[k] != null && fields[k] !== '') conf[k] = 'high';
  }
  return conf;
}

describe('parseVoltageComponents', () => {
  test('single voltage', () => {
    expect(parseVoltageComponents('480V')).toEqual([480]);
    expect(parseVoltageComponents('480')).toEqual([480]);
  });
  test('dual voltage with slash', () => {
    expect(parseVoltageComponents('480/277V')).toEqual([480, 277]);
    expect(parseVoltageComponents('480Y/277')).toEqual([480, 277]);
  });
  test('multi-tap with dash', () => {
    expect(parseVoltageComponents('4160-480V')).toEqual([4160, 480]);
  });
  test('kV suffix applies to all components', () => {
    expect(parseVoltageComponents('13.8kV')).toEqual([13800]);
  });
  test('empty / null', () => {
    expect(parseVoltageComponents(null)).toEqual([]);
    expect(parseVoltageComponents('')).toEqual([]);
    expect(parseVoltageComponents('   ')).toEqual([]);
  });
});

describe('reference ladders', () => {
  test('STD_KVA_3PH covers common power ratings', () => {
    for (const v of [75, 112.5, 150, 500, 1500, 2500]) {
      expect(STD_KVA_3PH.includes(v)).toBe(true);
    }
  });
  test('STD_VOLTAGES includes both system and motor-utilization values', () => {
    for (const v of [120, 208, 240, 277, 480, 4160, 13800]) {
      expect(STD_VOLTAGES.includes(v)).toBe(true);
    }
    // NEMA MG-1 utilization voltages (motor plates):
    for (const v of [115, 230, 460, 575]) {
      expect(STD_VOLTAGES.includes(v)).toBe(true);
    }
  });
  test('STD_FREQ = {50, 60}', () => {
    expect(STD_FREQ.has(50)).toBe(true);
    expect(STD_FREQ.has(60)).toBe(true);
    expect(STD_FREQ.has(400)).toBe(false);
  });
});

describe('V1 — duplicate-value across fields', () => {
  test('the canonical bug: kva=60 next to frequency="60 Hz" downgrades kva', () => {
    const fields = { kva: 60, voltage: '480V', amperage: '90A', phases: 3, frequency: '60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.kva).toBe('low');
    expect(conf.frequency).toBe('high'); // frequency is the stronger prior — untouched
    expect(out.some((f) => f.code === 'kva_equals_frequency')).toBe(true);
  });
  test('50 IS a standard kVA — but still downgrades when it duplicates frequency', () => {
    // 50 kVA is on the 3ph ladder, but sitting next to a 50 Hz frequency
    // is still the same adjacent-grab signal. Human confirms.
    const fields = { kva: 50, voltage: '400V', amperage: '72A', phases: 3, frequency: '50 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.kva).toBe('low');
    expect(out.some((f) => f.code === 'kva_equals_frequency')).toBe(true);
  });
  test('small amperage that equals frequency downgrades', () => {
    const fields = { kva: 30, voltage: '480V', amperage: 60, phases: 3, frequency: '60 Hz' };
    const conf = fresh(fields);
    checkNameplateConsistency(fields, conf);
    expect(conf.amperage).toBe('low');
  });
  test('large amperage that happens to numerically match freq does NOT falsely fire', () => {
    // A 3000 kVA / 480V unit has amps ≈ 3600. If a nameplate lists 60 Hz + say
    // 6000 A, we should not flag amperage. Guard: only fires when ampNum < 200.
    const fields = { kva: 3000, voltage: '480V', amperage: 3600, phases: 3, frequency: '60 Hz' };
    const conf = fresh(fields);
    checkNameplateConsistency(fields, conf);
    expect(conf.amperage).toBe('high');
  });
});

describe('V2 — kVA standard-ladder', () => {
  test('75 kVA 3-phase is on the ladder — no flag', () => {
    const fields = { kva: 75, phases: 3, voltage: '480V', amperage: '90A', frequency: '60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_not_standard_size')).toBe(false);
  });
  test('60 kVA is OFF the ladder on BOTH ladders (catches the observed bug)', () => {
    const fields = { kva: 60, phases: 3 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.kva).toBe('low');
    expect(out.some((f) => f.code === 'kva_not_standard_size')).toBe(true);
  });
  test('112.5 kVA (decimal-formatted plate) is on ladder', () => {
    const fields = { kva: 112.50, phases: 3 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_not_standard_size')).toBe(false);
  });
  test('phases unknown — accepts membership in EITHER ladder', () => {
    const fields = { kva: 167 }; // 167 kVA on the 1φ ladder
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_not_standard_size')).toBe(false);
  });
});

describe('V3 — voltage class', () => {
  test('480V is on the standard list', () => {
    const fields = { voltage: '480V' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(false);
  });
  test('motor utilization 460V is NOT false-flagged (NEMA MG-1)', () => {
    const fields = { voltage: '460V' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(false);
  });
  test('dual voltage 480/277V is on the list', () => {
    const fields = { voltage: '480Y/277V' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(false);
  });
  test('4.16kV → 4160V is on the ladder', () => {
    const fields = { voltage: '4.16kV' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(false);
  });
  test('nonsense voltage 999V falls outside all classes → flagged', () => {
    const fields = { voltage: '999V' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.voltage).toBe('low');
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(true);
  });
});

describe('V4 — √3·V·A/1000 relationship', () => {
  test('legit 75 kVA / 480V / 90.2A / 3φ passes', () => {
    // √3 · 480 · 90.2 / 1000 ≈ 74.99 — within ±20%
    const fields = { kva: 75, voltage: '480V', amperage: 90.2, phases: 3, frequency: '60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_va_relationship_mismatch')).toBe(false);
  });
  test('misread 60 kVA against ~50-kVA-class V·A fails', () => {
    // 60 kVA claimed, but voltage/amperage suggest ~50 kVA (>20% miss)
    // √3 · 480 · 60 / 1000 ≈ 49.9 — off by 20.2%
    const fields = { kva: 60, voltage: '480V', amperage: 60, phases: 3 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    // Kva-vs-freq trap won't fire (no frequency), but V4 catches the mismatch.
    expect(out.some((f) => f.code === 'kva_va_relationship_mismatch')).toBe(true);
  });
  test('1-phase relationship also handled', () => {
    // 10 kVA 240V 1φ → ~41.7 A
    const fields = { kva: 10, voltage: '240V', amperage: 41.7, phases: 1 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_va_relationship_mismatch')).toBe(false);
  });
  test('missing fields → skips silently (absence of evidence)', () => {
    const fields = { kva: 75, phases: 3 }; // no voltage/amperage
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'kva_va_relationship_mismatch')).toBe(false);
  });
});

describe('V5 — frequency set', () => {
  test('60 Hz is fine', () => {
    const fields = { frequency: '60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'frequency_not_standard')).toBe(false);
  });
  test('50/60 Hz plate → both parse, both standard → no flag', () => {
    const fields = { frequency: '50/60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'frequency_not_standard')).toBe(false);
  });
  test('OCR garbage "6.0 Hz" gets caught', () => {
    const fields = { frequency: '6.0 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.frequency).toBe('low');
    expect(out.some((f) => f.code === 'frequency_not_standard')).toBe(true);
  });
});

describe('V6 — year-adjacency check', () => {
  test('year that appears inside serial → flagged', () => {
    const fields = { year: 2008, serialNumber: 'ABC-2008-XYZ' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.year).toBe('low');
    expect(out.some((f) => f.code === 'year_may_be_model_fragment')).toBe(true);
  });
  test('year that appears inside model → flagged', () => {
    const fields = { year: 1998, model: 'ATV1998-100' };
    const conf = fresh(fields);
    checkNameplateConsistency(fields, conf);
    expect(conf.year).toBe('low');
  });
  test('year distinct from model → not flagged', () => {
    const fields = { year: 2015, model: 'TRAF-2500', serialNumber: 'A2C-39471-B' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'year_may_be_model_fragment')).toBe(false);
  });
});

describe('composite scenarios', () => {
  test('a fully-legit 75 kVA plate has ZERO findings', () => {
    // A 75 kVA 480V/277V 3φ 60 Hz transformer, year 2015, model TRAF-2500
    // (73 A on secondary, 90 A on primary — take the primary reading).
    const fields = {
      kva:          75,
      voltage:      '480V',
      amperage:     90.2,
      phases:       3,
      frequency:    '60 Hz',
      year:         2015,
      serialNumber: 'A2C-39471-B',
      model:        'TRAF-2500',
    };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out).toEqual([]);
    // Nothing downgraded.
    for (const k of Object.keys(fields)) {
      expect(conf[k]).toBe('high');
    }
  });

  test('the incident plate: kva=60, freq=60 Hz — flagged by BOTH V1 and V2', () => {
    // The observed s36 failure: OCR grabbed frequency into the kVA slot.
    const fields = { kva: 60, voltage: '480V', amperage: 60, phases: 3, frequency: '60 Hz' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.kva).toBe('low');
    // V1 fires (kva == freq value); V2 fires (60 not on 3φ ladder); V4 fires.
    const codes = out.map((f) => f.code);
    expect(codes).toContain('kva_equals_frequency');
    expect(codes).toContain('kva_not_standard_size');
  });

  test('blank plate — nothing to check, no crashes, empty result', () => {
    const fields = {};
    const conf = {};
    const out = checkNameplateConsistency(fields, conf);
    expect(out).toEqual([]);
  });

  test('null / undefined fields — validator never throws', () => {
    expect(() => checkNameplateConsistency(null, {})).not.toThrow();
    expect(() => checkNameplateConsistency(undefined, {})).not.toThrow();
    expect(() => checkNameplateConsistency({}, null)).not.toThrow();
  });

  test('motor plate at 460V (not false-flagged thanks to NEMA MG-1 voltages)', () => {
    const fields = { voltage: '460V', amperage: '52A', phases: 3, frequency: '60 Hz', year: 2020 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(out.some((f) => f.code === 'voltage_not_standard_class')).toBe(false);
  });
});

describe('V7 — evidence-string check', () => {
  test('kva field with a "60 Hz" evidence snippet → contradicted → low', () => {
    const fields = { kva: 60 };
    const conf = { kva: 'high' };
    const ev = { kva: '60 Hz' };
    const out = checkNameplateEvidence(fields, conf, ev);
    expect(conf.kva).toBe('low');
    expect(out.some((f) => f.code === 'evidence_label_mismatch')).toBe(true);
  });
  test('kva field with a proper "75 kVA" snippet → passes', () => {
    const fields = { kva: 75 };
    const conf = { kva: 'high' };
    const ev = { kva: '75 kVA' };
    const out = checkNameplateEvidence(fields, conf, ev);
    expect(conf.kva).toBe('high');
    expect(out).toEqual([]);
  });
  test('missing evidence for high-confidence field → cap at medium', () => {
    const fields = { kva: 75 };
    const conf = { kva: 'high' };
    const ev = {}; // no evidence
    checkNameplateEvidence(fields, conf, ev);
    expect(conf.kva).toBe('medium');
  });
  test('no evidence map at all → no-op', () => {
    const fields = { kva: 75 };
    const conf = { kva: 'high' };
    const out1 = checkNameplateEvidence(fields, conf, null);
    const out2 = checkNameplateEvidence(fields, conf, undefined);
    expect(out1).toEqual([]);
    expect(out2).toEqual([]);
    expect(conf.kva).toBe('high');
  });
  test('voltage snippet with correct "V" token → passes', () => {
    const fields = { voltage: '480V' };
    const conf = { voltage: 'high' };
    const ev = { voltage: '480 VOLTS' };
    checkNameplateEvidence(fields, conf, ev);
    expect(conf.voltage).toBe('high');
  });
  test('frequency snippet lacking Hz → flagged', () => {
    const fields = { frequency: '60' };
    const conf = { frequency: 'high' };
    const ev = { frequency: '60 kVA' };  // wrong label
    checkNameplateEvidence(fields, conf, ev);
    expect(conf.frequency).toBe('low');
  });
});
