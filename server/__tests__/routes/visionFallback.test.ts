/**
 * Vision fallback + shared mapping for AI test-report extraction.
 * The live LLM call isn't unit-tested (that's the eval harness's job, against
 * the real container); here we cover the pure mapping + the fail-safe guards.
 */
import '../helpers/setup';
const { _mapMeasurements, aiFillReadingsFromImage } = require('../../lib/aiTestReportExtract');

describe('_mapMeasurements (shared text + vision mapping)', () => {
  test('normalizes type/phase, strips commas, flags critical, drops noise', () => {
    const out = _mapMeasurements([
      { measurementType: 'Insulation Resistance', label: 'IR A', phase: 'a', asFoundValue: '1,450', asFoundUnit: 'Mohm', kind: 'D' },
      { measurementType: 'contact_resistance', phase: 'B', asFoundValue: 250 },
      { label: 'noise row', asFoundValue: null, expectedRange: null },
    ]);
    expect(out.length).toBe(2);
    expect(out[0].measurementType).toBe('insulation_resistance');
    expect(out[0].phase).toBe('A');
    expect(out[0].asFoundValue).toBe(1450);
    expect(out[0].source).toBe('ai');
    expect(out[1].critical).toBe(true); // contact_resistance is a critical type
  });
});

describe('aiFillReadingsFromImage guards (no model call)', () => {
  const prev = process.env.AI_ENABLED;
  afterAll(() => { if (prev === undefined) delete process.env.AI_ENABLED; else process.env.AI_ENABLED = prev; });
  test('ok:false when AI disabled', async () => {
    process.env.AI_ENABLED = 'false';
    expect(await aiFillReadingsFromImage(Buffer.from('x'))).toEqual({ ok: false, measurements: [] });
  });
  test('ok:false on empty / invalid buffer', async () => {
    process.env.AI_ENABLED = 'true';
    expect((await aiFillReadingsFromImage(Buffer.alloc(0))).ok).toBe(false);
    expect((await aiFillReadingsFromImage(null)).ok).toBe(false);
  });
});

export {};