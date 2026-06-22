/**
 * Unit tests for the Slice 3.5d OEM/published-TCC seed library (lookup + suggest).
 */
import { searchTcc, suggestFromDevice, TCC_LIBRARY } from '../../lib/arcFlashTccLibrary';

describe('searchTcc', () => {
  test('matches a manufacturer/series on the nameplate text', () => {
    const r = searchTcc({ q: 'Square D PowerPact H 250A' });
    expect(r[0].series).toMatch(/PowerPact/);
    expect(r[0].note).toMatch(/verify against the published TCC/i);
  });

  test('rating within frame range scores higher', () => {
    const r = searchTcc({ manufacturer: 'Eaton', model: 'Magnum DS', ratingA: 2000, deviceType: 'breaker' });
    expect(r[0].series).toMatch(/Magnum/);
    expect(r[0].frameMinA).toBeLessThanOrEqual(2000);
    expect(r[0].frameMaxA).toBeGreaterThanOrEqual(2000);
  });

  test('fuse query returns a fuse entry with a fuse class', () => {
    const r = searchTcc({ q: 'Bussmann LPS-RK 100', deviceType: 'fuse' });
    expect(r[0].deviceType).toBe('fuse');
    expect(r[0].fuseClass).toBeTruthy();
  });

  test('no recognizable text -> no matches', () => {
    expect(searchTcc({ q: 'zzz unknown widget' })).toHaveLength(0);
  });
});

describe('suggestFromDevice', () => {
  test('returns a structured identity + a typical clearing time', () => {
    const s = suggestFromDevice({ manufacturer: 'Schneider', model: 'Masterpact NW', deviceType: 'breaker', ratingA: 2000 });
    expect(s).toBeTruthy();
    expect(s.series).toMatch(/Masterpact/);
    expect(s.tripUnitType).toBe('electronic_lsig');
    expect(typeof s.suggestedClearingTimeMs).toBe('number');
    expect(s.curveRef).toBeTruthy();
    expect(s.confidence).toBe('good');
  });

  test('returns null when nothing matches', () => {
    expect(suggestFromDevice({ manufacturer: 'Nonexistent', model: 'XYZ' })).toBeNull();
  });

  test('library entries all carry a frame range and clearing time', () => {
    for (const e of TCC_LIBRARY) {
      expect(e.frameMaxA).toBeGreaterThanOrEqual(e.frameMinA);
      expect(e.typicalClearingTimeMs).toBeGreaterThan(0);
    }
  });
});
