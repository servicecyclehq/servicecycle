'use strict';

/**
 * Alert engine — deduplication and tier-structure unit tests.
 *
 * The alert engine's full run requires a live DB and is exercised by the
 * integration suite. These unit tests cover the PURE, exported parts of the
 * engine — the tier definitions, the dedup key format, and cycle-aware
 * filter logic — without touching Prisma.
 *
 * Dedup design (from the engine source):
 *   Key = `${scheduleId}|${alertType}|${leadDays}` (string)
 *   A key is considered already-fired for this cycle if:
 *     Alert.createdAt >= schedule.lastCompletedDate
 *   Alerts created BEFORE lastCompletedDate belong to a prior maintenance
 *   cycle and MUST NOT suppress this cycle's tiers.
 */

const { TIERS } = require('../lib/alertEngine');

// ── TIERS structure ────────────────────────────────────────────────────────────

describe('TIERS configuration', () => {
  test('TIERS is an array with at least 10 entries', () => {
    expect(Array.isArray(TIERS)).toBe(true);
    expect(TIERS.length).toBeGreaterThanOrEqual(10);
  });

  test('every tier has leadDays (number), alertType (string), and roles (non-empty array)', () => {
    for (const tier of TIERS) {
      expect(typeof tier.leadDays).toBe('number');
      expect(typeof tier.alertType).toBe('string');
      expect(Array.isArray(tier.roles)).toBe(true);
      expect(tier.roles.length).toBeGreaterThan(0);
    }
  });

  test('positive leadDays = maintenance_due; negative = overdue/escalation/regulatory_breach', () => {
    const positiveTiers = TIERS.filter((t) => t.leadDays > 0);
    const negativeTiers = TIERS.filter((t) => t.leadDays < 0);

    for (const t of positiveTiers) {
      expect(t.alertType).toBe('maintenance_due');
    }
    for (const t of negativeTiers) {
      expect(['overdue', 'escalation', 'regulatory_breach']).toContain(t.alertType);
    }
  });

  test('the 180-day booking-window tier targets the consultant role', () => {
    const tier180 = TIERS.find((t) => t.leadDays === 180);
    expect(tier180).toBeTruthy();
    expect(tier180.roles).toContain('consultant');
    expect(tier180.alertType).toBe('maintenance_due');
  });

  test('the 30-day final-prep tier routes to admin, manager, AND consultant', () => {
    const tier30 = TIERS.find((t) => t.leadDays === 30);
    expect(tier30).toBeTruthy();
    expect(tier30.roles).toContain('admin');
    expect(tier30.roles).toContain('manager');
    expect(tier30.roles).toContain('consultant');
  });

  test('the overdue tier (leadDays=-1) targets the manager role', () => {
    const overdue = TIERS.find((t) => t.leadDays === -1);
    expect(overdue).toBeTruthy();
    expect(overdue.alertType).toBe('overdue');
    expect(overdue.roles).toContain('manager');
  });

  test('the regulatory_breach tier (leadDays=-90) routes to admin + manager + consultant', () => {
    const breach = TIERS.find((t) => t.alertType === 'regulatory_breach');
    expect(breach).toBeTruthy();
    expect(breach.leadDays).toBe(-90);
    expect(breach.roles).toContain('admin');
    expect(breach.roles).toContain('manager');
    expect(breach.roles).toContain('consultant');
  });

  test('leadDays values are all distinct (no duplicate tiers)', () => {
    const days = TIERS.map((t) => t.leadDays);
    const unique = new Set(days);
    expect(unique.size).toBe(days.length);
  });

  test('tiers include 180, 120, 90, 60, 30, 7 ahead and -1, -7, -30, -90 overdue', () => {
    const days = TIERS.map((t) => t.leadDays);
    for (const expected of [180, 120, 90, 60, 30, 7, -1, -7, -30, -90]) {
      expect(days).toContain(expected);
    }
  });
});

// ── Dedup key format ──────────────────────────────────────────────────────────
// The dedup key is constructed as `${scheduleId}|${alertType}|${leadDays}`.
// We verify the format is stable and that the Set correctly deduplicates.

describe('Dedup key invariants', () => {
  // Replicate the key construction from the engine source for pure testing.
  function makeKey(scheduleId, alertType, leadDays) {
    return `${scheduleId}|${alertType}|${leadDays}`;
  }

  test('same (scheduleId, alertType, leadDays) triple maps to the same key', () => {
    const a = makeKey('sched-abc', 'maintenance_due', 30);
    const b = makeKey('sched-abc', 'maintenance_due', 30);
    expect(a).toBe(b);
  });

  test('different alertType produces a different key', () => {
    const a = makeKey('sched-abc', 'maintenance_due', -1);
    const b = makeKey('sched-abc', 'overdue', -1);
    expect(a).not.toBe(b);
  });

  test('different leadDays produces a different key', () => {
    const a = makeKey('sched-abc', 'maintenance_due', 30);
    const b = makeKey('sched-abc', 'maintenance_due', 7);
    expect(a).not.toBe(b);
  });

  test('different scheduleId produces a different key', () => {
    const a = makeKey('sched-A', 'maintenance_due', 30);
    const b = makeKey('sched-B', 'maintenance_due', 30);
    expect(a).not.toBe(b);
  });

  test('a fired Set correctly deduplicates keys', () => {
    const fired = new Set();
    const key = makeKey('sched-1', 'overdue', -1);
    fired.add(key);

    // Same key — already fired.
    expect(fired.has(makeKey('sched-1', 'overdue', -1))).toBe(true);

    // Different alertType — NOT fired.
    expect(fired.has(makeKey('sched-1', 'escalation', -1))).toBe(false);

    // Same alertType/leadDays but different schedule — NOT fired.
    expect(fired.has(makeKey('sched-2', 'overdue', -1))).toBe(false);
  });

  test('firing a new alertType for the same schedule does NOT collide', () => {
    const fired = new Set();
    fired.add(makeKey('sched-1', 'overdue', -1));
    // Adding ESCALATION for same schedule should succeed (not deduplicated).
    const escalationKey = makeKey('sched-1', 'escalation', -7);
    expect(fired.has(escalationKey)).toBe(false);
    fired.add(escalationKey);
    expect(fired.size).toBe(2);
  });
});

// ── Cycle-aware dedup filter ───────────────────────────────────────────────────
// Alerts created BEFORE lastCompletedDate belong to a prior cycle and must
// NOT suppress this cycle's alerts. We replicate the filter from the engine.

describe('Cycle-aware dedup filter', () => {
  // Replicate the filter from runAlertEngine:
  //   existing.filter(a => new Date(a.createdAt).getTime() >= lastCompletedAt)
  //   .map(a => `${a.scheduleId}|${a.alertType}|${a.leadDays}`)
  function buildFiredSet(existingAlerts, lastCompletedById) {
    return new Set(
      existingAlerts
        .filter((a) => {
          const completedAt = lastCompletedById.get(a.scheduleId) || 0;
          return new Date(a.createdAt).getTime() >= completedAt;
        })
        .map((a) => `${a.scheduleId}|${a.alertType}|${a.leadDays}`)
    );
  }

  const SCHED_ID = 'sched-001';

  test('alert created AFTER lastCompletedDate is treated as current-cycle → suppresses re-fire', () => {
    const lastCompleted = new Date('2026-05-01T00:00:00Z');
    const alertCreated  = new Date('2026-05-15T00:00:00Z'); // after completion

    const existingAlerts = [
      { scheduleId: SCHED_ID, alertType: 'maintenance_due', leadDays: 30, createdAt: alertCreated.toISOString() },
    ];
    const lastCompletedById = new Map([[SCHED_ID, lastCompleted.getTime()]]);

    const fired = buildFiredSet(existingAlerts, lastCompletedById);
    expect(fired.has(`${SCHED_ID}|maintenance_due|30`)).toBe(true);
  });

  test('alert created BEFORE lastCompletedDate belongs to prior cycle → must NOT suppress', () => {
    const lastCompleted = new Date('2026-05-01T00:00:00Z');
    const alertCreated  = new Date('2026-04-01T00:00:00Z'); // BEFORE completion → prior cycle

    const existingAlerts = [
      { scheduleId: SCHED_ID, alertType: 'maintenance_due', leadDays: 30, createdAt: alertCreated.toISOString() },
    ];
    const lastCompletedById = new Map([[SCHED_ID, lastCompleted.getTime()]]);

    const fired = buildFiredSet(existingAlerts, lastCompletedById);
    expect(fired.has(`${SCHED_ID}|maintenance_due|30`)).toBe(false);
  });

  test('schedule with no completion history uses 0 as sentinel → any existing alert suppresses', () => {
    // lastCompletedById.get(...) returns undefined → fallback 0 (epoch).
    // Any alert (ever created) has createdAt >= epoch.
    const alertCreated = new Date('2025-01-01T00:00:00Z');
    const existingAlerts = [
      { scheduleId: SCHED_ID, alertType: 'overdue', leadDays: -1, createdAt: alertCreated.toISOString() },
    ];
    const lastCompletedById = new Map(); // no entry for SCHED_ID

    const fired = buildFiredSet(existingAlerts, lastCompletedById);
    expect(fired.has(`${SCHED_ID}|overdue|-1`)).toBe(true);
  });

  test('does not re-fire when the same triple is already in the fired set (current cycle)', () => {
    const lastCompleted = new Date('2026-01-01T00:00:00Z');
    const sentAt        = new Date('2026-01-10T00:00:00Z');

    const existing = [
      { scheduleId: SCHED_ID, alertType: 'maintenance_due', leadDays: 7, createdAt: sentAt.toISOString() },
    ];
    const lastCompletedById = new Map([[SCHED_ID, lastCompleted.getTime()]]);

    const fired = buildFiredSet(existing, lastCompletedById);

    // Simulate the engine's tier-crossing check: key is in fired → skip.
    const key = `${SCHED_ID}|maintenance_due|7`;
    expect(fired.has(key)).toBe(true); // already fired → would be skipped
  });

  test('fires a new alert when the same scheduleId has a different alertType', () => {
    const lastCompleted = new Date('2026-01-01T00:00:00Z');
    const sentAt        = new Date('2026-01-10T00:00:00Z');

    // OVERDUE already fired.
    const existing = [
      { scheduleId: SCHED_ID, alertType: 'overdue', leadDays: -1, createdAt: sentAt.toISOString() },
    ];
    const lastCompletedById = new Map([[SCHED_ID, lastCompleted.getTime()]]);

    const fired = buildFiredSet(existing, lastCompletedById);

    // ESCALATION for the same schedule is NOT in the fired set → a new alert would be created.
    expect(fired.has(`${SCHED_ID}|escalation|-7`)).toBe(false);
  });

  test('multiple schedules are deduplicated independently', () => {
    const T = new Date('2026-03-01T00:00:00Z').getTime();
    const existing = [
      { scheduleId: 'sched-A', alertType: 'overdue', leadDays: -1, createdAt: new Date(T + 1).toISOString() },
      { scheduleId: 'sched-B', alertType: 'overdue', leadDays: -1, createdAt: new Date(T - 86400000).toISOString() }, // prior cycle for B
    ];
    const lastCompletedById = new Map([
      ['sched-A', T],
      ['sched-B', T],
    ]);

    const fired = buildFiredSet(existing, lastCompletedById);
    expect(fired.has('sched-A|overdue|-1')).toBe(true);  // current cycle → suppressed
    expect(fired.has('sched-B|overdue|-1')).toBe(false); // prior cycle → NOT suppressed
  });
});
