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
// GET /api/dashboard/calendar  → schedule due dates + blackout windows for
//                                the Compliance Calendar page
//                                (?from=YYYY-MM&months=1..12&siteId=)
//
// Auth: authenticateToken mounted upstream. Every query scoped to
// req.user.accountId (tenancy/IDOR rule).
// ─────────────────────────────────────────────────────────────────────────────

const router = require('express').Router();
import prisma from '../lib/prisma';

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

      // Widget 4: recent work orders
      prisma.workOrder.findMany({
        where: { accountId },
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

    return res.json({
      success: true,
      data: {
        dueCounts: { due30, due60, due90, overdue: overdueSchedules },
        deficiencies: deficiencyBySeverity,
        complianceBySite,
        overallComplianceRate: overallTotal === 0 ? 100 : Math.round(((overallTotal - overallOverdue) / overallTotal) * 100),
        recentWorkOrders,
        upcoming,
        assetCount,
        scheduleCount: overallTotal,
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
    const months = isNaN(monthsRaw) ? 3 : Math.min(Math.max(monthsRaw, 1), 12);

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

module.exports = router;

export {};
