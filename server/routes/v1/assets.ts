/**
 * GET /api/v1/assets      — paginated list, filterable
 * GET /api/v1/assets/:id  — single asset detail
 *
 * Auth: API key (req.apiKeyAccountId set by apiKeyAuth middleware)
 * Read-only — no write endpoints in v1.
 *
 * Query params (list):
 *   ?page=1               — 1-based page number (default 1)
 *   ?limit=50             — results per page (max 100, default 50)
 *   ?equipmentType=       — filter by EquipmentType enum value
 *   ?siteId=<uuid>        — narrow to one site
 *   ?governingCondition=  — C1 | C2 | C3 (NFPA 70B governing rating)
 *   ?inService=true|false
 *   ?dueBefore=           — ISO 8601 date; returns assets with at least one
 *                           active maintenance schedule due on/before it
 *                           (the CMMS-integration "what's coming due" pull)
 */

const router = require('express').Router();
const { z }  = require('zod');
import prisma from '../../lib/prisma';

// ── Zod query-param schema ────────────────────────────────────────────────────
// All filters are enum / uuid / date shaped — no free-text search on v1
// assets, so there's no LIKE-wildcard surface to sanitise here.
const ListQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  equipmentType: z.enum([
    'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'GENERATOR',
    'MOTOR', 'MCC', 'UPS_BATTERY', 'CIRCUIT_BREAKER', 'ARC_FLASH_PANEL',
    'VFD', 'FIRE_PUMP_CONTROLLER',
  ]).optional(),
  siteId:             z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  governingCondition: z.enum(['C1', 'C2', 'C3']).optional(),
  inService:          z.enum(['true', 'false']).optional(),
  dueBefore: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()), // accept YYYY-MM-DD too
});

// ── Shared select shape ───────────────────────────────────────────────────────
// Enough to be useful to an integrator (identity + condition + hierarchy
// placement) without internal IDs the caller doesn't need or AI-derived
// fields — the v1 surface is plain equipment data only.
const ASSET_SELECT: any = {
  id:                   true,
  equipmentType:        true,
  manufacturer:         true,
  model:                true,
  serialNumber:         true,
  installDate:          true,
  lastCommissionedDate: true,
  conditionPhysical:    true,
  conditionCriticality: true,
  conditionEnvironment: true,
  governingCondition:   true,
  inService:            true,
  isEnergized:          true,
  notes:                true,
  createdAt:            true,
  updatedAt:            true,
  site: {
    select: { id: true, name: true },
  },
  position: {
    select: { id: true, name: true, code: true },
  },
};

// ── GET /api/v1/assets ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { page, limit, equipmentType, siteId, governingCondition, inService, dueBefore } = parsed.data;
  const accountId = req.apiKeyAccountId;

  // Build where clause
  const where: any = {
    accountId,
    archivedAt: null, // never expose archived assets via the API
  };
  if (equipmentType)      where.equipmentType = equipmentType;
  if (siteId)             where.siteId = siteId;
  if (governingCondition) where.governingCondition = governingCondition;
  if (inService)          where.inService = inService === 'true';
  if (dueBefore) {
    // "Due before" lives on the schedule rows, not the asset — match any
    // asset with at least one active schedule whose nextDueDate is on or
    // before the cutoff (Prisma emits an EXISTS subquery; the
    // (accountId, nextDueDate) index keeps it cheap).
    where.schedules = {
      some: {
        isActive:    true,
        nextDueDate: { lte: new Date(dueBefore) },
      },
    };
  }

  try {
    const [total, assets] = await Promise.all([
      prisma.asset.count({ where }),
      prisma.asset.findMany({
        where,
        select:  ASSET_SELECT,
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
    ]);

    return res.json({
      success: true,
      data: assets,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[v1/assets] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/v1/assets/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  // Basic UUID shape check before hitting the DB
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid asset ID format' });
  }

  try {
    const asset = await prisma.asset.findFirst({
      where:  { id, accountId: req.apiKeyAccountId, archivedAt: null },
      select: {
        ...ASSET_SELECT,
        // Extra detail fields for single-resource view
        nameplateData: true,
        building: {
          select: { id: true, name: true },
        },
        area: {
          select: { id: true, name: true },
        },
        // Active schedules with the task identity + the dates an
        // integrator needs to sync a CMMS calendar.
        schedules: {
          where:  { isActive: true },
          select: {
            id:                true,
            lastCompletedDate: true,
            nextDueDate:       true,
            taskDefinition: {
              select: { taskName: true, taskCode: true, standardRef: true },
            },
          },
          orderBy: { nextDueDate: 'asc' },
        },
        _count: {
          select: {
            workOrders:   true,
            deficiencies: { where: { resolvedAt: null } },
          },
        },
      },
    });

    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    return res.json({ success: true, data: asset });
  } catch (err) {
    console.error('[v1/assets] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
