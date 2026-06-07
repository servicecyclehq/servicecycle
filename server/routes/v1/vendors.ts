/**
 * GET /api/v1/vendors      — paginated vendor list
 * GET /api/v1/vendors/:id  — single vendor detail
 *
 * Auth: API key (req.apiKeyAccountId set by apiKeyAuth middleware)
 * Read-only — no write endpoints in v1.
 *
 * Query params (list):
 *   ?page=1    — 1-based page number (default 1)
 *   ?limit=50  — results per page (max 100, default 50)
 */

const router = require('express').Router();
const { z }  = require('zod');
import prisma from '../../lib/prisma';

// ── Zod query-param schema ────────────────────────────────────────────────────
const ListQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ── Shared select shape ───────────────────────────────────────────────────────
const VENDOR_SELECT: any = {
  id:                   true,
  name:                 true,
  cotermComplexity:     true,
  notes:                true,
  budgetUpliftPercent:  true,
  supportEmail:         true,
  supportPhone:         true,
  supportPortalUrl:     true,
  scorePriceFlexibility: true,
  scoreSupport:         true,
  scoreStrategicValue:  true,
  scoreSatisfaction:    true,
  createdAt:            true,
  updatedAt:            true,
};

// ── GET /api/v1/vendors ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { page, limit } = parsed.data;
  const accountId = req.apiKeyAccountId;

  try {
    const [total, vendors] = await Promise.all([
      prisma.vendor.count({ where: { accountId } }),
      prisma.vendor.findMany({
        where:   { accountId },
        select:  VENDOR_SELECT,
        orderBy: { name: 'asc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
    ]);

    return res.json({
      success: true,
      data: vendors,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[v1/vendors] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/v1/vendors/:id ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid vendor ID format' });
  }

  try {
    const vendor = await prisma.vendor.findFirst({
      where:  { id, accountId: req.apiKeyAccountId },
      select: {
        ...VENDOR_SELECT,
        cotermNotes: true,
        aliases:     true,
        contacts: {
          select: { id: true, name: true, email: true, phone: true, title: true },
        },
        _count: {
          select: { contracts: true },
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    return res.json({ success: true, data: vendor });
  } catch (err) {
    console.error('[v1/vendors] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
