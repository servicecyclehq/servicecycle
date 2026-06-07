// ─────────────────────────────────────────────────────────────────────────────
// routes/bootstrap.ts — single round-trip mount bundle (inherited v0.47 perf
// pattern, retargeted to the ServiceCycle equipment model).
//
// Hydrates everything AssetsList needs on first mount: assets page +
// pagination, members list, site lookup, contractor lookup, public account
// settings. Pre-bundling, the list page fired 5-6 sequential mount fetches;
// at CF-edge RTTs that was the slowest-of-six tax on every page refresh.
//
// API contract:
//   GET /api/bootstrap?<same query params as /api/assets>
//   → 200 {
//       success: true,
//       data: {
//         assets:         Asset[],
//         pagination:     { page, limit, total, pages },
//         members:        { id, name }[],
//         sites:          { id, name }[],
//         contractors:    { id, name }[],
//         equipmentTypes: string[],            // enum values for filter dropdowns
//         settings:       { onboardingComplete, passwordMinLength },
//       }
//     }
//
// Auth: mounted with authenticateToken upstream in server/index.ts. No role
// gate — every authenticated user has the same read access to their own
// account's assets that /api/assets grants them.
//
// ⚠ Keep the assets-query logic in SYNC with routes/assets.ts GET /. The
// where/orderBy shapes are intentionally duplicated rather than refactored so
// the list endpoint's behavior cannot regress from a shared-helper rewrite.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
import prisma from '../lib/prisma';

const EQUIPMENT_TYPES = [
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'GENERATOR',
  'MOTOR', 'MCC', 'UPS_BATTERY', 'CIRCUIT_BREAKER', 'ARC_FLASH_PANEL',
  'VFD', 'FIRE_PUMP_CONTROLLER',
];

// ─── GET /api/bootstrap ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const {
      page = 1, limit = 25,
      search, siteId, equipmentType, governingCondition, inService,
      sort = 'createdAt', sortDir = 'desc',
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // ── where (mirrors routes/assets.ts GET /) ────────────────────────────
    const where: any = { accountId: req.user.accountId, archivedAt: null };
    if (siteId)             where.siteId = siteId;
    if (equipmentType && EQUIPMENT_TYPES.includes(String(equipmentType))) {
      where.equipmentType = equipmentType;
    }
    if (governingCondition && ['C1', 'C2', 'C3'].includes(String(governingCondition))) {
      where.governingCondition = governingCondition;
    }
    if (inService === 'true')  where.inService = true;
    if (inService === 'false') where.inService = false;

    if (search) {
      where.OR = [
        { manufacturer: { contains: search, mode: 'insensitive' } },
        { model:        { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { site: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const dir = sortDir === 'desc' ? 'desc' : 'asc';
    const sortMap: any = {
      createdAt:     { createdAt: dir },
      equipmentType: { equipmentType: dir },
      site:          { site: { name: dir } },
      manufacturer:  { manufacturer: { sort: dir, nulls: 'last' } },
      condition:     { governingCondition: dir },
    };
    const orderBy = sortMap[sort] || { createdAt: 'desc' };

    // ── Parallel queries ──────────────────────────────────────────────────
    const [assets, total, members, sites, contractors, settingsRows] = await Promise.all([
      prisma.asset.findMany({
        where, skip, take, orderBy,
        include: {
          site:     { select: { id: true, name: true } },
          position: { select: { id: true, name: true, code: true } },
          // Earliest active schedule drives the "next due" cell in the list.
          schedules: {
            where:   { isActive: true, nextDueDate: { not: null } },
            select:  { nextDueDate: true, taskDefinition: { select: { taskName: true } } },
            orderBy: { nextDueDate: 'asc' },
            take:    1,
          },
          _count: {
            select: {
              deficiencies: { where: { resolvedAt: null } },
              workOrders:   { where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } } },
            },
          },
        },
      }),
      prisma.asset.count({ where }),
      prisma.user.findMany({
        where:   { accountId: req.user.accountId, isActive: true },
        select:  { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.site.findMany({
        where:   { accountId: req.user.accountId, archivedAt: null },
        select:  { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.contractor.findMany({
        where:   { accountId: req.user.accountId },
        select:  { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      prisma.accountSetting.findMany({
        where: {
          accountId: req.user.accountId,
          key:       { in: ['ONBOARDING_COMPLETE', 'PASSWORD_MIN_LENGTH'] },
        },
      }),
    ]);

    const settingsKV: any = {};
    for (const r of settingsRows) settingsKV[r.key] = r.value;
    const settings: any = {
      onboardingComplete: settingsKV['ONBOARDING_COMPLETE'] === 'true',
      passwordMinLength:  parseInt(settingsKV['PASSWORD_MIN_LENGTH'] || '12', 10),
    };

    const { validateResponse } = require('../lib/responseValidator');
    const { bootstrapSchema }  = require('../schemas/api');
    const payload: any = {
      success: true,
      data: {
        assets,
        pagination: {
          page:  parseInt(page),
          limit: take,
          total,
          pages: Math.ceil(total / take),
        },
        members,
        sites,
        contractors,
        equipmentTypes: EQUIPMENT_TYPES,
        settings,
      },
    };
    res.json(validateResponse('/api/bootstrap', bootstrapSchema, payload, req));
  } catch (err) {
    console.error('[bootstrap] failed:', err);
    res.status(500).json({ success: false, error: 'Failed to load bootstrap data' });
  }
});

module.exports = router;

export {};
