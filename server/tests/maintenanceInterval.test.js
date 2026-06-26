'use strict';

/**
 * Unit coverage for lib/maintenanceInterval.ts — NFPA 70B / NETA condition-
 * based interval math. Pure-function suite: no DB, no server.
 *
 * The module uses module.exports = {...} so require works directly.
 */

const {
  intervalMonthsFor,
  worstCondition,
  recomputeScheduleDates,
  effectiveCondition,
  computeNextDueDate,
  C1_CEILING_MONTHS,
  C3_CEILING_MONTHS,
} = require('../lib/maintenanceInterval');

// ── intervalMonthsFor ────────────────────────────────────────────────────────

describe('intervalMonthsFor', () => {
  describe('C2 — base interval (no multiplier)', () => {
    test('C2 returns the base intervalC2Months unchanged', () => {
      expect(intervalMonthsFor({ intervalC2Months: 12 }, 'C2')).toBe(12);
      expect(intervalMonthsFor({ intervalC2Months: 36 }, 'C2')).toBe(36);
      expect(intervalMonthsFor({ intervalC2Months: 60 }, 'C2')).toBe(60);
    });

    test('unknown condition falls back to C2 / base interval', () => {
      expect(intervalMonthsFor({ intervalC2Months: 24 }, undefined)).toBe(24);
      expect(intervalMonthsFor({ intervalC2Months: 24 }, null)).toBe(24);
      expect(intervalMonthsFor({ intervalC2Months: 24 }, 'X')).toBe(24);
    });
  });

  describe('C1 — stretched interval (×2.5, ceiling 60 months)', () => {
    test('C1 = min(round(base × 2.5), 60) when no explicit column', () => {
      // base = 24 → round(24 × 2.5) = 60 → min(60, 60) = 60
      expect(intervalMonthsFor({ intervalC2Months: 24, intervalC1Months: null }, 'C1')).toBe(60);
    });

    test('C1 is capped at 60 months even when formula would exceed it', () => {
      // base = 25 → round(25 × 2.5) = 63 → min(63, 60) = 60
      expect(intervalMonthsFor({ intervalC2Months: 25, intervalC1Months: null }, 'C1')).toBe(C1_CEILING_MONTHS);
    });

    test('base = 12 → C1 derived = min(30, 60) = 30', () => {
      expect(intervalMonthsFor({ intervalC2Months: 12, intervalC1Months: null }, 'C1')).toBe(30);
    });

    test('explicit intervalC1Months column takes precedence over derived value', () => {
      // Seed data rows carry the exact NFPA 70B Table 9.2.2 column value.
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC1Months: 60 }, 'C1')).toBe(60);
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC1Months: 72 }, 'C1')).toBe(72);
    });

    test('explicit intervalC1Months = 0 is honored (zero is a valid explicit value)', () => {
      // null triggers derivation; 0 is explicit (== null guard is intentional).
      // In practice 0 won't appear in seeded data but the math must be consistent.
      // intervalC1Months: 0 — note the code checks `!= null`, so 0 IS explicit.
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC1Months: 0 }, 'C1')).toBe(0);
    });
  });

  describe('C3 — compressed interval (×0.25, ceiling 12, floor 1)', () => {
    test('C3 = max(1, min(round(base × 0.25), 12)) when no explicit column', () => {
      // base = 24 → round(24 × 0.25) = 6 → max(1, min(6, 12)) = 6
      expect(intervalMonthsFor({ intervalC2Months: 24, intervalC3Months: null }, 'C3')).toBe(6);
    });

    test('C3 is capped at 12 months even when formula would exceed it', () => {
      // base = 60 → round(60 × 0.25) = 15 → max(1, min(15, 12)) = 12
      expect(intervalMonthsFor({ intervalC2Months: 60, intervalC3Months: null }, 'C3')).toBe(C3_CEILING_MONTHS);
    });

    test('C3 floor of 1 prevents rounding to zero', () => {
      // base = 2 → round(2 × 0.25) = round(0.5) = 1 → max(1, min(1, 12)) = 1
      // (Note: Math.round(0.5) = 1 in JS.)
      expect(intervalMonthsFor({ intervalC2Months: 2, intervalC3Months: null }, 'C3')).toBe(1);
      // base = 1 → round(1 × 0.25) = round(0.25) = 0 → max(1, min(0, 12)) = 1
      expect(intervalMonthsFor({ intervalC2Months: 1, intervalC3Months: null }, 'C3')).toBe(1);
    });

    test('explicit intervalC3Months column takes precedence over derived value', () => {
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC3Months: 12 }, 'C3')).toBe(12);
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC3Months: 6 }, 'C3')).toBe(6);
    });

    test('dominant seeded row (C2=36, C3=12) returns correct C3', () => {
      // NFPA 70B Table 9.2.2 dominant row: C1=60, C2=36, C3=12
      expect(intervalMonthsFor({ intervalC2Months: 36, intervalC3Months: 12 }, 'C3')).toBe(12);
    });

    test('IR thermography row (C2=12, C3=6) returns correct C3', () => {
      expect(intervalMonthsFor({ intervalC2Months: 12, intervalC3Months: 6 }, 'C3')).toBe(6);
    });
  });

  describe('explicit column overrides', () => {
    test('when all three columns are explicitly set, each condition returns its column', () => {
      const def = { intervalC1Months: 60, intervalC2Months: 36, intervalC3Months: 12 };
      expect(intervalMonthsFor(def, 'C1')).toBe(60);
      expect(intervalMonthsFor(def, 'C2')).toBe(36);
      expect(intervalMonthsFor(def, 'C3')).toBe(12);
    });
  });
});

// ── worstCondition ───────────────────────────────────────────────────────────

describe('worstCondition', () => {
  test('C3 always wins over C2 and C1', () => {
    expect(worstCondition('C1', 'C2', 'C3')).toBe('C3');
    expect(worstCondition('C3', 'C1')).toBe('C3');
    expect(worstCondition('C2', 'C3')).toBe('C3');
  });

  test('C2 beats C1', () => {
    expect(worstCondition('C1', 'C2')).toBe('C2');
    expect(worstCondition('C2', 'C1')).toBe('C2');
  });

  test('single C1 returns C1', () => {
    expect(worstCondition('C1')).toBe('C1');
  });

  test('returns C2 when all inputs are null or undefined (schema default)', () => {
    expect(worstCondition(null, undefined)).toBe('C2');
    expect(worstCondition()).toBe('C2');
  });

  test('skips nulls and still finds the worst among valid inputs', () => {
    expect(worstCondition(null, 'C1', null, 'C2')).toBe('C2');
    expect(worstCondition(undefined, 'C3', null)).toBe('C3');
  });

  test('invalid string inputs are skipped (treated as null)', () => {
    expect(worstCondition('X', 'Y', 'C1')).toBe('C1');
    expect(worstCondition('bogus')).toBe('C2'); // nothing valid → C2 default
  });

  test('all three NFPA 70B condition axes — worst wins', () => {
    // Asset with physical=C1, criticality=C2, environment=C3 → C3 governs.
    expect(worstCondition('C1', 'C2', 'C3')).toBe('C3');
    // Asset with physical=C1, criticality=C1, environment=C2 → C2 governs.
    expect(worstCondition('C1', 'C1', 'C2')).toBe('C2');
  });
});

// ── effectiveCondition ───────────────────────────────────────────────────────

describe('effectiveCondition', () => {
  test('schedule conditionOverride takes precedence over asset governingCondition', () => {
    const asset    = { governingCondition: 'C1' };
    const schedule = { conditionOverride: 'C3' };
    expect(effectiveCondition(asset, schedule)).toBe('C3');
  });

  test('falls back to asset.governingCondition when schedule has no override', () => {
    const asset    = { governingCondition: 'C3' };
    const schedule = { conditionOverride: null };
    expect(effectiveCondition(asset, schedule)).toBe('C3');
  });

  test('falls back to C2 when neither asset nor schedule carries a condition', () => {
    expect(effectiveCondition(null, null)).toBe('C2');
    expect(effectiveCondition({ governingCondition: null }, { conditionOverride: null })).toBe('C2');
  });
});

// ── computeNextDueDate ───────────────────────────────────────────────────────

describe('computeNextDueDate', () => {
  const DEF_12 = { intervalC2Months: 12 };
  const DEF_36 = { intervalC2Months: 36, intervalC1Months: 60, intervalC3Months: 12 };

  test('returns null when lastCompletedDate is null', () => {
    expect(computeNextDueDate(null, DEF_12, 'C2')).toBeNull();
  });

  test('returns null when lastCompletedDate is an invalid date string', () => {
    expect(computeNextDueDate('not-a-date', DEF_12, 'C2')).toBeNull();
  });

  test('nextDueDate = lastCompletedDate + intervalMonths for C2', () => {
    const result = computeNextDueDate('2025-01-01', DEF_12, 'C2');
    expect(result).not.toBeNull();
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(1);
  });

  test('C3 condition compresses the interval (36-month base → 12-month C3)', () => {
    const result = computeNextDueDate('2025-01-01', DEF_36, 'C3');
    expect(result).not.toBeNull();
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0); // 12 months later
  });

  test('C1 condition stretches the interval (36-month base → 60-month C1)', () => {
    const result = computeNextDueDate('2025-01-01', DEF_36, 'C1');
    expect(result).not.toBeNull();
    expect(result.getFullYear()).toBe(2030);
    expect(result.getMonth()).toBe(0); // 60 months later = Jan 2030
  });

  test('accepts a Date object as lastCompletedDate', () => {
    const result = computeNextDueDate(new Date('2025-06-01'), DEF_12, 'C2');
    expect(result).not.toBeNull();
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(5); // June
  });
});

// ── recomputeScheduleDates ───────────────────────────────────────────────────

describe('recomputeScheduleDates', () => {
  const DEF = { intervalC2Months: 12, intervalC3Months: 6 };

  test('nextDueDate = lastCompletedDate + intervalMonths for the effective condition', () => {
    const asset    = { governingCondition: 'C2' };
    const schedule = { conditionOverride: null };
    const { lastCompletedDate, nextDueDate } = recomputeScheduleDates(DEF, asset, schedule, '2025-01-01');
    expect(lastCompletedDate.toISOString().startsWith('2025-01-01')).toBe(true);
    expect(nextDueDate.getFullYear()).toBe(2026);
  });

  test('C3 condition compresses the next interval', () => {
    const asset    = { governingCondition: 'C3' };
    const schedule = { conditionOverride: null };
    const { nextDueDate } = recomputeScheduleDates(DEF, asset, schedule, '2025-01-01');
    // 6 months from 2025-01-01 = 2025-07-01
    expect(nextDueDate.getFullYear()).toBe(2025);
    expect(nextDueDate.getMonth()).toBe(6); // July
  });

  test('conditionOverride C3 beats asset governingCondition C1', () => {
    const asset    = { governingCondition: 'C1' };
    const schedule = { conditionOverride: 'C3' };
    const { nextDueDate } = recomputeScheduleDates(DEF, asset, schedule, '2025-01-01');
    // Override C3 → 6-month interval
    expect(nextDueDate.getMonth()).toBe(6); // July
  });

  test('null completedDate defaults to "now" (returns a Date in the future)', () => {
    const asset    = { governingCondition: 'C2' };
    const schedule = { conditionOverride: null };
    const { lastCompletedDate, nextDueDate } = recomputeScheduleDates(DEF, asset, schedule, null);
    expect(lastCompletedDate).toBeInstanceOf(Date);
    expect(nextDueDate).toBeInstanceOf(Date);
    expect(nextDueDate.getTime()).toBeGreaterThan(Date.now());
  });
});
