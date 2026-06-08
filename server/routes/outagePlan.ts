/**
 * /api/outage-plan — Outage Consolidation Planner.
 *
 * "No competitor does this."
 *
 * For a given asset (or feeder), finds every maintenance task that is due
 * within ±90 days, groups them by the power-path they share (all assets fed
 * from the same source go dark together in one outage), and proposes a single
 * consolidated outage window that covers all of them — eliminating N-1
 * separate shutdowns.
 *
 * The planner also shows:
 *   - downstream topology: what ELSE goes dark when this feeder trips
 *   - savings estimate: shutdowns avoided, mobilisation trips avoided
 *   - candidate outage windows: pulled from the site's BlackoutWindow table
 *     where isOutageWindow=true and the window is upcoming
 *
 * Mounted at /api/assets/:assetId/outage-plan (see index.ts).
 * Every query filters accountId = req.user.accountId (IDOR).
 */

const router = require('express').Router({ mergeParams: true });
const { requireManager } = require('../middleware/roles');
const prisma  = require('../lib/prisma').default;

const WINDOW_DAYS = 90; // task-clustering lookahead/lookbehind

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a display label for an asset — mirrors client/src/lib/equipment.js assetLabel(). */
function assetLabel(a: { manufacturer?: string|null, model?: string|null, serialNumber?: string|null, equipmentType?: string|null }): string {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType ?? 'Asset');
}

/** Derive a schedule status from nextDueDate (MaintenanceSchedule has no status field). */
function computeStatus(nextDueDate: Date | null | undefined): 'overdue' | 'due' | 'pending' {
  if (!nextDueDate) return 'pending';
  const now = new Date();
  const daysUntil = (new Date(nextDueDate).getTime() - now.getTime()) / 86400000;
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 30) return 'due';
  return 'pending';
}

// ── Walk the feed graph downward from a root asset ─────────────────────────
// Returns the flat set of all asset IDs reachable via feedsDownstream (BFS).
async function getDownstreamIds(rootId: string, accountId: string): Promise<string[]> {
  const visited = new Set<string>();
  const queue   = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const children = await prisma.asset.findMany({
      where:  { fedFromAssetId: current, accountId },
      select: { id: true },
    });
    for (const c of children) queue.push(c.id);
  }

  visited.delete(rootId); // caller handles root separately
  return [...visited];
}

// ── GET /api/assets/:assetId/outage-plan ──────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;

    // 1. Verify asset ownership
    const rootAsset = await prisma.asset.findFirst({
      where: { id: assetId, accountId },
      select: {
        id: true, manufacturer: true, model: true, serialNumber: true,
        equipmentType: true, criticalityScore: true,
        siteId:         true,
        fedFromAssetId: true,
        site:           { select: { id: true, name: true } },
        // "feedsDownstream" is the Prisma relation name (PowerPath children)
        feedsDownstream: { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                     equipmentType: true, criticalityScore: true } },
        // "fedFrom" is the Prisma relation name for the upstream source
        fedFrom:         { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                     equipmentType: true } },
      },
    });
    if (!rootAsset) return res.status(404).json({ success: false, error: 'Asset not found' });

    // 2. Build downstream topology (BFS)
    const downstreamIds  = await getDownstreamIds(assetId, accountId);
    const allAffectedIds = [assetId, ...downstreamIds];

    const downstreamAssets = downstreamIds.length > 0
      ? await prisma.asset.findMany({
          where:  { id: { in: downstreamIds }, accountId },
          select: { id: true, manufacturer: true, model: true, serialNumber: true,
                    equipmentType: true, criticalityScore: true,
                    site: { select: { name: true } } },
        })
      : [];

    // 3. Find all maintenance schedules due within ±WINDOW_DAYS for affected assets.
    //    MaintenanceSchedule has no "status" field — filter by nextDueDate range only;
    //    status (overdue/due/pending) is computed below.
    const now  = new Date();
    const from = new Date(now); from.setDate(from.getDate() - WINDOW_DAYS);
    const to   = new Date(now); to.setDate(to.getDate()   + WINDOW_DAYS);

    const schedules = await prisma.maintenanceSchedule.findMany({
      where: {
        accountId,
        assetId:        { in: allAffectedIds },
        isActive:       true,
        nextDueDate:    { gte: from, lte: to }, // "dueDate" doesn't exist; field is nextDueDate
        taskDefinition: { requiresOutage: true },
      },
      include: {
        asset:          { select: { id: true, manufacturer: true, model: true, serialNumber: true,
                                    equipmentType: true, criticalityScore: true } },
        taskDefinition: { select: { id: true, taskName: true, requiresOutage: true,
                                    intervalC2Months: true, standardRef: true } },
      },
      orderBy: { nextDueDate: 'asc' },
    });

    // 4. Also grab all active schedules on the root asset in the window for context
    const allRootSchedules = await prisma.maintenanceSchedule.findMany({
      where:   { accountId, assetId, isActive: true, nextDueDate: { gte: from, lte: to } },
      include: { taskDefinition: { select: { taskName: true, requiresOutage: true } } },
      orderBy: { nextDueDate: 'asc' },
    });

    // 5. Group outage tasks by asset
    type ScheduleRow = typeof schedules[number];
    const byAsset: Record<string, ScheduleRow[]> = {};
    for (const s of schedules) {
      if (!byAsset[s.assetId]) byAsset[s.assetId] = [];
      byAsset[s.assetId].push(s);
    }

    // 6. Calculate savings
    //    Without consolidation: each task that requires an outage is a separate shutdown.
    //    With consolidation:    one outage covers them all.
    const totalOutageTasks    = schedules.length;
    const shutdownsWithout    = totalOutageTasks;             // naive: one per task
    const shutdownsWith       = totalOutageTasks > 0 ? 1 : 0; // consolidated
    const shutdownsAvoided    = Math.max(0, shutdownsWithout - shutdownsWith);
    const totalEstimatedHours = 0; // estimatedDurationHours not yet on task definitions

    // 7. Suggested outage window: earliest overdue/due task, or earliest upcoming
    const urgentTask    = schedules.find((s: any) => s.nextDueDate && new Date(s.nextDueDate) <= now);
    const windowTarget  = urgentTask?.nextDueDate ?? schedules[0]?.nextDueDate ?? null;

    // 8. Pull existing outage windows from the site calendar
    const existingOutageWindows = await prisma.blackoutWindow.findMany({
      where: {
        accountId,
        siteId:         rootAsset.siteId,
        isOutageWindow: true,
        startsAt:       { gte: now },
      },
      orderBy: { startsAt: 'asc' },
      take: 5,
    });

    return res.json({
      success: true,
      data: {
        rootAsset: {
          id:            rootAsset.id,
          name:          assetLabel(rootAsset),
          equipmentType: rootAsset.equipmentType,
          criticalityScore: rootAsset.criticalityScore,
          site:          rootAsset.site,
          fedFrom:       rootAsset.fedFrom ? {
            id:   rootAsset.fedFrom.id,
            name: assetLabel(rootAsset.fedFrom),
            type: rootAsset.fedFrom.equipmentType,
          } : null,
        },
        downstreamAssets: downstreamAssets.map((a: any) => ({
          id:            a.id,
          name:          assetLabel(a),
          type:          a.equipmentType,
          criticalityScore: a.criticalityScore,
          site:          a.site?.name,
        })),
        allAffectedCount: allAffectedIds.length,
        outageTasks: schedules.map((s: any) => ({
          id:             s.id,
          assetId:        s.assetId,
          assetName:      assetLabel(s.asset),
          taskName:       s.taskDefinition?.taskName,
          standardRef:    s.taskDefinition?.standardRef,
          nextDueDate:    s.nextDueDate,
          dueDate:        s.nextDueDate, // alias for client compat
          status:         computeStatus(s.nextDueDate),
          estimatedHours: null,
        })),
        allRootTasks: allRootSchedules.map((s: any) => ({
          id:             s.id,
          taskName:       s.taskDefinition?.taskName,
          requiresOutage: s.taskDefinition?.requiresOutage ?? false,
          nextDueDate:    s.nextDueDate,
          dueDate:        s.nextDueDate, // alias for client compat
          status:         computeStatus(s.nextDueDate),
          estimatedHours: null,
        })),
        tasksByAsset: Object.fromEntries(
          Object.entries(byAsset).map(([aId, tasks]) => [
            aId,
            (tasks as ScheduleRow[]).map((t: any) => ({
              id:          t.id,
              taskName:    t.taskDefinition?.taskName,
              nextDueDate: t.nextDueDate,
              dueDate:     t.nextDueDate,
              status:      computeStatus(t.nextDueDate),
            })),
          ])
        ),
        savings: {
          shutdownsWithout,
          shutdownsWith,
          shutdownsAvoided,
          totalEstimatedHours,
          windowDays: WINDOW_DAYS,
        },
        suggestedWindowTarget: windowTarget,
        existingOutageWindows: existingOutageWindows.map((w: any) => ({
          id:       w.id,
          startsAt: w.startsAt,
          endsAt:   w.endsAt,
          reason:   w.reason,
        })),
      },
    });
  } catch (err) {
    console.error('[outagePlan GET]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/assets/:assetId/outage-plan/work-order ──────────────────────
// Generate a consolidated work order for all outage tasks in the plan.
// Body: { scheduledDate, notes, contractorId?, scheduleIds[] }
// Manager+ only — creates a WorkOrder, matching requireManager on
// POST /api/work-orders and the canWrite gate on OutageConsolidationCard.
router.post('/work-order', requireManager, async (req, res) => {
  try {
    const { assetId }    = req.params;
    const accountId      = req.user.accountId;
    const { scheduledDate, notes, contractorId, scheduleIds } = req.body;

    if (!scheduledDate) return res.status(400).json({ success: false, error: 'scheduledDate required' });
    // Validate the date is parseable BEFORE it reaches Prisma — an
    // unparseable string would otherwise create an Invalid Date and surface
    // as a 500 instead of a clean 400 (mirrors POST /api/work-orders).
    const when = new Date(scheduledDate);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid scheduledDate' });
    }
    if (!Array.isArray(scheduleIds) || scheduleIds.length === 0) {
      return res.status(400).json({ success: false, error: 'scheduleIds (array) required' });
    }

    // Verify all schedule IDs belong to this account and are within this asset group
    const allAffectedIds = [assetId, ...(await getDownstreamIds(assetId, accountId))];
    const schedules = await prisma.maintenanceSchedule.findMany({
      where:   { id: { in: scheduleIds }, accountId, assetId: { in: allAffectedIds } },
      include: { taskDefinition: { select: { taskName: true, requiresOutage: true } } },
    });

    if (schedules.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid schedules found for this account/asset group' });
    }

    // IDOR: a contractorId from the request body must belong to this account
    // before it can be pinned to the work order. Without this check a caller
    // could attach another tenant's contractor (mirrors validateContractor in
    // routes/workOrders.ts).
    if (contractorId) {
      const contractor = await prisma.contractor.findFirst({
        where:  { id: contractorId, accountId },
        select: { id: true },
      });
      if (!contractor) {
        return res.status(404).json({ success: false, error: 'Contractor not found' });
      }
    }

    // Build combined task description in notes (WorkOrder has no description field)
    const taskNames = [...new Set(schedules.map((s: any) => s.taskDefinition?.taskName).filter(Boolean))];
    const combinedNotes = `Consolidated Outage Work Order — ${schedules.length} task(s): ${taskNames.join(', ')}` +
      (notes ? `\n\nAdditional notes:\n${notes}` : '');

    // Create a single work order on the root asset
    // WorkOrder status enum: SCHEDULED | IN_PROGRESS | COMPLETE | CANCELLED
    const wo = await prisma.workOrder.create({
      data: {
        accountId,
        assetId,
        status:        'SCHEDULED',
        scheduledDate: when,
        notes:         combinedNotes,
        contractorId:  contractorId || null,
      },
      include: {
        asset:      { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
        contractor: { select: { id: true, name: true } },
      },
    });

    return res.status(201).json({ success: true, data: wo, taskCount: schedules.length });
  } catch (err) {
    console.error('[outagePlan POST /work-order]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
