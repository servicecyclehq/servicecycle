'use strict';

/**
 * Pure-unit test for lib/fiscalYear.js. No DB, no HTTP — runs anywhere.
 *
 * Covers the three load-bearing edge cases:
 *   1. Calendar-year (startMonth=1) and the FY label === start year
 *   2. Non-calendar (startMonth=10) and the FY label === end year
 *   3. The boundary day before / after the FY rollover
 *   4. Negative offset returns the prior FY
 */

const { fiscalYearRange } = require('../lib/fiscalYear');

describe('fiscalYearRange', () => {
  test('calendar year: May 2026 → FY2026, Jan 1 2026 to Jan 1 2027', () => {
    const fy = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 1, 0);
    expect(fy.label).toBe('FY2026');
    expect(fy.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(fy.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('US federal FY (Oct start): May 2026 → FY2026, Oct 2025 to Oct 2026', () => {
    const fy = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 10, 0);
    expect(fy.label).toBe('FY2026');
    expect(fy.start.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(fy.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  test('Boundary: Sep 30 belongs to FY2026 under Oct-start; Oct 1 belongs to FY2027', () => {
    const sept = fiscalYearRange(new Date('2026-09-30T23:59:59Z'), 10, 0);
    const oct  = fiscalYearRange(new Date('2026-10-01T00:00:00Z'), 10, 0);
    expect(sept.label).toBe('FY2026');
    expect(oct.label).toBe('FY2027');
    expect(sept.end.toISOString()).toBe(oct.start.toISOString());
  });

  test('Prior FY (offset=-1) under calendar year', () => {
    const fy = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 1, -1);
    expect(fy.label).toBe('FY2025');
    expect(fy.start.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(fy.end.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('Default to calendar year on invalid startMonth', () => {
    const fy = fiscalYearRange(new Date('2026-05-02T00:00:00Z'), 99, 0);
    expect(fy.startMonth).toBe(1);
    expect(fy.label).toBe('FY2026');
  });
});
