/**
 * /api/schedules — maintenance schedule recurrence records.
 *
 * One MaintenanceSchedule row per (asset, task definition) pairing — the
 * living NFPA 70B recurrence: lastCompletedDate + condition-appropriate
 * interval → nextDueDate. All due-date math lives in lib/maintenanceInterval
 * (pure, unit-testable); this file only validates ownership and persists.
 *
 * Key flows:
 *   POST /            — pair one asset with one task definition
 *   POST /bulk-apply  — "give this asset/site its NFPA 70B task set" in one
 *                       click: creates schedules for every applicable global
 *                       task definition that doesn't already exist
 *   POST /:id/complete — manual completion outside the work-order flow
 *                       (the work-order COMPLETE transition performs the same
 *                       recompute via recomputeScheduleDates)
 *
 * Mounted behind authenticateToken in index.ts. Every query filters
 * accountId = req.user.accountId; cross-tenant ids 404. Task definitions are
 * the one shared resource — global rows (accountId = NULL) are usable by
 * every tenant, account rows only by their owner.
 */

const router = require('express').Router();
const { z } = require('zod');
const { requireManager } = require('../middleware/roles');
const { validateBody, UuidStr, emptyToUndef } = require('../lib/validate');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const {
  effectiveCondition,
  computeNextDueDate,
  recomputeScheduleDates,
} = require('../lib/maintenanceInterval');
const prisma = require('../lib/prisma').default;

// Canonical EquipmentType list (single source of truth in lib/equipmentTypes)
// — guards the bulk-apply filter so a bad string 400s instead of throwing in
// Prisma.
const { EQUIPMENT_TYPES } = require('../lib/equipmentTypes');

// ── zod schemas ──────────────────────────────────────────────────────────────
const ConditionEnum = z.enum(['C1', 'C2', 'C3']);
const DateLike  = z.preprocess(emptyToUndef, z.union([z.string(), z.date()]).nullable().optional());
const LeadDays  = z.preprocess(emptyToUndef,
  z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).nullable().optional());

const CreateScheduleSchema = z.object({
  assetId:                UuidStr,
  taskDefinitionId:       UuidStr,
  leadTimeSchedulingDays: LeadDays,
  leadTimeCustomerDays:   LeadDays,
  conditionOverride:      ConditionEnum.nullable().optional().or(z.literal('')),
  lastCompletedDate:      DateLike,
  notes:                  z.string().max(2000).nullable().optional(),
}).strict();

const BulkApplySchema = z.object({
  assetId:       UuidStr.optional(),
  siteId:        UuidStr.optional(),
  equipmentType: z.enum(EQUIPMENT_TYPES).optional(),
}).strict().refine(d => !!d.assetId || !!d.siteId, {
  message: 'assetId or siteId is required',
  path: ['assetId'],
});

const CompleteSchema = z.object({
  completedDate: DateLike,
  workOrderId:   UuidStr.optional().or(z.literal('')),
  // Provenance for completions recorded outside the work-order flow: who
  // actually performed the task (free text — name + employer). Stored to
  // MaintenanceSchedule.lastPerformedByName.
  performedByName: z.string().max(200).nullable().optional(),
}).strict();

// Shared include for list/detail responses — asset (+site) and the task
// definition the UI needs to label the row.
const scheduleInclude = {
  asset: {
    select: {
      id: true, equipmentType: true, manufacturer: true, model: true,
      serialNumber: true, governingCondition: true, inService: true,
      site: { select: { id: true, name: true } },
    },
  },
  taskDefinition: {
    select: {
      id: true, taskName: true, taskCode: true, equipmentType: true,
      intervalC1Months: true, intervalC2Months: true, intervalC3Months: true,
      requiresOutage: true, requiresEnergized: true, requiresNetaCertified: true,
      netaCertLevelMin: true, standardRef: true,
      standard: { select: { code: true, edition: true } },
    },
  },
};

// ─── GET /api/schedules ───────────────────────────────────────────────────────
// Compliance calendar feed. Filters:
//   assetId        — one asset's task set
//   siteId         — all schedules at a site (via the asset join)
//   dueWithinDays  — nextDueDate within N days from now (includes overdue)
//   overdue=true   — nextDueDate strictly in the past
//   isActive       — 'true' | 'false' (no filter when omitted)
// Default sort: nextDueDate ascending (most urgent first; Postgres puts the
// never-completed null-due rows last).
router.get('/', async (req, res) => {
  try {
    const { assetId, siteId, dueWithinDays, overdue, isActive, page = 1, limit = 50 } = req.query;

    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;

    const where: any = { accountId: req.user.accountId };
    if (assetId) where.assetId = String(assetId);
    if (siteId)  where.asset = { siteId: String(siteId) };
    if (isActive === 'true')  where.isActive = true;
    if (isActive === 'false') where.isActive = false;

    if (overdue === 'true') {
      where.nextDueDate = { lt: new Date() };
    } else if (dueWithinDays !== undefined) {
      const days = parseInt(dueWithinDays);
      if (Number.isNaN(days) || days < 0) {
        return res.status(400).json({ success: false, error: 'dueWithinDays must be a non-negative integer' });
      }
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      // Includes already-overdue rows — "due within 30 days" on the dashboard
      // must surface everything that needs attention, not just the future slice.
      where.nextDueDate = { lte: cutoff };
    }

    const [schedules, total] = await Promise.all([
      prisma.maintenanceSchedule.findMany({
        where,
        include: scheduleInclude,
        orderBy: [{ nextDueDate: 'asc' }],
        skip,
        take,
      }),
      prisma.maintenanceSchedule.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        schedules,
        pagination: { page: pageNum, limit: take, total, pages: Math.ceil(total / take) },
      },
    });
  } catch (err) {
    console.error('List schedules error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch schedules' });
  }
});

// ─── POST /api/schedules ──────────────────────────────────────────────────────
// Pair an asset with a task definition. Three ownership/consistency gates:
//   1. asset must belong to this account
//   2. task definition must be global (accountId NULL) or owned by this account
//   3. task definition's equipmentType must match the asset's — a transformer
//      can't be put on a battery-string discharge test
// nextDueDate is computed from the optional lastCompletedDate anchor; without
// one it stays null until the first completion lands.
router.post('/', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, CreateScheduleSchema);
  if (!parsed) return;
  try {
    const {
      assetId, taskDefinitionId,
      leadTimeSchedulingDays, leadTimeCustomerDays,
      conditionOverride, lastCompletedDate, notes,
    } = parsed;

    const asset = await prisma.asset.findFirst({
      where: { id: assetId, accountId: req.user.accountId },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const taskDef = await prisma.maintenanceTaskDefinition.findFirst({
      where: {
        id: taskDefinitionId,
        archivedAt: null,
        OR: [{ accountId: null }, { accountId: req.user.accountId }],
      },
    });
    if (!taskDef) return res.status(404).json({ success: false, error: 'Task definition not found' });

    if (taskDef.equipmentType !== asset.equipmentType) {
      return res.status(400).json({
        success: false,
        error: `Task definition applies to ${taskDef.equipmentType}, but the asset is ${asset.equipmentType}`,
      });
    }

    const override = conditionOverride || null;
    const condition = effectiveCondition(asset, { conditionOverride: override });
    const anchor = lastCompletedDate ? new Date(lastCompletedDate) : null;
    if (anchor && Number.isNaN(anchor.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid lastCompletedDate' });
    }

    const schedule = await prisma.maintenanceSchedule.create({
      data: {
        accountId:         req.user.accountId,
        assetId:           asset.id,
        taskDefinitionId:  taskDef.id,
        lastCompletedDate: anchor,
        nextDueDate:       computeNextDueDate(anchor, taskDef, condition),
        conditionOverride: override,
        notes:             notes || null,
        ...(leadTimeSchedulingDays != null ? { leadTimeSchedulingDays: parseInt(leadTimeSchedulingDays) } : {}),
        ...(leadTimeCustomerDays   != null ? { leadTimeCustomerDays:   parseInt(leadTimeCustomerDays)   } : {}),
      },
      include: scheduleInclude,
    });

    res.status(201).json({ success: true, data: { schedule } });
  } catch (err) {
    // (assetId, taskDefinitionId) unique — the asset already has this task.
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'This asset already has a schedule for that task' });
    }
    console.error('Create schedule error:', err);
    res.status(500).json({ success: false, error: 'Failed to create schedule' });
  }
});

// ─── POST /api/schedules/bulk-apply ───────────────────────────────────────────
// "Apply the standard NFPA 70B task set" in one click. Body is either
// { assetId } (one asset) or { siteId, equipmentType? } (every non-archived
// asset at the site, optionally narrowed by type). For each target asset,
// creates a schedule for every GLOBAL task definition matching its
// equipmentType. Existing pairings are skipped via the (assetId,
// taskDefinitionId) unique + skipDuplicates, so the operation is idempotent —
// safe to re-run after the seed matrix gains new tasks.
//
// Intentionally global-only: tenant custom tasks are curated per asset via
// POST /, not blanket-applied.
router.post('/bulk-apply', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, BulkApplySchema);
  if (!parsed) return;
  try {
    const { assetId, siteId, equipmentType } = parsed;

    // Resolve target assets — always scoped to the account.
    let assets;
    if (assetId) {
      assets = await prisma.asset.findMany({
        where: { id: assetId, accountId: req.user.accountId },
        select: { id: true, equipmentType: true },
      });
      if (assets.length === 0) {
        return res.status(404).json({ success: false, error: 'Asset not found' });
      }
    } else {
      const site = await prisma.site.findFirst({
        where: { id: siteId, accountId: req.user.accountId },
        select: { id: true },
      });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found' });

      assets = await prisma.asset.findMany({
        where: {
          accountId: req.user.accountId,
          siteId: site.id,
          archivedAt: null,
          ...(equipmentType ? { equipmentType } : {}),
        },
        select: { id: true, equipmentType: true },
      });
    }

    if (assets.length === 0) {
      return res.json({ success: true, data: { created: 0, assetCount: 0 } });
    }

    // Global task matrix rows for the equipment types in play.
    const types = [...new Set(assets.map(a => a.equipmentType))];
    const taskDefs = await prisma.maintenanceTaskDefinition.findMany({
      where: { accountId: null, archivedAt: null, equipmentType: { in: types } },
      select: { id: true, equipmentType: true, intervalC2Months: true },
    });

    const defsByType = new Map();
    for (const d of taskDefs) {
      if (!defsByType.has(d.equipmentType)) defsByType.set(d.equipmentType, []);
      defsByType.get(d.equipmentType).push(d);
    }

    // Evidence-grade baselining (gem V3): applying a program creates the
    // schedules but leaves them UNBASELINED (nextDueDate = null) — we have no
    // proof any maintenance was ever done, so they must NOT read as compliant.
    // Path-to-100 surfaces them as "needs baseline" and the per-schedule
    // baseline action records the REAL last-service date (or marks due-now).
    // Manufacturing a green interval here was "compliance by import."
    const rows = [];
    for (const asset of assets) {
      for (const def of defsByType.get(asset.equipmentType) || []) {
        rows.push({
          accountId:        req.user.accountId,
          assetId:          asset.id,
          taskDefinitionId: def.id,
          // nextDueDate intentionally omitted (null) — unverified until baselined
        });
      }
    }

    if (rows.length === 0) {
      return res.json({ success: true, data: { created: 0, assetCount: assets.length } });
    }

    const result = await prisma.maintenanceSchedule.createMany({
      data: rows,
      skipDuplicates: true, // existing (asset, task) pairings survive untouched
    });

    res.status(201).json({
      success: true,
      data: { created: result.count, assetCount: assets.length },
    });
  } catch (err) {
    console.error('Bulk-apply schedules error:', err);
    res.status(500).json({ success: false, error: 'Failed to apply task definitions' });
  }
});

// ─── PUT /api/schedules/:id ───────────────────────────────────────────────────
// Update lead times / condition override / active flag / notes. A change to
// conditionOverride recomputes nextDueDate against the existing
// lastCompletedDate anchor — flipping a task to C3 treatment pulls its due
// date in immediately, it doesn't wait for the next completion.
router.put('/:id', requireManager, async (req, res) => {
  try {
    const schedule = await prisma.maintenanceSchedule.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: { taskDefinition: true, asset: true },
    });
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    const { leadTimeSchedulingDays, leadTimeCustomerDays, conditionOverride, isActive, notes } = req.body;

    const updateData: any = {};

    if (leadTimeSchedulingDays !== undefined) {
      const n = parseInt(leadTimeSchedulingDays);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({ success: false, error: 'leadTimeSchedulingDays must be a non-negative integer' });
      }
      updateData.leadTimeSchedulingDays = n;
    }
    if (leadTimeCustomerDays !== undefined) {
      const n = parseInt(leadTimeCustomerDays);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({ success: false, error: 'leadTimeCustomerDays must be a non-negative integer' });
      }
      updateData.leadTimeCustomerDays = n;
    }
    if (isActive !== undefined) updateData.isActive = isActive === true || isActive === 'true';
    if (notes !== undefined)    updateData.notes = notes || null;

    if (conditionOverride !== undefined) {
      const override = conditionOverride || null;
      if (override !== null && !['C1', 'C2', 'C3'].includes(override)) {
        return res.status(400).json({ success: false, error: 'conditionOverride must be C1, C2, or C3 (or null to clear)' });
      }
      updateData.conditionOverride = override;
      // Recompute against the NEW effective condition; the anchor doesn't move.
      updateData.nextDueDate = computeNextDueDate(
        schedule.lastCompletedDate,
        schedule.taskDefinition,
        effectiveCondition(schedule.asset, { conditionOverride: override })
      );
    }

    const updated = await prisma.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: updateData,
      include: scheduleInclude,
    });

    res.json({ success: true, data: { schedule: updated } });
  } catch (err) {
    console.error('Update schedule error:', err);
    res.status(500).json({ success: false, error: 'Failed to update schedule' });
  }
});

// ─── POST /api/schedules/:id/complete ─────────────────────────────────────────
// Manual completion — for work performed outside the work-order flow (e.g.
// in-house staff did the visual inspection). Rolls the recurrence forward:
// lastCompletedDate = completedDate (default now), nextDueDate recomputed
// from the asset's CURRENT effective condition via recomputeScheduleDates —
// the same helper the work-order COMPLETE transition uses, so the two paths
// can never drift.
router.post('/:id/complete', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, CompleteSchema);
  if (!parsed) return;
  try {
    const schedule = await prisma.maintenanceSchedule.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: { taskDefinition: true, asset: true },
    });
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    const completedAt = parsed.completedDate ? new Date(parsed.completedDate) : new Date();
    if (Number.isNaN(completedAt.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid completedDate' });
    }

    // Optional link back to the work order that did the work — validated for
    // tenancy so the audit detail can't reference another account's WO.
    let workOrderId = null;
    if (parsed.workOrderId) {
      const wo = await prisma.workOrder.findFirst({
        where: { id: parsed.workOrderId, accountId: req.user.accountId },
        select: { id: true },
      });
      if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });
      workOrderId = wo.id;
    }

    const { lastCompletedDate, nextDueDate } = recomputeScheduleDates(
      schedule.taskDefinition, schedule.asset, schedule, completedAt
    );

    // Provenance — belongs to THIS completion, so it's written every time:
    // a completion without a name clears any stale name from a prior cycle.
    const performedByName =
      typeof parsed.performedByName === 'string' && parsed.performedByName.trim()
        ? parsed.performedByName.trim()
        : null;

    const updated = await prisma.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { lastCompletedDate, nextDueDate, lastPerformedByName: performedByName },
      include: scheduleInclude,
    });

    // Fire-and-forget audit entry — a logging failure never blocks the response.
    writeActivityLog({
      assetId:   schedule.assetId,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'maintenance_completed',
      details: {
        scheduleId:    schedule.id,
        taskCode:      schedule.taskDefinition.taskCode,
        taskName:      schedule.taskDefinition.taskName,
        completedDate: lastCompletedDate,
        nextDueDate,
        workOrderId,
        performedByName,
      },
    });

    res.json({ success: true, data: { schedule: updated } });
  } catch (err) {
    console.error('Complete schedule error:', err);
    res.status(500).json({ success: false, error: 'Failed to complete schedule' });
  }
});

// ── POST /:id/baseline ────────────────────────────────────────────────────────
// Evidence-grade baselining (gem V3). Records the REAL date a task was last
// performed (sets lastCompletedDate + recomputes nextDueDate from it), OR —
// when the user answers "never / unknown" — marks the schedule due-now WITHOUT
// fabricating a completion record. This replaces the old one-click "Mark
// baselined" that silently stamped lastCompletedDate = today for work nobody
// claimed happened. Body: { lastServiceDate?: 'YYYY-MM-DD' | null }.
router.post('/:id/baseline', requireManager, async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const lastServiceDate = req.body ? req.body.lastServiceDate : undefined;

    const schedule = await prisma.maintenanceSchedule.findFirst({
      where: { id: req.params.id, accountId },
      include: { taskDefinition: true, asset: true },
    });
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    if (lastServiceDate) {
      const when = new Date(lastServiceDate);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid lastServiceDate' });
      if (when.getTime() > Date.now()) return res.status(400).json({ success: false, error: 'Last-service date cannot be in the future' });
      const cond = effectiveCondition(schedule.asset, schedule);
      const nextDueDate = computeNextDueDate(when, schedule.taskDefinition, cond);
      const updated = await prisma.maintenanceSchedule.update({
        where: { id: schedule.id },
        data: { lastCompletedDate: when, nextDueDate, lastPerformedByName: (req.user.name || 'Baselined (asserted)') },
        include: scheduleInclude,
      });
      writeActivityLog({
        assetId: schedule.assetId, userId: req.user.id, accountId,
        action: 'schedule_baselined',
        details: { scheduleId: schedule.id, taskCode: schedule.taskDefinition.taskCode, assertedLastService: when, nextDueDate },
      });
      return res.json({ success: true, data: { schedule: updated, baselined: true } });
    }

    // "never / unknown" → genuinely due now; NO fabricated completion record.
    const updated = await prisma.maintenanceSchedule.update({
      where: { id: schedule.id },
      data: { nextDueDate: new Date() },
      include: scheduleInclude,
    });
    return res.json({ success: true, data: { schedule: updated, dueNow: true } });
  } catch (err) {
    console.error('Baseline schedule error:', err);
    res.status(500).json({ success: false, error: 'Failed to baseline schedule' });
  }
});

module.exports = router;

export {};
