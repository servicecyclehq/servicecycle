/**
 * NFPA 70B §9.3.1 — auto-Condition-3 on two missed cycles.
 *
 * §9.3.1 lists, among the criteria that place equipment in Condition 3, that it
 * "has missed the last two successive maintenance cycles per the EMP." This
 * module implements that verbatim as COMPUTED state: a daily pass flips an
 * asset's `autoConditionC3` flag when any active schedule has lapsed ≥2 nominal
 * cycles, and clears it once maintenance catches up.
 *
 * Design choices that matter:
 *  - The flag is a SEPARATE governing input (governingCondition = worst of the
 *    three human axes AND this flag), so neglect tightens every interval
 *    WITHOUT overwriting a qualified person's physical/criticality/environment
 *    assessment. Completing the work clears the flag and restores the human
 *    governing condition automatically.
 *  - "Missed cycles" is measured against the NOMINAL (C2) interval, never the
 *    already-tightened C3 interval — otherwise auto-C3 would shorten the cycle,
 *    manufacture more "missed" cycles, and latch on forever.
 *  - Pure detection (`missedCyclesFor`) is exported separately so the rule is
 *    unit-testable without a database.
 */

import prisma from './prisma';
const { differenceInMonths } = require('date-fns');
const { worstCondition, intervalMonthsFor, computeNextDueDate } = require('./maintenanceInterval');
const { writeLog } = require('./activityLog');

const MISSED_CYCLES_THRESHOLD = 2; // §9.3.1: "the last two successive cycles"

/**
 * How many nominal maintenance cycles a schedule has gone past without a
 * completion. 0 when never baselined (that's "unbaselined", a different
 * compliance state, not "missed"). Pure — no DB.
 *
 * @param schedule { lastCompletedDate }
 * @param taskDef  { intervalC1Months, intervalC2Months, intervalC3Months }
 * @param now      Date (defaults to current time)
 */
function missedCyclesFor(schedule: any, taskDef: any, now: Date = new Date()): number {
  if (!schedule || !schedule.lastCompletedDate || !taskDef) return 0;
  const base = intervalMonthsFor(taskDef, 'C2'); // nominal cycle — avoids the C3 feedback loop
  if (!base || base <= 0) return 0;
  const last = new Date(schedule.lastCompletedDate);
  if (Number.isNaN(last.getTime())) return 0;
  const elapsed = differenceInMonths(now, last);
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / base);
}

/** True when any of the asset's active schedules has missed ≥2 nominal cycles. */
function assetIsAutoC3(asset: any, now: Date = new Date()): boolean {
  for (const s of asset.schedules || []) {
    if (missedCyclesFor(s, s.taskDefinition, now) >= MISSED_CYCLES_THRESHOLD) return true;
  }
  return false;
}

/**
 * Apply the §9.3.1 policy across one account. Toggles `autoConditionC3`,
 * recomputes governingCondition (worst of the three axes AND the flag),
 * cascades each non-overridden schedule's nextDueDate to the new interval, and
 * logs a cited condition_changed entry. Idempotent — assets already in the
 * correct state are skipped. Returns a small summary for the cron log.
 */
async function applyMissedCyclePolicy(db: any, accountId: string, now: Date = new Date()) {
  const assets = await db.asset.findMany({
    where: { accountId, archivedAt: null },
    select: {
      id: true, conditionPhysical: true, conditionCriticality: true, conditionEnvironment: true,
      governingCondition: true, autoConditionC3: true,
      schedules: {
        where: { isActive: true },
        select: {
          id: true, lastCompletedDate: true, nextDueDate: true, conditionOverride: true,
          taskDefinition: { select: { intervalC1Months: true, intervalC2Months: true, intervalC3Months: true } },
        },
      },
    },
  });

  let c3Set = 0, c3Cleared = 0;
  for (const a of assets) {
    const shouldC3 = assetIsAutoC3(a, now);
    if (shouldC3 === a.autoConditionC3) continue; // no transition

    const governing = worstCondition(a.conditionPhysical, a.conditionCriticality, a.conditionEnvironment, shouldC3 ? 'C3' : null);
    await db.asset.update({ where: { id: a.id }, data: { autoConditionC3: shouldC3, governingCondition: governing } });

    // Cascade interval math to the schedules the asset's condition governs.
    for (const s of a.schedules) {
      if (s.conditionOverride || !s.lastCompletedDate) continue;
      const nd = computeNextDueDate(s.lastCompletedDate, s.taskDefinition, governing);
      await db.maintenanceSchedule.update({ where: { id: s.id }, data: { nextDueDate: nd } });
    }

    if (a.governingCondition !== governing) {
      await writeLog({
        assetId: a.id, userId: null, accountId, action: 'condition_changed',
        details: {
          from: a.governingCondition, to: governing,
          reason: shouldC3
            ? 'Auto Condition 3 — missed two successive maintenance cycles (NFPA 70B §9.3.1)'
            : 'Auto Condition 3 cleared — maintenance back on cycle (NFPA 70B §9.3.1)',
          standardRef: 'NFPA 70B:2023 §9.3.1', auto: true,
        },
      });
    }
    if (shouldC3) c3Set++; else c3Cleared++;
  }
  return { assetsChecked: assets.length, c3Set, c3Cleared };
}

module.exports = { missedCyclesFor, assetIsAutoC3, applyMissedCyclePolicy, MISSED_CYCLES_THRESHOLD };

export {};
