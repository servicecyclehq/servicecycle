/**
 * GET  /api/v1/work-orders       -- paginated list, filterable
 * GET  /api/v1/work-orders/:id   -- single work-order detail
 * POST /api/v1/work-orders       -- create a work order (bi-directional write;
 *                                   requires the 'write' scope + supports
 *                                   Idempotency-Key). When status=COMPLETE and a
 *                                   scheduleId is given, the originating NFPA 70B
 *                                   schedule is rolled forward -- closing the
 *                                   CMMS loop (a PM done in MaintainX/Salesforce
 *                                   advances the next-due date here).
 *
 * Auth: API key (apiKeyAuth sets req.apiKeyAccountId + req.apiKeyScopes).
 * Reads are open to any valid key; the write requires requireScope('write').
 */

const router = require('express').Router();
const { z } = require('zod');
import prisma from '../../lib/prisma';
const { requireScope } = require('../../middleware/apiKeyAuth');
const { recomputeScheduleDates } = require('../../lib/maintenanceInterval');
const { normalizeKey, findStored, store } = require('../../lib/apiIdempotency');

const UUID = /^[0-9a-f-]{36}$/i;
const WRITE_STATUSES = ['SCHEDULED', 'COMPLETE'];

const WO_SELECT: any = {
  id: true, assetId: true, scheduleId: true, quoteRequestId: true,
  status: true, scheduledDate: true, startedAt: true, completedDate: true,
  asFoundCondition: true, asLeftCondition: true, netaDecal: true,
  isAcceptanceTest: true, notes: true, createdAt: true, updatedAt: true,
  asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
};

const ListQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED']).optional(),
  assetId: z.string().regex(UUID).optional(),
  completedAfter: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
});

const CreateSchema = z.object({
  assetId:       z.string().regex(UUID),
  scheduleId:    z.string().regex(UUID).optional(),
  status:        z.enum(WRITE_STATUSES as any).default('COMPLETE'),
  completedDate: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  scheduledDate: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  asLeftCondition: z.enum(['C1', 'C2', 'C3']).optional(),
  netaDecal:     z.enum(['GREEN', 'YELLOW', 'RED']).optional(),
  notes:         z.string().max(5000).optional(),
});

// ── GET /api/v1/work-orders ───────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
  }
  const { page, limit, status, assetId, completedAfter } = parsed.data;
  const where: any = { accountId: req.apiKeyAccountId };
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  if (completedAfter) where.completedDate = { gte: new Date(completedAfter) };

  try {
    const [total, workOrders] = await Promise.all([
      prisma.workOrder.count({ where }),
      prisma.workOrder.findMany({ where, select: WO_SELECT, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    ]);
    return res.json({ success: true, data: workOrders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('[v1/work-orders] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/v1/work-orders/:id ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Invalid work order ID format' });
  try {
    const wo = await prisma.workOrder.findFirst({
      where: { id, accountId: req.apiKeyAccountId },
      select: { ...WO_SELECT, schedule: { select: { id: true, nextDueDate: true, lastCompletedDate: true, taskDefinition: { select: { taskName: true, taskCode: true, standardRef: true } } } } },
    });
    if (!wo) return res.status(404).json({ success: false, error: 'Work order not found' });
    return res.json({ success: true, data: wo });
  } catch (err) {
    console.error('[v1/work-orders] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/v1/work-orders (write; requires 'write' scope) ──────────────────
router.post('/', requireScope('write'), async (req, res) => {
  const accountId = req.apiKeyAccountId;
  const idemKey = normalizeKey(req);

  // Idempotent replay: a retried request returns the original response verbatim.
  // [2026-07-08 audit item 7] method+path now passed so a key reused against a
  // different endpoint gets a 409, not this endpoint's stored response.
  if (idemKey) {
    const prior = await findStored(prisma, accountId, idemKey, 'POST', '/api/v1/work-orders');
    if (prior) {
      res.set('Idempotent-Replay', 'true');
      return res.status(prior.statusCode).json(prior.responseBody);
    }
  }

  const parsed = CreateSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  }
  const body = parsed.data;

  try {
    // Asset must belong to the key's account and be live.
    const asset = await prisma.asset.findFirst({
      where: { id: body.assetId, accountId, archivedAt: null },
      select: { id: true, conditionPhysical: true, conditionCriticality: true, conditionEnvironment: true, governingCondition: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    // Optional schedule: must belong to the same account + asset and be active.
    let schedule: any = null;
    if (body.scheduleId) {
      schedule = await prisma.maintenanceSchedule.findFirst({
        where: { id: body.scheduleId, accountId, assetId: body.assetId, isActive: true },
        include: { taskDefinition: true },
      });
      if (!schedule) return res.status(404).json({ success: false, error: 'Active maintenance schedule not found for this asset' });
    }

    const isComplete = body.status === 'COMPLETE';
    const completedAt = isComplete ? (body.completedDate ? new Date(body.completedDate) : new Date()) : null;
    if (completedAt && Number.isNaN(completedAt.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid completedDate' });
    }

    // Roll the originating schedule forward on completion (the closed loop).
    const rolled = (isComplete && schedule)
      ? recomputeScheduleDates(schedule.taskDefinition, asset, schedule, completedAt)
      : null;

    const woData: any = {
      accountId,
      assetId: body.assetId,
      scheduleId: body.scheduleId || null,
      status: body.status,
      notes: body.notes || null,
      ...(body.netaDecal ? { netaDecal: body.netaDecal } : {}),
      ...(body.asLeftCondition ? { asLeftCondition: body.asLeftCondition } : {}),
      ...(isComplete ? { completedDate: completedAt, startedAt: completedAt } : {}),
      ...(body.scheduledDate ? { scheduledDate: new Date(body.scheduledDate) } : {}),
    };

    const workOrder = await prisma.$transaction(async (tx: any) => {
      const created = await tx.workOrder.create({ data: woData, select: WO_SELECT });
      if (rolled && schedule) {
        await tx.maintenanceSchedule.update({
          where: { id: schedule.id },
          data: { lastCompletedDate: rolled.lastCompletedDate, nextDueDate: rolled.nextDueDate, lastPerformedByName: `API: ${req.apiKey?.name || 'integration'}`.slice(0, 200) },
        });
      }
      return created;
    });

    const responseBody = { success: true, data: workOrder };
    await store(prisma, { accountId, key: idemKey, method: 'POST', path: '/api/v1/work-orders', statusCode: 201, body: responseBody });
    return res.status(201).json(responseBody);
  } catch (err) {
    console.error('[v1/work-orders] create error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
