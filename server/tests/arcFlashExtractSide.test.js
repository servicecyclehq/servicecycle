'use strict';

/**
 * Unit coverage for lib/arcFlashExtract.ts's defensive normalization --
 * specifically normSide() (exercised via normalizeExtraction()), which maps
 * whatever side/train hint the extraction step returns onto 'A' | 'B' | null.
 *
 * Added 2026-07-23: LEFT/RIGHT-labeled diagrams were silently dropping to
 * null because normSide() only recognized A/1/SIDE A/TRAIN A and
 * B/2/SIDE B/TRAIN B -- confirmed gap from the sale-roadmap audit. This locks
 * in the fix and the pre-existing recognized forms so neither regresses.
 */

const { normalizeExtraction } = require('../lib/arcFlashExtract');

function sideOf(buses, name) {
  const b = buses.find((x) => x.busName === name);
  return b ? b.side : undefined;
}

describe('normalizeExtraction -- side (train) normalization', () => {
  test('recognizes the pre-existing A/B forms', () => {
    const { buses } = normalizeExtraction({
      buses: [
        { busName: 'SWGR-A', side: 'A' },
        { busName: 'SWGR-1', side: '1' },
        { busName: 'SWGR-SIDEA', side: 'Side A' },
        { busName: 'SWGR-TRAINA', side: 'train a' },
        { busName: 'SWGR-B', side: 'B' },
        { busName: 'SWGR-2', side: '2' },
        { busName: 'SWGR-SIDEB', side: 'Side B' },
        { busName: 'SWGR-TRAINB', side: 'TRAIN B' },
      ],
    });
    expect(sideOf(buses, 'SWGR-A')).toBe('A');
    expect(sideOf(buses, 'SWGR-1')).toBe('A');
    expect(sideOf(buses, 'SWGR-SIDEA')).toBe('A');
    expect(sideOf(buses, 'SWGR-TRAINA')).toBe('A');
    expect(sideOf(buses, 'SWGR-B')).toBe('B');
    expect(sideOf(buses, 'SWGR-2')).toBe('B');
    expect(sideOf(buses, 'SWGR-SIDEB')).toBe('B');
    expect(sideOf(buses, 'SWGR-TRAINB')).toBe('B');
  });

  test('recognizes LEFT/RIGHT forms (the fixed gap)', () => {
    const { buses } = normalizeExtraction({
      buses: [
        { busName: 'RACK-L', side: 'LEFT' },
        { busName: 'RACK-LSIDE', side: 'Left Side' },
        { busName: 'RACK-LTRAIN', side: 'left train' },
        { busName: 'RACK-R', side: 'RIGHT' },
        { busName: 'RACK-RSIDE', side: 'Right Side' },
        { busName: 'RACK-RTRAIN', side: 'right train' },
      ],
    });
    expect(sideOf(buses, 'RACK-L')).toBe('A');
    expect(sideOf(buses, 'RACK-LSIDE')).toBe('A');
    expect(sideOf(buses, 'RACK-LTRAIN')).toBe('A');
    expect(sideOf(buses, 'RACK-R')).toBe('B');
    expect(sideOf(buses, 'RACK-RSIDE')).toBe('B');
    expect(sideOf(buses, 'RACK-RTRAIN')).toBe('B');
  });

  test('unrecognized or missing side hints stay null (no guessing)', () => {
    const { buses } = normalizeExtraction({
      buses: [
        { busName: 'PNL-1', side: null },
        { busName: 'PNL-2' },
        { busName: 'PNL-3', side: 'North' },
        { busName: 'PNL-4', side: 'C' },
      ],
    });
    expect(sideOf(buses, 'PNL-1')).toBeNull();
    expect(sideOf(buses, 'PNL-2')).toBeNull();
    expect(sideOf(buses, 'PNL-3')).toBeNull();
    expect(sideOf(buses, 'PNL-4')).toBeNull();
  });
});
