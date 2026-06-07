/**
 * GET /api/v1/contractors      — paginated contractor list
 * GET /api/v1/contractors/:id  — single contractor detail
 *
 * NETA testing contractors — the companies that perform the maintenance and
 * testing work tracked by ServiceCycle. The detail view includes field techs
 * (with their ANSI/NETA ETT certification levels) so an integrator can build
 * assignment tooling against the same data the work-order routes validate.
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
const CONTRACTOR_SELECT: any = {
  id:                true,
  name:              true,
  netaAccredited:    true,
  notes:             true,
  supportEmail:      true,
  supportPhone:      true,
  supportPortalUrl:  true,
  portalUrl:         true,
  scoreSupport:      true,
  scoreSatisfaction: true,
  createdAt:         true,
  updatedAt:         true,
};

// ── GET /api/v1/contractors ───────────────────────────────────────────────────
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
    const [total, contractors] = await Promise.all([
      prisma.contractor.count({ where: { accountId } }),
      prisma.contractor.findMany({
        where:   { accountId },
        select:  CONTRACTOR_SELECT,
        orderBy: { name: 'asc' },
        skip:    (page - 1) * limit,
        take:    limit,
      }),
    ]);

    return res.json({
      success: true,
      data: contractors,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[v1/contractors] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/v1/contractors/:id ───────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid contractor ID format' });
  }

  try {
    const contractor = await prisma.contractor.findFirst({
      where:  { id, accountId: req.apiKeyAccountId },
      select: {
        ...CONTRACTOR_SELECT,
        aliases: true,
        techs: {
          select: { id: true, name: true, email: true, phone: true, title: true, netaCertLevel: true },
          orderBy: { name: 'asc' },
        },
        _count: {
          select: { workOrders: true },
        },
      },
    });

    if (!contractor) {
      return res.status(404).json({ success: false, error: 'Contractor not found' });
    }

    return res.json({ success: true, data: contractor });
  } catch (err) {
    console.error('[v1/contractors] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
