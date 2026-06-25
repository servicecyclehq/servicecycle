// ─────────────────────────────────────────────────────────────────────────────
// routes/dashboard.ts — ServiceCycle compliance dashboard aggregates.
//
// Replaces the renewal-countdown widget API with the KICKOFF Goal-3 set:
//   - assets due in 30/60/90 days (active maintenance schedules)
//   - overdue counts (schedules) + open deficiencies by severity
//   - compliance rate by site (active schedules not overdue / total)
//   - recent work orders
//
// GET /api/dashboard           → all widgets in one round-trip
// GET /api/dashboard/priority  → risk-dimension priority tabs
//                                (?tab=critical|value|volume&siteId=)
// GET /api/dashboard/calendar  → schedule due dates + blackout windows for
//                                the Compliance Calendar page
//                                (?from=YYYY-MM&months=1..36&siteId=&density=1)
//                                density=1 → per-month aggregate only (the
//                                dashboard 36-month strip); without it the
//                                full schedules+blackouts payload (calendar
//                                page, ≤12 months in practice)
//
// Auth: authenticateToken mounted upstream. Every query scoped to
// req.user.accountId (tenancy/IDOR rule).
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
import prisma from '../lib/prisma';
// Single source of truth for the compliance rates (overall / schedule / coverage)
// so the dashboard tile can never drift from the Path-to-100 card.
const { buildComplianceGap } = require('../lib/complianceReport');

const DAY_MS = 86_400_000;

router.get('/', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now  = new Date();
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const in60 = new Date(now.getTime() + 60 * DAY_MS);
    const in90 = new Date(now.getTime() + 90 * DAY_MS);

    const scheduleBase: any = {
      accountId,
      isActive: true,
      nextDueDate: { not: null },
      asset: { archivedAt: null },
    };

    const [
      due30, due60, due90,
      overdueSchedules,
      openDeficiencies,
      siteRollup,
      recentWorkOrders,
      assetCount,
      upcoming,
      partsAlertsCount,
    ] = await Promise.all([
      // Widget 1: due-in-N counts (cumulative forward windows; overdue is
      // its own tile so the two never double-count).
      prisma.maintenanceSchedule.count({ where: { ...scheduleBase, nextDueDate: { gte: now, lte: in30 } } }),
      prisma.maintenanceSchedule.count({ where: { ...scheduleBase, nextDueDate: { gte: now, lte: in60 } } }),
      prisma.maintenanceSchedule.count({ where: { ...scheduleBase, nextDueDate: { gte: now, lte: in90 } } }),

      // Widget 2a: overdue schedules
      prisma.maintenanceSchedule.count({ where: { ...scheduleBase, nextDueDate: { lt: now } } }),

      // Widget 2b: open deficiencies by severity
      prisma.deficiency.groupBy({
        by: ['severity'],
        where: { accountId, resolvedAt: null },
        _count: { _all: true },
      }),

      // Widget 3: compliance rate by site. Slim projection aggregated in
      // JS — site counts are bounded (tens, not thousands) and Prisma can't
      // express the conditional ratio in one groupBy.
      prisma.maintenanceSchedule.findMany({
        where: scheduleBase,
        select: {
          nextDueDate: true,
          asset: { select: { siteId: true, site: { select: { name: true } } } },
        },
      }),

      // Widget 4: recent work orders. V7: exclude synthetic WOs created by
      // test-report ingest (they're evidence records, not field jobs) so they
      // don't crowd out real work in the recency feed.
      prisma.workOrder.findMany({
        where: { accountId, NOT: { notes: { contains: '[ingest:test_report]' } } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        include: {
          asset:      { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { name: true } } } },
          contractor: { select: { id: true, name: true } },
          schedule:   { select: { taskDefinition: { select: { taskName: true } } } },
        },
      }),

      prisma.asset.count({ where: { accountId, archivedAt: null } }),

      // Next-up table: nearest due schedules (incl. overdue) under the tiles.
      prisma.maintenanceSchedule.findMany({
        where: { ...scheduleBase, nextDueDate: { lte: in90 } },
        orderBy: { nextDueDate: 'asc' },
        take: 10,
        include: {
          taskDefinition: { select: { taskName: true, standardRef: true, requiresOutage: true } },
          asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, governingCondition: true, site: { select: { id: true, name: true } } } },
        },
      }),

      // Parts Alerts: count of SpareInventory entries where qtyOnHand < qtyMin.
      // Prisma lacks field-to-field comparison so we pull managed entries and filter in JS.
      // Also computes procurementRiskCount: low-stock parts with leadTimeWeeks >= 8.
      prisma.spareInventory.findMany({
        where: { accountId, qtyMin: { not: null } },
        select: { qtyOnHand: true, qtyMin: true, part: { select: { leadTimeWeeks: true } } },
      }).then((managed: any[]) => {
        const low = managed.filter(e => e.qtyOnHand < e.qtyMin);
        return {
          count: low.length,
          procurementRiskCount: low.filter((e: any) => e.part?.leadTimeWeeks != null && e.part.leadTimeWeeks >= 8).length,
        };
      }),
    ]);

    // Compliance rate per site: % of active schedules NOT overdue.
    const bySite = new Map();
    for (const s of siteRollup) {
      const key = s.asset.siteId;
      if (!bySite.has(key)) bySite.set(key, { siteId: key, siteName: s.asset.site?.name || '—', total: 0, overdue: 0 });
      const row = bySite.get(key);
      row.total++;
      if (s.nextDueDate && new Date(s.nextDueDate) < now) row.overdue++;
    }
    const complianceBySite = [...bySite.values()]
      .map(r => ({ ...r, complianceRate: r.total === 0 ? 100 : Math.round(((r.total - r.overdue) / r.total) * 100) }))
      .sort((a, b) => a.complianceRate - b.complianceRate);

    const overallTotal   = siteRollup.length;
    const overallOverdue = siteRollup.filter(s => s.nextDueDate && new Date(s.nextDueDate) < now).length;

    const deficiencyBySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
    for (const g of openDeficiencies) deficiencyBySeverity[g.severity] = g._count._all;

    // ── Compliance rates — reuse buildComplianceGap so the dashboard tile and
    //    the Path-to-100 card are ALWAYS the same numbers (they used to be
    //    computed twice and drift on EMP-gap inclusion + rounding):
    //      overallRate     = honest overall: current / (current + overdue +
    //                        unbaselined + uncovered assets + EMP §4.2 gaps)
    //      compliance.rate = schedule compliance among tracked tasks only
    //      coverage.rate   = assets that have any program / total assets
    const gap = await buildComplianceGap(prisma, accountId);
    const overallComplianceRateHonest = gap.overallRate;        // honest, audit-ready
    const scheduleComplianceRate      = gap.compliance.rate;    // tracked-tasks-only
    const coverageRate                = gap.coverage.rate;
    const coveredAssets               = gap.coverage.coveredAssets;
    const totalAssets                 = gap.coverage.totalAssets;
    const uncoveredAssets             = gap.coverage.uncoveredAssets;

    return res.json({
      success: true,
      data: {
        dueCounts: { due30, due60, due90, overdue: overdueSchedules },
        deficiencies: deficiencyBySeverity,
        complianceBySite,
        // Legacy flattering rate (active schedules not overdue) — kept for the
        // per-site drill-in tooltip; NOT the headline.
        overallComplianceRate: overallTotal === 0 ? 100 : Math.round(((overallTotal - overallOverdue) / overallTotal) * 100),
        overallComplianceRateHonest,
        scheduleComplianceRate,
        coverageRate,
        coveredAssets,
        totalAssets,
        uncoveredAssets,
        recentWorkOrders,
        upcoming,
        assetCount,
        scheduleCount: overallTotal,
        partsAlerts: partsAlertsCount.count,
        partsProcurementRisk: partsAlertsCount.procurementRiskCount,
      },
    });
  } catch (err) {
    console.error('[dashboard] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to load dashboard data' });
  }
});

// ── GET /api/dashboard/calendar ──────────────────────────────────────────────
// Due dates + blackout windows for the Compliance Calendar. Blackouts ship in
// the same payload so the calendar can render outage-work feasibility
// (requiresOutage tasks should land inside isOutageWindow=true windows).
router.get('/calendar', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const monthsRaw = parseInt(req.query.months, 10);
    // Cap raised 12 → 36 for the dashboard density strip; long ranges should
    // use density=1 below so the full-payload branch stays a ≤12-month load.
    const months = isNaN(monthsRaw) ? 3 : Math.min(Math.max(monthsRaw, 1), 36);

    let start;
    if (typeof req.query.from === 'string' && /^\d{4}-\d{2}$/.test(req.query.from)) {
      const [yr, mo] = req.query.from.split('-').map(Number);
      start = new Date(yr, mo - 1, 1);
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    const end = new Date(start.getFullYear(), start.getMonth() + months, 1);

    const assetWhere: any = { archivedAt: null };
    if (req.query.siteId) assetWhere.siteId = String(req.query.siteId);

    // ── density=1: server-side per-month aggregate ────────────────────────
    // The dashboard 36-month strip only needs three numbers per month —
    // shipping 36 months of full schedule rows (hydrated task + asset +
    // site) would be a multi-hundred-KB payload for a sparkline. SLIM
    // select (nextDueDate + requiresOutage only), bucketed by YYYY-MM here.
    // overdue = due items whose nextDueDate is already behind now (covers
    // every fully-past month plus the elapsed part of the current one).
    if (String(req.query.density || '') === '1') {
      const slim = await prisma.maintenanceSchedule.findMany({
        where: {
          accountId,
          isActive: true,
          nextDueDate: { gte: start, lt: end },
          asset: assetWhere,
        },
        select: {
          nextDueDate: true,
          taskDefinition: { select: { requiresOutage: true } },
        },
      });

      const now = new Date();
      const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

      // Pre-seed every month in range so the strip renders gap-free zeroes.
      const buckets = new Map();
      for (let i = 0; i < months; i++) {
        const key = monthKey(new Date(start.getFullYear(), start.getMonth() + i, 1));
        buckets.set(key, { month: key, due: 0, requiresOutage: 0, overdue: 0 });
      }

      for (const s of slim) {
        const due = new Date(s.nextDueDate);
        const bucket = buckets.get(monthKey(due));
        if (!bucket) continue;
        bucket.due++;
        if (s.taskDefinition?.requiresOutage) bucket.requiresOutage++;
        if (due < now) bucket.overdue++;
      }

      return res.json({ success: true, data: { density: [...buckets.values()] } });
    }

    const [schedules, blackouts] = await Promise.all([
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId,
          isActive: true,
          nextDueDate: { gte: start, lt: end },
          asset: assetWhere,
        },
        orderBy: { nextDueDate: 'asc' },
        take: 1000,
        include: {
          taskDefinition: { select: { taskName: true, requiresOutage: true, standardRef: true } },
          asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
        },
      }),
      prisma.blackoutWindow.findMany({
        where: {
          accountId,
          startsAt: { lt: end },
          endsAt:   { gt: start },
          ...(req.query.siteId ? { siteId: String(req.query.siteId) } : {}),
        },
        include: { site: { select: { id: true, name: true } } },
      }),
    ]);

    return res.json({ success: true, data: { schedules, blackouts, range: { start, end } } });
  } catch (err) {
    console.error('[dashboard/calendar] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to load calendar data' });
  }
});

// ── GET /api/dashboard/priority ──────────────────────────────────────────────
// Priority dashboard tabs over the 2026-06-07 risk dimensions
// (criticalityScore / repairCostEstimate / spareLeadTimeWeeks /
// redundancyStatus / requiresPredictiveMaintenance on Asset).
//
//   ?tab=critical — infrastructure-critical assets: criticalityScore >= 4 OR
//                   life-safety/backbone equipment type. Ordered
//                   criticalityScore desc nulls-last, then worst schedule
//                   status (overdue → due ≤30d → due later → unscheduled).
//   ?tab=value    — financial-exposure assets: repairCostEstimate >= $20k OR
//                   spareLeadTimeWeeks >= 8 OR requiresPredictiveMaintenance.
//                   Ordered repairCostEstimate desc nulls-last; rows add the
//                   latest predictive signal (most recent labSample with an
//                   IEEE C57.104 status).
//   ?tab=volume   — operational workload by equipmentType: assetCount,
//                   openScheduleCount (active), overdueCount, due30Count.
//                   Ordered assetCount desc.
//   ?siteId=      — optional uuid, narrows every tab to one site.
//
// All tabs: accountId-scoped, archived assets excluded, ≤50 rows.
const PRIORITY_ROW_CAP = 50;
// Life-safety / backbone types that belong on the critical tab regardless of
// (possibly unscored) criticalityScore.
const CRITICAL_EQUIPMENT_TYPES = [
  'GENERATOR', 'TRANSFER_SWITCH', 'UPS_BATTERY',
  'PROTECTION_RELAY', 'GROUNDING_SYSTEM', 'FIRE_PUMP_CONTROLLER',
];

// Slim asset projection shared by the critical/value tabs.
const PRIORITY_ASSET_SELECT: any = {
  id: true, equipmentType: true, manufacturer: true, model: true,
  serialNumber: true, criticalityScore: true, redundancyStatus: true,
  governingCondition: true, inService: true,
  site:     { select: { id: true, name: true } },
  position: { select: { id: true, name: true, code: true } },
};

// Roll active schedules up to the per-asset summary the tab rows carry:
// nextDue (earliest dated active schedule + its task name), overdueCount,
// lastCompletedDate (latest completion across schedules).
function _rollupSchedules(schedules, now) {
  let next = null;
  let overdueCount = 0;
  let lastCompletedDate = null;
  for (const s of schedules || []) {
    if (s.nextDueDate) {
      const d = new Date(s.nextDueDate);
      if (d < now) overdueCount++;
      if (!next || d < next.date) {
        next = { date: d, taskName: s.taskDefinition?.taskName ?? null };
      }
    }
    if (s.lastCompletedDate) {
      const c = new Date(s.lastCompletedDate);
      if (!lastCompletedDate || c > lastCompletedDate) lastCompletedDate = c;
    }
  }
  return {
    nextDue: next ? { date: next.date, taskName: next.taskName } : null,
    overdueCount,
    lastCompletedDate,
  };
}

// Schedule-status severity for the critical-tab tiebreak: overdue worst,
// then due inside 30 days, then due later, then nothing scheduled.
function _statusRank(rollup, now) {
  if (rollup.overdueCount > 0) return 0;
  if (rollup.nextDue) {
    return rollup.nextDue.date.getTime() - now.getTime() <= 30 * DAY_MS ? 1 : 2;
  }
  return 3;
}

router.get('/priority', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now = new Date();
    const tab = String(req.query.tab || '');
    if (!['critical', 'value', 'volume'].includes(tab)) {
      return res.status(400).json({ success: false, error: 'tab must be critical, value, or volume' });
    }

    // Archived assets are excluded everywhere; optional siteId narrows.
    const baseWhere: any = { accountId, archivedAt: null };
    if (req.query.siteId) baseWhere.siteId = String(req.query.siteId);

    // ── critical ──────────────────────────────────────────────────────────
    if (tab === 'critical') {
      const assets: any[] = await prisma.asset.findMany({
        where: {
          ...baseWhere,
          OR: [
            { criticalityScore: { gte: 4 } },
            { equipmentType: { in: CRITICAL_EQUIPMENT_TYPES as any } },
          ],
        },
        // DB pre-orders by score; the schedule-status tiebreak happens in JS
        // below. 250-row headroom keeps the tiebreak correct well past the
        // 50-row cap for any realistic tenant.
        orderBy: { criticalityScore: { sort: 'desc', nulls: 'last' } },
        take: 250,
        select: {
          ...PRIORITY_ASSET_SELECT,
          schedules: {
            where:  { isActive: true },
            select: {
              nextDueDate: true, lastCompletedDate: true,
              taskDefinition: { select: { taskName: true } },
            },
          },
          _count: { select: { deficiencies: { where: { resolvedAt: null } } } },
        },
      });

      const rows = assets.map((a) => {
        const { schedules, _count, ...slim } = a;
        const rollup = _rollupSchedules(schedules, now);
        return {
          ...slim,
          nextDue:             rollup.nextDue,
          overdueCount:        rollup.overdueCount,
          openDeficiencyCount: _count?.deficiencies ?? 0,
          lastCompletedDate:   rollup.lastCompletedDate,
          _rank:               _statusRank(rollup, now),
        };
      });
      rows.sort((a, b) => {
        const sa = a.criticalityScore, sb = b.criticalityScore;
        if (sa !== sb) {
          if (sa === null) return 1;  // nulls last
          if (sb === null) return -1;
          return sb - sa;             // score desc
        }
        return a._rank - b._rank;     // then worst schedule status first
      });
      const capped = rows.slice(0, PRIORITY_ROW_CAP).map(({ _rank, ...row }) => row);
      return res.json({ success: true, data: { tab, rows: capped } });
    }

    // ── value ─────────────────────────────────────────────────────────────
    if (tab === 'value') {
      const assets: any[] = await prisma.asset.findMany({
        where: {
          ...baseWhere,
          OR: [
            { repairCostEstimate: { gte: 20000 } },
            { spareLeadTimeWeeks: { gte: 8 } },
            { requiresPredictiveMaintenance: true },
          ],
        },
        orderBy: { repairCostEstimate: { sort: 'desc', nulls: 'last' } },
        take: PRIORITY_ROW_CAP,
        select: {
          ...PRIORITY_ASSET_SELECT,
          repairCostEstimate:            true,
          spareLeadTimeWeeks:            true,
          requiresPredictiveMaintenance: true,
          schedules: {
            where:  { isActive: true },
            select: {
              nextDueDate: true, lastCompletedDate: true,
              taskDefinition: { select: { taskName: true } },
            },
          },
          _count: { select: { deficiencies: { where: { resolvedAt: null } } } },
          // Latest predictive signal: most recent lab sample carrying an
          // IEEE C57.104 DGA status (null for assets without lab history).
          labSamples: {
            where:   { ieeeStatus: { not: null } },
            orderBy: { sampleDate: 'desc' },
            take:    1,
            select:  { ieeeStatus: true, faultCode: true, sampleType: true, sampleDate: true },
          },
        },
      });

      const rows = assets.map((a) => {
        const { schedules, _count, labSamples, ...slim } = a;
        const rollup = _rollupSchedules(schedules, now);
        return {
          ...slim,
          nextDue:                rollup.nextDue,
          overdueCount:           rollup.overdueCount,
          openDeficiencyCount:    _count?.deficiencies ?? 0,
          lastCompletedDate:      rollup.lastCompletedDate,
          latestPredictiveSignal: labSamples?.[0] ?? null,
        };
      });
      return res.json({ success: true, data: { tab, rows } });
    }

    // ── volume ────────────────────────────────────────────────────────────
    // Workload view by equipmentType. Schedule counts can't ride a relation
    // groupBy, so: one asset groupBy + one slim active-schedule projection
    // bucketed in JS (bounded by the account's schedule count, same approach
    // as the compliance-by-site rollup above).
    const in30 = new Date(now.getTime() + 30 * DAY_MS);
    const [assetGroups, schedules] = await Promise.all([
      prisma.asset.groupBy({
        by: ['equipmentType'],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId,
          isActive: true,
          asset: { archivedAt: null, ...(req.query.siteId ? { siteId: String(req.query.siteId) } : {}) },
        },
        select: {
          nextDueDate: true,
          asset: { select: { equipmentType: true } },
        },
      }),
    ]);

    const byType = new Map();
    for (const g of assetGroups) {
      byType.set(g.equipmentType, {
        equipmentType:     g.equipmentType,
        assetCount:        g._count._all,
        openScheduleCount: 0,
        overdueCount:      0,
        due30Count:        0,
      });
    }
    for (const s of schedules) {
      const row = byType.get(s.asset.equipmentType);
      if (!row) continue; // schedule on a type with zero unarchived assets — can't happen, but never throw
      row.openScheduleCount++;
      if (s.nextDueDate) {
        const d = new Date(s.nextDueDate);
        if (d < now) row.overdueCount++;
        else if (d <= in30) row.due30Count++;
      }
    }
    const rows = [...byType.values()]
      .sort((a, b) => b.assetCount - a.assetCount)
      .slice(0, PRIORITY_ROW_CAP);
    return res.json({ success: true, data: { tab, rows } });
  } catch (err) {
    console.error('[dashboard/priority] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to load priority data' });
  }
});

// GET /trends - monthly maintenance-completion trend for dashboard sparklines,
// derived from COMPLETE work orders (no new tables). on-time = completedDate
// within a 7-day grace of scheduledDate. Query: ?months=24 (clamped 6..60).
router.get('/trends', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const months = Math.min(60, Math.max(6, parseInt(String(req.query.months || '24'), 10) || 24));
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const wos = await prisma.workOrder.findMany({
      where: { accountId, status: 'COMPLETE', completedDate: { gte: start } },
      select: { completedDate: true, scheduledDate: true },
    });
    const buckets = new Map<string, any>();
    for (let m = 0; m < months; m++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + m, 1);
      buckets.set(d.getFullYear() + '-' + d.getMonth(), { label: d.toISOString().slice(0, 7), completed: 0, onTime: 0 });
    }
    const GRACE = 7 * 24 * 3600 * 1000;
    for (const wo of wos) {
      if (!wo.completedDate) continue;
      const cd = new Date(wo.completedDate);
      const b = buckets.get(cd.getFullYear() + '-' + cd.getMonth());
      if (!b) continue;
      b.completed++;
      if (wo.scheduledDate && cd.getTime() <= new Date(wo.scheduledDate).getTime() + GRACE) b.onTime++;
    }
    const series = Array.from(buckets.values()).map((b: any) => ({
      month: b.label,
      completed: b.completed,
      onTimeRate: b.completed > 0 ? Math.round((b.onTime / b.completed) * 100) : null,
    }));
    return res.json({ success: true, data: { series } });
  } catch (err: any) {
    console.error('[dashboard/trends]', err && err.message);
    return res.status(500).json({ success: false, error: 'Failed to load trends.' });
  }
});

module.exports = router;

export {};
