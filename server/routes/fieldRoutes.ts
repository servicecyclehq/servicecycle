/**
 * /api/field — Field Mode read endpoints for technicians on a phone.
 *
 * Two screens, two endpoints, one round-trip each (these power a phone on
 * bad signal — every payload is deliberately slim):
 *
 *   GET /api/field/summary    — the tech's "My Day": overdue + due-soon
 *                               schedules, open work orders, open
 *                               deficiencies. Optional ?siteId= narrows to
 *                               one site. 25 items per list, most-urgent
 *                               first.
 *   GET /api/field/asset/:id  — the field card a QR label lands on:
 *                               asset context + active schedules (with
 *                               status) + open deficiencies + open work
 *                               orders, all in one query.
 *
 * Read-only — any authenticated role (the person holding the phone next to
 * the switchgear is exactly who should see this). Mounted behind
 * authenticateToken in index.ts. TENANCY: every query filters
 * accountId = req.user.accountId.
 */

const router = require('express').Router();
const prisma = require('../lib/prisma').default;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Slim asset shape shared by every summary list item — enough to render a
// recognizable card line ("SWITCHGEAR · Square D Model 6 · S/N 123 — Plant 2")
// and deep-link to /field/asset/:id, nothing more.
const FIELD_ASSET_SELECT = {
  id: true, equipmentType: true, manufacturer: true, model: true,
  serialNumber: true,
  site: { select: { id: true, name: true } },
};

// Same status taxonomy as lib/complianceReport (active schedules only here,
// so 'inactive' can't occur): unbaselined = no nextDueDate yet; otherwise
// overdue/current by comparison against now.
function scheduleStatus(nextDueDate, now) {
  if (!nextDueDate) return 'unbaselined';
  return nextDueDate < now ? 'overdue' : 'current';
}

// ─── GET /api/field/summary ───────────────────────────────────────────────────
// The tech's "My Day". Four capped lists, each item { asset, <specific> }:
//   overdue          — active schedules past due, most overdue first
//   dueSoon          — active schedules due within the next 30 days, soonest first
//   openWorkOrders   — SCHEDULED / IN_PROGRESS work orders, soonest scheduled first
//   openDeficiencies — unresolved findings, severity (IMMEDIATE→ADVISORY) then newest
// Optional ?siteId= narrows every list to one site (validated against the
// account). Archived assets are excluded everywhere.
router.get('/summary', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const { siteId } = req.query;
    const TAKE = 25;

    if (siteId !== undefined) {
      if (!UUID_RE.test(String(siteId))) {
        return res.status(400).json({ success: false, error: 'siteId must be a uuid' });
      }
      const site = await prisma.site.findFirst({
        where: { id: String(siteId), accountId },
        select: { id: true },
      });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });
    }

    const now = new Date();
    const soonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Asset-side filter applied to every list: live (non-archived) assets,
    // optionally narrowed to one site.
    const assetFilter: any = { archivedAt: null };
    if (siteId) assetFilter.siteId = String(siteId);

    const scheduleSelect = {
      id: true, nextDueDate: true,
      taskDefinition: { select: { taskName: true, requiresOutage: true } },
      asset: { select: FIELD_ASSET_SELECT },
    };

    const [overdueRows, dueSoonRows, workOrderRows, deficiencyRows] = await Promise.all([
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId, isActive: true,
          nextDueDate: { lt: now },
          asset: assetFilter,
        },
        select: scheduleSelect,
        orderBy: { nextDueDate: 'asc' }, // most overdue first
        take: TAKE,
      }),
      prisma.maintenanceSchedule.findMany({
        where: {
          accountId, isActive: true,
          nextDueDate: { gte: now, lte: soonCutoff },
          asset: assetFilter,
        },
        select: scheduleSelect,
        orderBy: { nextDueDate: 'asc' }, // soonest first
        take: TAKE,
      }),
      prisma.workOrder.findMany({
        where: {
          accountId,
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          asset: assetFilter,
        },
        select: {
          id: true, status: true, scheduledDate: true,
          schedule: { select: { taskDefinition: { select: { taskName: true } } } },
          asset: { select: FIELD_ASSET_SELECT },
        },
        // Soonest scheduled first; Postgres ASC puts unscheduled (null) last.
        orderBy: { scheduledDate: 'asc' },
        take: TAKE,
      }),
      prisma.deficiency.findMany({
        where: {
          accountId,
          resolvedAt: null,
          asset: assetFilter,
        },
        select: {
          id: true, severity: true, description: true, createdAt: true,
          asset: { select: FIELD_ASSET_SELECT },
        },
        // Severity band first (enum declaration order IMMEDIATE → ADVISORY),
        // newest within each band — same triage ordering as /api/deficiencies.
        orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        take: TAKE,
      }),
    ]);

    res.json({
      success: true,
      data: {
        overdue: overdueRows.map((s) => ({
          asset: s.asset,
          schedule: { id: s.id, nextDueDate: s.nextDueDate, taskDefinition: s.taskDefinition },
        })),
        dueSoon: dueSoonRows.map((s) => ({
          asset: s.asset,
          schedule: { id: s.id, nextDueDate: s.nextDueDate, taskDefinition: s.taskDefinition },
        })),
        openWorkOrders: workOrderRows.map((wo) => ({
          asset: wo.asset,
          workOrder: {
            id: wo.id, status: wo.status, scheduledDate: wo.scheduledDate,
            taskName: wo.schedule?.taskDefinition?.taskName ?? null,
          },
        })),
        openDeficiencies: deficiencyRows.map((d) => ({
          asset: d.asset,
          deficiency: { id: d.id, severity: d.severity, description: d.description, createdAt: d.createdAt },
        })),
      },
    });
  } catch (err) {
    console.error('Field summary error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch field summary' });
  }
});

// ─── GET /api/field/asset/:id ─────────────────────────────────────────────────
// The field card payload — what a tech sees after scanning the QR label on
// the equipment. ONE prisma query (nested includes), slim selects throughout.
//
// Returns:
//   asset            — identity + location (site, position), condition axes +
//                      governingCondition, owner name, fedFrom (upstream
//                      source, slim), downstreamCount (_count.feedsDownstream)
//   activeSchedules  — isActive only, each with status current|overdue|
//                      unbaselined, taskDefinition {taskName, requiresOutage,
//                      standardRef}, nextDueDate, lastCompletedDate
//   openDeficiencies — id, severity, description
//   openWorkOrders   — id, status, taskName (from the schedule's task def)
router.get('/asset/:id', async (req, res) => {
  try {
    const asset = await prisma.asset.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: {
        id: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, installDate: true,
        conditionPhysical: true, conditionCriticality: true, conditionEnvironment: true,
        governingCondition: true,
        inService: true, isEnergized: true,
        site:     { select: { id: true, name: true } },
        position: { select: { id: true, name: true, code: true } },
        owner:    { select: { id: true, name: true } },
        fedFrom:  { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true } },
        _count:   { select: { feedsDownstream: true } },
        schedules: {
          where: { isActive: true },
          select: {
            id: true, nextDueDate: true, lastCompletedDate: true,
            taskDefinition: { select: { taskName: true, requiresOutage: true, standardRef: true } },
          },
          orderBy: { nextDueDate: 'asc' },
        },
        deficiencies: {
          where: { resolvedAt: null },
          select: { id: true, severity: true, description: true },
          orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
        },
        workOrders: {
          where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
          select: {
            id: true, status: true,
            schedule: { select: { taskDefinition: { select: { taskName: true } } } },
          },
          orderBy: { scheduledDate: 'asc' },
        },
      },
    });

    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    const now = new Date();
    const { schedules, deficiencies, workOrders, _count, ...assetFields } = asset;

    res.json({
      success: true,
      data: {
        asset: { ...assetFields, downstreamCount: _count?.feedsDownstream ?? 0 },
        activeSchedules: schedules.map((s) => ({
          id: s.id,
          status: scheduleStatus(s.nextDueDate, now),
          nextDueDate: s.nextDueDate,
          lastCompletedDate: s.lastCompletedDate,
          taskDefinition: s.taskDefinition,
        })),
        openDeficiencies: deficiencies,
        openWorkOrders: workOrders.map((wo) => ({
          id: wo.id,
          status: wo.status,
          taskName: wo.schedule?.taskDefinition?.taskName ?? null,
        })),
      },
    });
  } catch (err) {
    console.error('Field asset card error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch asset' });
  }
});

module.exports = router;

export {};
