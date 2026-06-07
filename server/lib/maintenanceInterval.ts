/**
 * NFPA 70B condition-based maintenance interval math.
 *
 * Pure functions only — no Prisma, no req/res. Routes (schedules.ts,
 * workOrders.ts) and the alert engine import these; keeping them pure means
 * the due-date logic is unit-testable without a database.
 *
 * The model, per NFPA 70B:2023 (condition of maintenance) and ANSI/NETA MTS
 * Appendix B (frequency of maintenance tests):
 *
 *   C2 (fair)  — the BASE interval. MaintenanceTaskDefinition.intervalC2Months
 *                carries the published NETA Appendix B value and is always set.
 *   C1 (good)  — interval stretches. NETA Appendix B multiplier ×2.5 against
 *                the C2 base, with a hard 60-month ceiling: no task may go
 *                more than 5 years between performances regardless of how
 *                healthy the equipment looks.
 *   C3 (poor)  — interval compresses. Multiplier ×0.25 against the C2 base,
 *                with a 12-month ceiling (poor-condition equipment is looked
 *                at no less than annually) and a 1-month floor so rounding
 *                can never produce a zero/negative interval.
 *
 * Seed data carries explicit intervalC1Months / intervalC3Months where NETA
 * publishes exact columns; when those are null we DERIVE from the C2 base
 * using the multipliers above. Tenant-defined custom tasks typically only
 * supply intervalC2Months and rely on the derivation.
 *
 * Which condition applies to a schedule:
 *   schedule.conditionOverride ?? asset.governingCondition
 * where governingCondition is the worst of the asset's three NFPA 70B axes
 * (physical / criticality / environment) — recomputed by the route layer on
 * every condition write (see worstCondition below).
 */

const { addMonths } = require('date-fns');

// ── Standard constants (NFPA 70B:2023 / NETA MTS Appendix B) ─────────────────
const C1_MULTIPLIER = 2.5; // C1 stretches the base interval ×2.5
const C3_MULTIPLIER = 0.25; // C3 compresses the base interval ×0.25
const C1_CEILING_MONTHS = 60; // C1 hard ceiling — never beyond 5 years
const C3_CEILING_MONTHS = 12; // C3 hard ceiling — poor gear seen at least annually
const C3_FLOOR_MONTHS = 1; // rounding guard — an interval can never hit zero

// Ordinal severity for worst-of comparisons. Higher = worse. C3 always wins.
const CONDITION_SEVERITY: any = { C1: 1, C2: 2, C3: 3 };

/**
 * The condition rating that governs a schedule's interval.
 *
 * Per-schedule override beats the asset's stored governing condition — an
 * engineer can pin a single task to C3 treatment (e.g. a battery string on
 * an otherwise-C1 UPS) without touching the asset record. Falls back to C2
 * (the NFPA 70B base default) defensively if neither side carries a value.
 *
 * @param asset    Asset row (needs .governingCondition)
 * @param schedule MaintenanceSchedule row (needs .conditionOverride) — may be
 *                 a partial ({ conditionOverride }) during create flows
 * @returns 'C1' | 'C2' | 'C3'
 */
function effectiveCondition(asset, schedule) {
  return (schedule && schedule.conditionOverride) || (asset && asset.governingCondition) || 'C2';
}

/**
 * Worst-of reducer over condition ratings — C3 beats C2 beats C1.
 *
 * Used to recompute Asset.governingCondition from the three NFPA 70B axes
 * (conditionPhysical, conditionCriticality, conditionEnvironment) whenever a
 * completed work order writes a new as-left condition. Null/undefined inputs
 * are skipped; an empty call returns 'C2' (the schema default).
 *
 * @param ratings any number of 'C1'|'C2'|'C3' (nullables tolerated)
 * @returns the worst rating present, or 'C2' when none given
 */
function worstCondition(...ratings) {
  let worst = null;
  for (const r of ratings) {
    if (!r || !CONDITION_SEVERITY[r]) continue;
    if (worst === null || CONDITION_SEVERITY[r] > CONDITION_SEVERITY[worst]) worst = r;
  }
  return worst || 'C2';
}

/**
 * Months between performances of a task for a given condition rating.
 *
 * Explicit per-condition columns on the task definition win (they carry the
 * exact NETA Appendix B published values from seed data). When the C1/C3
 * column is null the interval is derived from the C2 base:
 *
 *   C1 = min(round(base × 2.5), 60)          — NFPA 70B / NETA App. B, ≤60 mo
 *   C2 = base (intervalC2Months, always set) — published base interval
 *   C3 = max(1, min(round(base × 0.25), 12)) — ≤12 mo ceiling, 1 mo floor
 *
 * @param taskDef   MaintenanceTaskDefinition row (intervalC1/C2/C3Months)
 * @param condition 'C1' | 'C2' | 'C3'
 * @returns integer months
 */
function intervalMonthsFor(taskDef, condition) {
  const base = taskDef.intervalC2Months;

  if (condition === 'C1') {
    if (taskDef.intervalC1Months != null) return taskDef.intervalC1Months;
    return Math.min(Math.round(base * C1_MULTIPLIER), C1_CEILING_MONTHS);
  }

  if (condition === 'C3') {
    if (taskDef.intervalC3Months != null) return taskDef.intervalC3Months;
    return Math.max(C3_FLOOR_MONTHS, Math.min(Math.round(base * C3_MULTIPLIER), C3_CEILING_MONTHS));
  }

  // C2 (and any defensive fallback) — the base interval.
  return base;
}

/**
 * Next due date = last completion + the condition-appropriate interval.
 *
 * Null lastCompletedDate returns null — a schedule with no completion history
 * has no due date until its first completion (or a manual anchor) lands; the
 * schema documents nextDueDate as "null until first completion".
 *
 * @param lastCompletedDate Date | string | null
 * @param taskDef           MaintenanceTaskDefinition row
 * @param condition         'C1' | 'C2' | 'C3'
 * @returns Date | null
 */
function computeNextDueDate(lastCompletedDate, taskDef, condition) {
  if (!lastCompletedDate) return null;
  const anchor = new Date(lastCompletedDate);
  if (Number.isNaN(anchor.getTime())) return null;
  return addMonths(anchor, intervalMonthsFor(taskDef, condition));
}

/**
 * Completion recompute — the one shared spot both POST /schedules/:id/complete
 * and the work-order COMPLETE transition call so the two paths can never
 * drift. Resolves the schedule's effective condition from the asset's CURRENT
 * state (callers that just wrote a new as-left condition pass the updated
 * asset) and rolls the recurrence forward.
 *
 * @param taskDef       MaintenanceTaskDefinition row for the schedule
 * @param asset         Asset row (current governingCondition)
 * @param schedule      MaintenanceSchedule row (conditionOverride honored)
 * @param completedDate Date | string | null — null/undefined means "now"
 * @returns { lastCompletedDate: Date, nextDueDate: Date | null }
 */
function recomputeScheduleDates(taskDef, asset, schedule, completedDate) {
  const completed = completedDate ? new Date(completedDate) : new Date();
  const condition = effectiveCondition(asset, schedule);
  return {
    lastCompletedDate: completed,
    nextDueDate: computeNextDueDate(completed, taskDef, condition),
  };
}

module.exports = {
  effectiveCondition,
  worstCondition,
  intervalMonthsFor,
  computeNextDueDate,
  recomputeScheduleDates,
  // Constants exported for unit tests + the alert engine's display copy.
  C1_MULTIPLIER,
  C3_MULTIPLIER,
  C1_CEILING_MONTHS,
  C3_CEILING_MONTHS,
};

export {};
