'use strict';

/**
 * lib/importMapping unit suite -- the pure engine under the SMART asset
 * importer (routes/importAssets.ts). Covers the contract the route relies on:
 *
 *   - deterministic mapping tiers: exact (key/label), synonym (mfr -> manufacturer,
 *     s/n -> serialNumber, facility -> siteName ...), content-boosted 'type'
 *     columns, custom-field name matches
 *   - equipment-type fuzzy matching to the canonical enum (aliases + compound
 *     cell heuristics, incl. the MCC/VFD compound rules)
 *   - AI-assisted mapping FAIL-SOFT: AI_ENABLED=false, provider error, and
 *     malformed JSON all degrade to deterministic-only ({})
 *   - AI response sanitization: unknown headers/fields dropped, confidence
 *     clamped, sub-threshold proposals discarded
 *   - per-row coercion + validation: dates, C1/C2/C3 axes, booleans, scores,
 *     money, redundancy, required siteName/equipmentType, nameplate
 *     passthrough, custom-field injection, formula-prefix sanitization
 *   - CSV parsing incl. the UTF-8 BOM header strip
 *
 * Pure module -- no express, no prisma. lib/ai is mocked so the provider
 * layer never loads.
 */

jest.mock('../lib/ai', () => ({
  complete: jest.fn(),
  // Mirror lib/ai.parseJSON: strip optional markdown fences, then JSON.parse.
  parseJSON: (text) => {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  },
}));

const im = require('../lib/importMapping');
const ai = require('../lib/ai');

const OLD_AI_ENABLED = process.env.AI_ENABLED;

afterEach(() => {
  if (OLD_AI_ENABLED === undefined) delete process.env.AI_ENABLED;
  else process.env.AI_ENABLED = OLD_AI_ENABLED;
  ai.complete.mockReset();
});

// --- Normalizers --------------------------------------------------------------

describe('normalizeSerial', () => {
  test('uppercases, strips separators, folds O->0 and I->1', () => {
    expect(im.normalizeSerial('b36-sO1')).toBe('B36S01');
    expect(im.normalizeSerial(' SN 100 ')).toBe('SN100');
    expect(im.normalizeSerial('SN-1OO')).toBe('SN100');
  });
  test('null/empty -> empty string', () => {
    expect(im.normalizeSerial(null)).toBe('');
    expect(im.normalizeSerial('')).toBe('');
  });
});

describe('sanitizeFormulaPrefix', () => {
  test('quotes leading formula characters', () => {
    expect(im.sanitizeFormulaPrefix('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(im.sanitizeFormulaPrefix('+1234')).toBe("'+1234");
    expect(im.sanitizeFormulaPrefix('@cmd')).toBe("'@cmd");
  });
  test('leaves normal text and non-strings alone', () => {
    expect(im.sanitizeFormulaPrefix('Eaton')).toBe('Eaton');
    expect(im.sanitizeFormulaPrefix(42)).toBe(42);
    expect(im.sanitizeFormulaPrefix(null)).toBe(null);
  });
});

// --- Equipment-type fuzzy matching ---------------------------------------------

describe('matchEquipmentType', () => {
  test('enum values and display labels match exactly', () => {
    expect(im.matchEquipmentType('TRANSFORMER_LIQUID')).toBe('TRANSFORMER_LIQUID');
    expect(im.matchEquipmentType('Transformer (Liquid)')).toBe('TRANSFORMER_LIQUID');
    expect(im.matchEquipmentType('  switchgear  ')).toBe('SWITCHGEAR');
  });
  test('curated aliases match after normalization', () => {
    expect(im.matchEquipmentType('swgr')).toBe('SWITCHGEAR');
    expect(im.matchEquipmentType('genset')).toBe('GENERATOR');
    expect(im.matchEquipmentType('Motor Control Center')).toBe('MCC');
  });
  test('compound cells resolve through ordered heuristics', () => {
    expect(im.matchEquipmentType('Oil-filled transformer 1500 kVA')).toBe('TRANSFORMER_LIQUID');
    expect(im.matchEquipmentType('Dry-Type XFMR T-12')).toBe('TRANSFORMER_DRY');
    expect(im.matchEquipmentType('ATS #2 - generator backup')).toBe('TRANSFER_SWITCH');
    expect(im.matchEquipmentType('480V feeder run to RTU')).toBe('CABLE_LV');
    expect(im.matchEquipmentType('15 kV feeder circuit')).toBe('CABLE_MV_HV');
    expect(im.matchEquipmentType('Cable tray - mezzanine')).toBe('CABLE_TRAY');
    expect(im.matchEquipmentType('Ground fault relay GFR-1')).toBe('GROUND_FAULT_PROTECTION');
    expect(im.matchEquipmentType('Main ground grid')).toBe('GROUNDING_SYSTEM');
    expect(im.matchEquipmentType('UPS battery string A')).toBe('UPS_BATTERY');
    expect(im.matchEquipmentType('Station battery bank 125VDC')).toBe('BATTERY_SYSTEM');
  });
  test('MCC and VFD compound heuristics (route additions)', () => {
    expect(im.matchEquipmentType('Motor Control Center MCC-1 East')).toBe('MCC');
    expect(im.matchEquipmentType('MCC-4')).toBe('MCC');
    expect(im.matchEquipmentType('VFD - AHU-3 supply fan')).toBe('VFD');
    expect(im.matchEquipmentType('Variable Frequency Drive 40HP')).toBe('VFD');
    expect(im.matchEquipmentType('Induction motor 50HP')).toBe('MOTOR');
  });
  test('unmatchable text returns null', () => {
    expect(im.matchEquipmentType('coffee machine')).toBe(null);
    expect(im.matchEquipmentType('')).toBe(null);
    expect(im.matchEquipmentType(null)).toBe(null);
  });
});

// --- Deterministic header guessing ---------------------------------------------

describe('guessMapping', () => {
  test('exact tier: field keys and display labels, confidence 1', () => {
    const m = im.guessMapping(['Serial Number', 'equipmentType'], []);
    expect(m['Serial Number']).toEqual({ field: 'serialNumber', confidence: 1, source: 'exact' });
    expect(m['equipmentType']).toEqual({ field: 'equipmentType', confidence: 1, source: 'exact' });
  });

  test('synonym tier: mfr/make -> manufacturer, s/n -> serialNumber, facility -> siteName', () => {
    const m = im.guessMapping(['Mfr', 'MAKE', 'S/N', 'Facility', 'Install Year', 'Comments'], []);
    expect(m['Mfr']).toEqual({ field: 'manufacturer', confidence: 0.85, source: 'synonym' });
    expect(m['MAKE'].field).toBe('manufacturer');
    expect(m['S/N'].field).toBe('serialNumber');
    expect(m['Facility'].field).toBe('siteName');
    expect(m['Install Year'].field).toBe('installDate');
    expect(m['Comments'].field).toBe('notes');
  });

  test('"Type" column confidence is content-boosted by matching samples', () => {
    const rowsGood = [{ Type: 'Panelboard' }, { Type: 'Switchgear' }];
    const rowsBad  = [{ Type: 'red' }, { Type: 'blue' }];
    expect(im.guessMapping(['Type'], rowsGood)['Type']).toEqual({ field: 'equipmentType', confidence: 0.9, source: 'synonym' });
    expect(im.guessMapping(['Type'], rowsBad)['Type'].confidence).toBe(0.5);
  });

  test('unnamed column whose samples ALL resolve is proposed as equipmentType at 0.6', () => {
    const m = im.guessMapping(['Gear'], [{ Gear: 'Panelboard' }, { Gear: 'genset' }]);
    expect(m['Gear']).toEqual({ field: 'equipmentType', confidence: 0.6, source: 'synonym' });
  });

  test('custom-field definition names match as cf:<id>', () => {
    const defs = [{ id: 'd1', name: 'Feeder Tag', type: 'text', archivedAt: null }];
    const m = im.guessMapping(['Feeder Tag', 'Unknown Col'], [], defs);
    expect(m['Feeder Tag']).toEqual({ field: 'cf:d1', confidence: 0.8, source: 'synonym' });
    expect(m['Unknown Col']).toEqual({ field: null, confidence: 0, source: null });
  });
});

describe('dedupeMapping / findDuplicateTargets', () => {
  test('two columns claiming one field: higher confidence wins, loser unmapped', () => {
    const deduped = im.dedupeMapping({
      'Serial Number': { field: 'serialNumber', confidence: 1, source: 'exact' },
      'S/N':           { field: 'serialNumber', confidence: 0.85, source: 'synonym' },
    });
    expect(deduped['Serial Number'].field).toBe('serialNumber');
    expect(deduped['S/N'].field).toBe(null);
  });
  test('findDuplicateTargets flags repeated targets in a plain map', () => {
    expect(im.findDuplicateTargets({ A: 'manufacturer', B: 'manufacturer', C: null, D: 'model' }))
      .toEqual(['manufacturer']);
  });
});

// --- AI-assisted mapping (fail-soft) --------------------------------------------

describe('aiAssistMapping', () => {
  const columns = [{ header: 'Widget', samples: ['ACME-9'] }];
  const targets = im.TARGET_FIELDS;

  test('AI_ENABLED=false -> {} and the provider is never called', async () => {
    process.env.AI_ENABLED = 'false';
    const out = await im.aiAssistMapping(columns, targets);
    expect(out).toEqual({});
    expect(ai.complete).not.toHaveBeenCalled();
  });

  test('provider error -> {} (deterministic-only, never throws)', async () => {
    process.env.AI_ENABLED = 'true';
    ai.complete.mockRejectedValue(new Error('provider down'));
    await expect(im.aiAssistMapping(columns, targets)).resolves.toEqual({});
  });

  test('malformed JSON -> {}', async () => {
    process.env.AI_ENABLED = 'true';
    ai.complete.mockResolvedValue({ text: 'sorry, I cannot help with that' });
    await expect(im.aiAssistMapping(columns, targets)).resolves.toEqual({});
  });

  test('valid response maps unresolved headers with source ai', async () => {
    process.env.AI_ENABLED = 'true';
    ai.complete.mockResolvedValue({ text: '{"mapping":{"Widget":{"field":"model","confidence":0.9}}}' });
    const out = await im.aiAssistMapping(columns, targets);
    expect(out).toEqual({ Widget: { field: 'model', confidence: 0.9, source: 'ai' } });
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(ai.complete.mock.calls[0][0].task).toBe('classify');
  });

  test('empty column list -> {} without calling the provider', async () => {
    process.env.AI_ENABLED = 'true';
    await expect(im.aiAssistMapping([], targets)).resolves.toEqual({});
    expect(ai.complete).not.toHaveBeenCalled();
  });
});

describe('parseAiMappingResponse', () => {
  const headers = ['Widget', 'Gadget'];
  const validKeys = new Set(['model', 'manufacturer']);

  test('drops unknown headers and unknown field keys', () => {
    const out = im.parseAiMappingResponse(JSON.stringify({
      mapping: {
        Widget:  { field: 'model', confidence: 0.8 },
        Gadget:  { field: 'notARealField', confidence: 0.9 },
        Phantom: { field: 'manufacturer', confidence: 0.9 },
      },
    }), headers, validKeys);
    expect(Object.keys(out)).toEqual(['Widget']);
  });

  test('clamps confidence into [0,1] and discards sub-threshold proposals', () => {
    const out = im.parseAiMappingResponse(JSON.stringify({
      mapping: {
        Widget: { field: 'model', confidence: 7 },
        Gadget: { field: 'manufacturer', confidence: 0.1 },
      },
    }), headers, validKeys);
    expect(out.Widget.confidence).toBe(1);
    expect(out.Gadget).toBeUndefined();
  });

  test('structural garbage -> {}', () => {
    expect(im.parseAiMappingResponse('[]', headers, validKeys)).toEqual({});
    expect(im.parseAiMappingResponse('not json', headers, validKeys)).toEqual({});
    expect(im.parseAiMappingResponse('', headers, validKeys)).toEqual({});
  });
});

// --- Cell coercion ---------------------------------------------------------------

describe('coerceField', () => {
  test('dates: ISO, US m/d/yyyy, bare year; rejects garbage and out-of-range', () => {
    expect(im.coerceField('installDate', '2018-06-05').toISOString().startsWith('2018-06-05')).toBe(true);
    expect(im.coerceField('installDate', '6/5/2018').toISOString().startsWith('2018-06-05')).toBe(true);
    expect(im.coerceField('installDate', '2018').toISOString().startsWith('2018-01-01')).toBe(true);
    expect(im.coerceField('installDate', 'not a date')).toBeInstanceOf(Error);
    expect(im.coerceField('installDate', '3000')).toBeInstanceOf(Error);
  });

  test('condition axes accept C1/C2/C3, numerals, and words', () => {
    expect(im.coerceField('conditionPhysical', 'good')).toBe('C1');
    expect(im.coerceField('conditionCriticality', '2')).toBe('C2');
    expect(im.coerceField('conditionEnvironment', 'POOR')).toBe('C3');
    expect(im.coerceField('conditionPhysical', 'excellent')).toBeInstanceOf(Error);
  });

  test('inService booleans', () => {
    expect(im.coerceField('inService', 'energized')).toBe(true);
    expect(im.coerceField('inService', 'Out of service')).toBe(false);
    expect(im.coerceField('inService', 'maybe')).toBeInstanceOf(Error);
  });

  test('equipmentType goes through the fuzzy matcher', () => {
    expect(im.coerceField('equipmentType', 'oil transformer')).toBe('TRANSFORMER_LIQUID');
    expect(im.coerceField('equipmentType', 'jibberish')).toBeInstanceOf(Error);
  });

  test('scores are integers 1-5', () => {
    expect(im.coerceField('criticalityScore', '4')).toBe(4);
    expect(im.coerceField('criticalityScore', '7')).toBeInstanceOf(Error);
    expect(im.coerceField('conditionScore', '2.5')).toBeInstanceOf(Error);
  });

  test('money accepts $ commas and k/m suffixes', () => {
    expect(im.coerceField('repairCostEstimate', '$850,000')).toBe('850000');
    expect(im.coerceField('repairCostEstimate', '850k')).toBe('850000');
    expect(im.coerceField('repairCostEstimate', '1.2m')).toBe('1200000');
    expect(im.coerceField('repairCostEstimate', '-5')).toBeInstanceOf(Error);
  });

  test('lead time strips week suffixes', () => {
    expect(im.coerceField('spareLeadTimeWeeks', '12 weeks')).toBe(12);
    expect(im.coerceField('spareLeadTimeWeeks', 'soon')).toBeInstanceOf(Error);
  });

  test('redundancy status normalizes', () => {
    expect(im.coerceField('redundancyStatus', 'n+1')).toBe('N_PLUS_1');
    expect(im.coerceField('redundancyStatus', '2N')).toBe('TWO_N');
    expect(im.coerceField('redundancyStatus', 'lots')).toBeInstanceOf(Error);
  });

  test('blank cells return null (leave unset)', () => {
    expect(im.coerceField('manufacturer', '')).toBe(null);
    expect(im.coerceField('installDate', '   ')).toBe(null);
    expect(im.coerceField('manufacturer', null)).toBe(null);
  });
});

describe('worstCondition', () => {
  test('C3 dominates, then C2, then C1', () => {
    expect(im.worstCondition('C1', 'C3', 'C2')).toBe('C3');
    expect(im.worstCondition('C1', 'C2', 'C1')).toBe('C2');
    expect(im.worstCondition('C1', 'C1', 'C1')).toBe('C1');
  });
});

// --- CSV parsing -------------------------------------------------------------------

describe('parseCsvText', () => {
  test('parses headers + rows and skips empty lines', () => {
    const { headers, rows } = im.parseCsvText('Site,Type\nEastgate,Panelboard\n\n');
    expect(headers).toEqual(['Site', 'Type']);
    expect(rows).toEqual([{ Site: 'Eastgate', Type: 'Panelboard' }]);
  });
  test('strips a UTF-8 BOM from the first header', () => {
    const bom = String.fromCharCode(0xfeff); // keep this source file pure ASCII
    const { headers } = im.parseCsvText(bom + 'Site,Type\nA,Panelboard');
    expect(headers).toEqual(['Site', 'Type']);
  });
});

describe('sampleColumns', () => {
  test('returns up to 3 distinct non-empty samples per column', () => {
    const rows = [{ A: 'x' }, { A: 'x' }, { A: 'y' }, { A: '' }, { A: 'z' }, { A: 'w' }];
    expect(im.sampleColumns(['A'], rows)).toEqual([{ header: 'A', samples: ['x', 'y', 'z'] }]);
  });
});

// --- Row validation -----------------------------------------------------------------

describe('validateRows', () => {
  const mapping = {
    Site: 'siteName', Type: 'equipmentType', Make: 'manufacturer',
    Serial: 'serialNumber', Installed: 'installDate', Phys: 'conditionPhysical',
    Volts: 'voltage', Rating: 'kva',
  };

  test('happy row normalizes every mapped cell; row numbers are 1-indexed + header', () => {
    const rows = [{ Site: 'Eastgate', Type: 'Dry-type transformer', Make: 'Square D', Serial: 'SN-1', Installed: '2019-03-01', Phys: 'good', Volts: '480V', Rating: '750' }];
    const out = im.validateRows(rows, mapping);
    expect(out).toHaveLength(1);
    expect(out[0].row).toBe(2);
    expect(out[0].ok).toBe(true);
    expect(out[0].normalized.siteName).toBe('Eastgate');
    expect(out[0].normalized.equipmentType).toBe('TRANSFORMER_DRY');
    expect(out[0].normalized.conditionPhysical).toBe('C1');
    expect(out[0].normalized.installDate.toISOString().startsWith('2019-03-01')).toBe(true);
    expect(out[0].normalized.nameplate).toEqual({ voltage: '480V', kva: '750' });
  });

  test('missing site and equipment type are row errors', () => {
    const out = im.validateRows([{ Make: 'ABB' }], { Make: 'manufacturer' });
    expect(out[0].ok).toBe(false);
    const fields = out[0].errors.map((e) => e.field);
    expect(fields).toContain('siteName');
    expect(fields).toContain('equipmentType');
  });

  test('bad cells collect per-field errors without aborting the row scan', () => {
    const rows = [
      { Site: 'A', Type: 'Panelboard', Installed: 'garbage' },
      { Site: 'B', Type: 'Switchgear', Installed: '2020-01-01' },
    ];
    const out = im.validateRows(rows, { Site: 'siteName', Type: 'equipmentType', Installed: 'installDate' });
    expect(out[0].ok).toBe(false);
    expect(out[0].errors[0].field).toBe('installDate');
    expect(out[1].ok).toBe(true);
  });

  test('free-text values are formula-prefix sanitized', () => {
    const out = im.validateRows([{ Site: 'A', Type: 'Panelboard', Make: '=cmd()' }],
      { Site: 'siteName', Type: 'equipmentType', Make: 'manufacturer' });
    expect(out[0].normalized.manufacturer).toBe("'=cmd()");
  });

  test('custom fields validate through the injected definition validator', () => {
    const def = { id: 'd1', name: 'Panel Amps', type: 'number' };
    const opts = {
      customFieldById: new Map([['d1', def]]),
      validateCustomValue: (definition, raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${definition.name}: must be a number`);
        return String(n);
      },
    };
    const mappingCf = { Site: 'siteName', Type: 'equipmentType', Amps: 'cf:d1' };
    const good = im.validateRows([{ Site: 'A', Type: 'Panelboard', Amps: '225' }], mappingCf, opts);
    expect(good[0].ok).toBe(true);
    expect(good[0].normalized.customFields).toEqual({ d1: '225' });

    const bad = im.validateRows([{ Site: 'A', Type: 'Panelboard', Amps: 'abc' }], mappingCf, opts);
    expect(bad[0].ok).toBe(false);
    expect(bad[0].errors[0].field).toBe('cf:d1');
  });

  test('cf target without a known definition errors the cell, not the app', () => {
    const out = im.validateRows([{ Site: 'A', Type: 'Panelboard', X: 'v' }],
      { Site: 'siteName', Type: 'equipmentType', X: 'cf:ghost' },
      { customFieldById: new Map(), validateCustomValue: () => 'v' });
    expect(out[0].ok).toBe(false);
    expect(out[0].errors[0].error).toBe('Unknown custom field');
  });
});
