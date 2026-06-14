/**
 * AI extraction: shared mapping (result -> passFail, unit normalization, fields)
 * + vision guards. The live LLM call is covered by the eval harness, not here.
 */
import '../helpers/setup';
const x = require('../../lib/aiTestReportExtract');
const OHM = String.fromCharCode(0x3a9), MU = String.fromCharCode(0xb5);

describe('_normUnit keeps milli/mega/micro distinct', () => {
  test('lowercase m = milli, capital M = mega', () => {
    expect(x._normUnit('mohm')).toBe('m' + OHM);
    expect(x._normUnit('m' + OHM)).toBe('m' + OHM);
    expect(x._normUnit('milliohm')).toBe('m' + OHM);
    expect(x._normUnit('Mohm')).toBe('M' + OHM);
    expect(x._normUnit('M' + OHM)).toBe('M' + OHM);
    expect(x._normUnit('megohm')).toBe('M' + OHM);
    expect(x._normUnit('uohm')).toBe(MU + OHM);
  });
});

describe('_mapResult', () => {
  test('pass/fail/marginal -> GREEN/RED/YELLOW', () => {
    expect(x._mapResult('PASS')).toBe('GREEN');
    expect(x._mapResult('fail')).toBe('RED');
    expect(x._mapResult('marginal')).toBe('YELLOW');
    expect(x._mapResult(null)).toBeNull();
  });
});

describe('_mapFields', () => {
  test('maps known header keys, nulls the rest', () => {
    const f = x._mapFields({ serialNumber: 'S1', manufacturer: 'ABB' });
    expect(f.serialNumber).toBe('S1');
    expect(f.manufacturer).toBe('ABB');
    expect(f.model).toBeNull();
  });
});

describe('_mapMeasurements maps result + normalizes unit', () => {
  test('milliohm winding reading: passFail from result, unit stays mOhm', () => {
    const out = x._mapMeasurements([{ measurementType: 'winding_resistance', phase: 'A', asFoundValue: 21.1, asFoundUnit: 'mohm', result: 'pass' }]);
    expect(out.length).toBe(1);
    expect(out[0].passFail).toBe('GREEN');
    expect(out[0].asFoundUnit).toBe('m' + OHM);
  });
});

describe('aiFillReadingsFromImage guards (no model call)', () => {
  const prev = process.env.AI_ENABLED;
  afterAll(() => { if (prev === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = prev; });
  test('ok:false when disabled or buffer invalid', async () => {
    process.env.AI_ENABLED = 'false';
    expect((await x.aiFillReadingsFromImage(Buffer.from('x'))).ok).toBe(false);
    process.env.AI_ENABLED = 'true';
    expect((await x.aiFillReadingsFromImage(Buffer.alloc(0))).ok).toBe(false);
  });
});

export {};