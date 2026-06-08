/**
 * /api/outage-planner — Account-wide Outage Consolidation Planner.
 *
 * Returns every asset that has outage-requiring maintenance tasks due within
 * ±90 days, grouped by site. Consumers use this to see the full account
 * picture and create consolidated work orders covering multiple assets at once.
 *
 *   GET /summary   — grouped-by-site list of assets + their outage tasks
 *   POST /work-order — create a multi-asset consolidated WO (manager+)
 *
 * Mounted at /api/outage-planner in server/index.ts.
 */

'use strict';

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

const WINDOW_DAYS = 90;

function assetLabel(a: { manufacturer?: string|null, model?: string|null, serialNumber?: string|null, equipmentType?: string|null }): string {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType ?? 'Asset');
}

function taskStatus(nextDueDate: Date | null | undefined): 'overdue' | 'due' | 'upcoming' {
  if (!nextDueDate) return 'upcoming';
  const daysUntil = (new Date(nextDueDate).getTime() - Date.now()) / 86400000;
  if (daysUntil < 0)   return 'overdue';
  if (daysUntil <= 30) return 'due';
  return 'upcoming';
}

// ── GET /api/outage-planner/summary ──────────────────────────────────────────
// Returns assets with outage-requiring tasks due within ±90 days, grouped
// by site. Each asset row carries its outage tasks and an open-WO flag so
// the UI can suppress assets that already have a scheduled work order.

router.get('/summary', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now       = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 86400000);
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86400000);

    // 1. Find all active schedules for outage-requiring tasks in the window
    const schedules = await prisma.maintenanceSchedule.findMany({
      where: {
        accountId,
        isActive: true,
        taskDefinition: { requiresOutage: true },
        OR: [
          { nextDueDate: { gte: windowStart, lte: windowEnd } },
          { nextDueDate: { lt: now } }, // overdue — always include
        ],
      },
      select: {
        id: true,
        nextDueDate: true,
        assetId: true,
        taskDefinition: {
          select: { id: true, taskName: true, taskCode: true, standardRef: true,
                    requiresOutage: true, intervalC2Months: true },
        },
        asset: {
          select: {
            id: true, manufacturer: true, model: true, serialNumber: true,
            equipmentType: true, criticalityScore: true, archivedAt: true,
            inService: true,
            site: { select: { id: true, name: true } },
            workOrders: {
              where:   { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
              select:  { id: true, status: true },
              take:    1,
            },
          },
        },
      },
    });

    // 2. Discard schedules for archived assets
    const active = schedules.filter((s: any) => !s.asset.archivedAt);

    // 3. Group by site → asset
    const siteMap: Record<string, any> = {};
    for (const s of active) {
      const site   = s.asset.site;
      const siteId = site?.id ?? '__no_site__';
      if (!siteMap[siteId]) {
        siteMap[siteId] = { siteId, siteName: site?.name ?? 'No site', assetMap: {} };
      }
      const assetId = s.asset.id;
      if (!siteMap[siteId].assetMap[assetId]) {
        siteMap[siteId].assetMap[assetId] = {
          assetId,
          assetName:        assetLabel(s.asset),
          equipmentType:    s.asset.equipmentType,
          criticalityScore: s.asset.criticalityScore,
          inService:        s.asset.inService,
          hasOpenWO:        s.asset.workOrders.length > 0,
          tasks:            [],
        };
      }
      siteMap[siteId].assetMap[assetId].tasks.push({
        scheduleId: s.id,
        taskName:   s.taskDefinition.taskName,
        taskCode:   s.taskDefinition.taskCode,
        standardRef: s.taskDefinition.standardRef,
        dueDate:    s.nextDueDate,
        status:     taskStatus(s.nextDueDate),
      });
    }

    // 4. Flatten and compute per-site savings estimate
    const sites = Object.values(siteMap).map((site: any) => {
      const assets = Object.values(site.assetMap) as any[];
      // Sort tasks within each asset: overdue first, then by date
      for (const a of assets) {
        a.tasks.sort((x: any, y: any) => {
          const order = { overdue: 0, due: 1, upcoming: 2 };
          const diff = (order[x.status] ?? 2) - (order[y.status] ?? 2);
          if (diff !== 0) return diff;
          return (x.dueDate ? new Date(x.dueDate).getTime() : 0) - (y.dueDate ? new Date(y.dueDate).getTime() : 0);
        });
      }
      // Sort assets: those with overdue tasks first, then by criticality desc
      assets.sort((a, b) => {
        const aOverdue = a.tasks.some((t: any) => t.status === 'overdue') ? 0 : 1;
        const bOverdue = b.tasks.some((t: any) => t.status === 'overdue') ? 0 : 1;
        if (aOverdue !== bOverdue) return aOverdue - bOverdue;
        return (b.criticalityScore ?? 0) - (a.criticalityScore ?? 0);
      });

      const totalTasks        = assets.reduce((n: number, a: any) => n + a.tasks.length, 0);
      const overdueTasks      = assets.reduce((n: number, a: any) => n + a.tasks.filter((t: any) => t.status === 'overdue').length, 0);
      const shutdownsAvoided  = Math.max(0, assets.length - 1); // 1 shared outage vs N separate
      return {
        siteId:          site.siteId,
        siteName:        site.siteName,
        assets,
        totalAssets:     assets.length,
        totalTasks,
        overdueTasks,
        shutdownsAvoided,
      };
    });

    // Sort sites: most overdue tasks first, then most total assets
    sites.sort((a: any, b: any) => (b.overdueTasks - a.overdueTasks) || (b.totalAssets - a.totalAssets));

    const totalShutdownsAvoided = sites.reduce((n: number, s: any) => n + s.shutdownsAvoided, 0);

    return res.json({
      success: true,
      data: { sites, totalShutdownsAvoided, generatedAt: now.toISOString() },
    });
  } catch (err) {
    console.error('[outagePlanner GET /summary]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/outage-planner/work-order ───────────────────────────────────────
// Create a single consolidated work order covering multiple assets across a
// site. Body: { siteId, scheduledDate, notes?, assetSchedules: [{assetId, scheduleIds}] }

router.post('/work-order', requireManager, async (req, res) => {
  try {
    const { siteId, scheduledDate, notes, assetSchedules } = req.body;
    const accountId = req.user.accountId;

    if (!scheduledDate)    return res.status(400).json({ success: false, error: 'scheduledDate required' });
    if (!Array.isArray(assetSchedules) || assetSchedules.length === 0) {
      return res.status(400).json({ success: false, error: 'assetSchedules required (array of {assetId, scheduleIds})' });
    }

    const date = new Date(scheduledDate);
    if (isNaN(date.getTime())) return res.status(400).json({ success: false, error: 'Invalid scheduledDate' });

    // Verify all assets belong to this account
    const assetIds = assetSchedules.map((a: any) => String(a.assetId));
    const assets   = await prisma.asset.findMany({
      where:  { id: { in: assetIds }, accountId, archivedAt: null },
      select: { id: true },
    });
    if (assets.length !== assetIds.length) {
      return res.status(400).json({ success: false, error: 'One or more assets not found in this account' });
    }

    // Create one work order per asset (each WO links to a schedule if possible)
    const created = [];
    for (const { assetId, scheduleIds } of assetSchedules) {
      const primaryScheduleId = Array.isArray(scheduleIds) && scheduleIds.length > 0
        ? scheduleIds[0] : null;

      const wo = await prisma.workOrder.create({
        data: {
          accountId,
          assetId: String(assetId),
          scheduleId: primaryScheduleId ? String(primaryScheduleId) : null,
          scheduledDate: date,
          notes: notes
            ? `[Outage consolidation — ${assetSchedules.length} asset(s)] ${notes}`
            : `Outage consolidation — ${assetSchedules.length} asset(s) in one planned outage`,
          status: 'SCHEDULED',
        },
        select: { id: true, assetId: true, scheduledDate: true },
      });
      created.push(wo);
    }

    return res.status(201).json({
      success: true,
      data: { workOrders: created, count: created.length },
    });
  } catch (err) {
    console.error('[outagePlanner POST /work-order]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
