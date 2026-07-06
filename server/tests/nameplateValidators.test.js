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
  test('single kV value scales', () => {
    expect(parseVoltageComponents('13.8kV')).toEqual([13800]);
  });
  test('empty / null', () => {
    expect(parseVoltageComponents(null)).toEqual([]);
    expect(parseVoltageComponents('')).toEqual([]);
    expect(parseVoltageComponents('   ')).toEqual([]);
  });

  // REGRESSION-LOCK (2026-07-05, W8-nameplate fallback hunt): each
  // component's OWN unit wins -- a whole-string kV flag must NOT scale a
  // component that explicitly says "V". Before this fix, "13.8kV/480V"
  // silently produced [13800, 480000] (the LV secondary off by 1000x)
  // instead of the correct [13800, 480].
  describe('mixed kV/V components -- each component keeps its own unit', () => {
    test('HV primary (kV) + LV secondary (V) in one field', () => {
      expect(parseVoltageComponents('13.8kV/480V')).toEqual([13800, 480]);
    });
    test('kV first, bare V-side second stays unscaled (not inflated 1000x)', () => {
      expect(parseVoltageComponents('4.16kV-480')).toEqual([4160, 480]);
    });
    test('a bare component does NOT inherit kV from a later explicit-kV component', () => {
      // Conservative by design: under-scaling a rare same-side multi-tap
      // label (13.8 stays 13.8, not 13800) is safer than the alternative of
      // inferring kV and risking over-scaling a genuine low-voltage value.
      // The under-scaled 13.8 still gets caught by V3's standard-voltage-
      // class check downstream, so it isn't a silent miss either way.
      expect(parseVoltageComponents('13.8/12.47kV')).toEqual([13.8, 12470]);
    });
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
  test('60 kVA is OFF every ladder (IEEE 1φ, IEEE 3φ, IEC) — SOFT downgrade to medium', () => {
    // 2026-07-04 calibration: V2 uses softDowngrade (medium, not low) because
    // legitimate specialty ratings exist. The hard "60 kva plate" catch comes
    // from V1 (kva == frequency value) and V4 (√3·V·A/1000 mismatch) — this
    // test isolates V2 alone.
    const fields = { kva: 60, phases: 3 };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.kva).toBe('medium');
    expect(out.some((f) => f.code === 'kva_not_standard_size')).toBe(true);
  });

  test('IEC-ladder specialty sizes (63, 80, 160, 630, 1250) pass V2 — no flag', () => {
    // Real IEC 60076 dry / oil transformer plates carry these ratings.
    // Pre-calibration they false-flagged against the ANSI-only ladder.
    for (const kva of [63, 80, 160, 630, 1250]) {
      const fields = { kva, phases: 3 };
      const conf = fresh(fields);
      const out = checkNameplateConsistency(fields, conf);
      expect(out.some((f) => f.code === 'kva_not_standard_size'))
        .toBe(false);
    }
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
  test('year that appears inside serial → SOFT downgrade to medium', () => {
    // 2026-07-04 calibration: many manufacturers legitimately encode the
    // manufacture year in the serial. V6 is a soft "verify" (medium), NOT a
    // hard flag (low). The finding still fires so the tech gets a tooltip.
    const fields = { year: 2008, serialNumber: 'ABC-2008-XYZ' };
    const conf = fresh(fields);
    const out = checkNameplateConsistency(fields, conf);
    expect(conf.year).toBe('medium');
    expect(out.some((f) => f.code === 'year_may_be_model_fragment')).toBe(true);
  });
  test('year that appears inside model → SOFT downgrade to medium', () => {
    const fields = { year: 1998, model: 'ATV1998-100' };
    const conf = fresh(fields);
    checkNameplateConsistency(fields, conf);
    expect(conf.year).toBe('medium');
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
  // [Resolved 2026-07-05, Dustin's call: "throw a red flag to the tech to
  // review and/or manually enter the data" — the Gemini->Groq fallback makes
  // total evidence-absence a live, everyday case, not just an old client.]
  test('no evidence map at all → soft-flags every high-confidence field for review', () => {
    const fields = { kva: 75 };
    const conf = { kva: 'high' };
    const out1 = checkNameplateEvidence(fields, conf, null);
    expect(out1.some((f) => f.code === 'no_evidence_map' && f.field === 'kva')).toBe(true);
    expect(conf.kva).toBe('medium');

    const conf2 = { kva: 'high' };
    const out2 = checkNameplateEvidence(fields, conf2, undefined);
    expect(out2.some((f) => f.code === 'no_evidence_map' && f.field === 'kva')).toBe(true);
    expect(conf2.kva).toBe('medium');
  });
  test('no evidence map at all → does not touch a field that is already low/medium', () => {
    const fields = { kva: 75 };
    const conf = { kva: 'low' };
    const out = checkNameplateEvidence(fields, conf, null);
    expect(out).toEqual([]);
    expect(conf.kva).toBe('low');
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

// ── 2026-07-04 calibration: broaden accepted vocabulary. Prompt goal:
//    cut the ~50% FP rate observed on the live 36-image run WITHOUT losing
//    the s03/s36 kVA==Hz-line hard catch. Regression-lock: hard catch stays;
//    every legitimate unit variant passes. ──────────────────────────────────
describe('V7 — 2026-07-04 vocabulary calibration', () => {
  // Helper: run V7 in isolation on a single-field snippet + return the finding
  // codes (if any) and the resulting confidence. Every case starts at 'high'.
  function runOne(field, value, sourceText) {
    const fields = { [field]: value };
    const conf   = { [field]: 'high' };
    const codes  = checkNameplateEvidence(fields, conf, { [field]: sourceText })
      .map((f) => f.code);
    return { conf: conf[field], codes };
  }

  // ── Frequency variants (the CYCLE/CYCLES/CPS/~/C-S vocabulary gap) ───────
  describe('frequency accepts legacy + international variants', () => {
    test.each([
      ['60 CYCLE',   '60 CYCLE'],                 // singular — real on 1950s plates
      ['60 CYCLES',  '60 CYCLES'],                // plural — the observed 36-image miss
      ['60 CPS',     '60 CPS'],                   // cycles per second — legacy shorthand
      ['60 C/S',     '60 C/S'],                   // same, formatted with slash
      ['60Hz',       '60Hz'],                     // glued
      ['60 Hz',      '60 Hz'],                    // canonical (baseline)
      ['60 HERTZ',   '60 HERTZ'],                 // spelled out
      ['50/60 Hz',   '50/60 Hz'],                 // dual
      ['60~',        '60~'],                      // European AC symbol
    ])('%s → passes (no downgrade, no flag)', (_desc, snippet) => {
      const { conf, codes } = runOne('frequency', '60 Hz', snippet);
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
  });

  // ── Voltage variants (VOLTS/VAC/VDC/KV — glued + spaced) ─────────────────
  describe('voltage accepts VAC / VDC / VOLTS / VOLTAGE / KV, glued or spaced', () => {
    test.each([
      ['480V',         '480V'],
      ['480 V',        '480 V'],
      ['480VAC',       '480VAC'],              // glued VAC (the observed miss)
      ['480 VAC',      '480 VAC'],
      ['480 VDC',      '480 VDC'],
      ['480 VOLTS',    '480 VOLTS'],
      ['480 VOLT',     '480 VOLT'],
      ['13.8 KV',      '13.8 KV'],
      ['13.8KV',       '13.8KV'],
      ['13.8 KILOVOLTS', '13.8 KILOVOLTS'],
      ['NAMEPLATE VOLTAGE 480V 3PH 60HZ', 'NAMEPLATE VOLTAGE 480V 3PH 60HZ'],
    ])('%s → passes', (_desc, snippet) => {
      const { conf, codes } = runOne('voltage', '480V', snippet);
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
  });

  // ── Amperage variants (AMP/AMPS/AMPERE/AMPERES/MA — glued + spaced) ──────
  describe('amperage accepts AMP / AMPS / AMPERES / MA, glued or spaced', () => {
    test.each([
      ['9.3 A',       '9.3 A'],
      ['9.3A',        '9.3A'],
      ['9.3 AMP',     '9.3 AMP'],
      ['9.3 AMPS',    '9.3 AMPS'],
      ['9.3AMPS',     '9.3AMPS'],                  // glued
      ['9.3 AMPERE',  '9.3 AMPERE'],
      ['9.3 AMPERES', '9.3 AMPERES'],
      ['50 MA',       '50 MA'],
      ['50 MILLIAMPS','50 MILLIAMPS'],
    ])('%s → passes', (_desc, snippet) => {
      const { conf, codes } = runOne('amperage', 9.3, snippet);
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
  });

  // ── kVA variants (KVA/KV-A/KVA./MVA/KILOVOLT-AMP) ────────────────────────
  describe('kva accepts KVA / KV-A / MVA / KILOVOLT-AMPERES', () => {
    test.each([
      ['75 KVA',                 '75 KVA'],
      ['75KVA',                  '75KVA'],
      ['75 kVA',                 '75 kVA'],
      ['75 KV-A',                '75 KV-A'],
      ['75 KV A',                '75 KV A'],
      ['75 KVA.',                '75 KVA.'],
      ['2 MVA',                  '2 MVA'],
      ['75 KILOVOLT-AMPERES',    '75 KILOVOLT-AMPERES'],
      ['75 KILOVOLT AMPS',       '75 KILOVOLT AMPS'],
    ])('%s → passes', (_desc, snippet) => {
      const { conf, codes } = runOne('kva', 75, snippet);
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });

    test('KVAR (reactive volt-amperes) does NOT count as kVA family', () => {
      // KVAR is a distinct quantity on power-factor plates. If the model's
      // kVA snippet only mentions KVAR, treat it as no-unit (soft) — not a
      // positive KVA match.
      const { conf, codes } = runOne('kva', 75, '15 KVAR');
      // 15 KVAR — no positive family, no foreign family → soft medium.
      expect(conf).toBe('medium');
      expect(codes).toContain('no_unit_in_evidence');
    });
  });

  // ── HARD CATCH regression-lock: the s03/s36 case must STILL flag ─────────
  describe('REGRESSION-LOCK: cross-family mismatch stays hard (low)', () => {
    test('kva field with a "60 Hz" snippet → HARD low + evidence_label_mismatch', () => {
      // THIS IS THE WHOLE POINT of the layer. If broadening synonyms ever
      // makes a "60 Hz" line acceptable for kva, s03/s36 fails silently.
      const { conf, codes } = runOne('kva', 60, '60 Hz');
      expect(conf).toBe('low');
      expect(codes).toContain('evidence_label_mismatch');
    });
    test('kva field with a "60 CYCLES" snippet → still HARD low (calibration didn\'t leak)', () => {
      // Even after adding CYCLES as a legit frequency synonym, a kva
      // snippet containing ONLY a frequency unit must still hard-flag.
      const { conf, codes } = runOne('kva', 60, '60 CYCLES');
      expect(conf).toBe('low');
      expect(codes).toContain('evidence_label_mismatch');
    });
    test('voltage field with a "9.3 AMPS" snippet → HARD low', () => {
      const { conf, codes } = runOne('voltage', 480, '9.3 AMPS');
      expect(conf).toBe('low');
      expect(codes).toContain('evidence_label_mismatch');
    });
    test('amperage field with a "480 VAC" snippet → HARD low', () => {
      const { conf, codes } = runOne('amperage', 480, '480 VAC');
      expect(conf).toBe('low');
      expect(codes).toContain('evidence_label_mismatch');
    });
    test('frequency field with a "60 KVA" snippet → HARD low', () => {
      const { conf, codes } = runOne('frequency', 60, '60 KVA');
      expect(conf).toBe('low');
      expect(codes).toContain('evidence_label_mismatch');
    });
  });

  // ── SOFT case: snippet lacks any recognized unit but isn't cross-family ─
  describe('SOFT case: no recognized unit token → medium, not low', () => {
    test('kva field with a bare number snippet → medium + no_unit_in_evidence', () => {
      const { conf, codes } = runOne('kva', 75, '75');
      expect(conf).toBe('medium');
      expect(codes).toContain('no_unit_in_evidence');
    });
    test('voltage field with prose that has no unit → medium', () => {
      const { conf, codes } = runOne('voltage', 480, 'RATED PRIMARY 480');
      expect(conf).toBe('medium');
      expect(codes).toContain('no_unit_in_evidence');
    });
  });

  // ── Word-boundary rejection: real-word Vs, As shouldn't false-positive ──
  describe('letter-glued words don\'t count as unit tokens (SERVICE / IMPACT)', () => {
    test('voltage snippet "SERVICE ENTRANCE 480" — no V unit found → soft medium', () => {
      // "SERVICE" contains V but with letters on both sides — the (?<![A-Za-z])
      // lookbehind rejects it. "480" is a bare number. Result: no unit token
      // recognized anywhere → SOFT medium.
      const { conf, codes } = runOne('voltage', 480, 'SERVICE ENTRANCE 480');
      expect(conf).toBe('medium');
      expect(codes).toContain('no_unit_in_evidence');
    });
    test('amperage snippet "IMPACT" contains A but is not amp family', () => {
      const { conf, codes } = runOne('amperage', 9.3, 'IMPACT RATED 9.3');
      expect(conf).toBe('medium');
      expect(codes).toContain('no_unit_in_evidence');
    });
  });

  // ── Snippets with BOTH positive AND foreign: still pass. Real plates
  //    often carry a whole line like "480V 3PH 60HZ" as the source snippet
  //    for the voltage field — that's a positive match for voltage AND
  //    frequency, but the field's own family matches so we PASS. ──────────
  describe('positive-plus-foreign: real-plate line snippets still pass', () => {
    test('voltage snippet "480V 3PH 60HZ" → passes (voltage family matched)', () => {
      const { conf, codes } = runOne('voltage', 480, '480V 3PH 60HZ');
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
    test('frequency snippet "480V 3PH 60HZ" → passes (frequency matched)', () => {
      const { conf, codes } = runOne('frequency', 60, '480V 3PH 60HZ');
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
    test('kva snippet "75 KVA 480V 3PH 60HZ" → passes (kva matched)', () => {
      const { conf, codes } = runOne('kva', 75, '75 KVA 480V 3PH 60HZ');
      expect(conf).toBe('high');
      expect(codes).toEqual([]);
    });
  });

  // ── Whole-response happy path: the s01-class legit plate has zero flags ─
  test('legit multi-field plate: zero V7 findings, all confidences stay high', () => {
    const fields = {
      kva: 75, voltage: '480V', amperage: 90.2, phases: 3,
      frequency: '60 Hz', year: 2015,
    };
    const conf = fresh(fields);
    const ev = {
      kva:       '75 KVA',
      voltage:   '480V',
      amperage:  '90.2 A',
      frequency: '60 Hz',
      year:      'MFG DATE: 2015',
    };
    const out = checkNameplateEvidence(fields, conf, ev);
    expect(out).toEqual([]);
    for (const k of ['kva', 'voltage', 'amperage', 'frequency', 'year']) {
      expect(conf[k]).toBe('high');
    }
  });
});
