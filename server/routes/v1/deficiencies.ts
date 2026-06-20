/**
 * GET /api/v1/deficiencies      -- paginated list, filterable
 * GET /api/v1/deficiencies/:id  -- single deficiency detail
 *
 * Auth: API key (read; any valid key). Account-scoped. Read-only -- deficiencies
 * are created from inspections/work, not pushed by integrators.
 *
 * Query (list): ?page= ?limit= ?severity=IMMEDIATE|RECOMMENDED|ADVISORY
 *               ?assetId=<uuid> ?status=open|resolved
 */

const router = require('express').Router();
const { z } = require('zod');
import prisma from '../../lib/prisma';

const UUID = /^[0-9a-f-]{36}$/i;

const DEF_SELECT: any = {
  id: true, assetId: true, workOrderId: true, severity: true,
  description: true, correctiveAction: true, resolvedAt: true,
  createdAt: true, updatedAt: true,
  asset: { select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, site: { select: { id: true, name: true } } } },
};

const ListQuerySchema = z.object({
  page:  z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  severity: z.enum(['IMMEDIATE', 'RECOMMENDED', 'ADVISORY']).optional(),
  assetId: z.string().regex(UUID).optional(),
  status: z.enum(['open', 'resolved']).optional(),
});

router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors });
  }
  const { page, limit, severity, assetId, status } = parsed.data;
  const where: any = { accountId: req.apiKeyAccountId };
  if (severity) where.severity = severity;
  if (assetId) where.assetId = assetId;
  if (status === 'open') where.resolvedAt = null;
  if (status === 'resolved') where.resolvedAt = { not: null };

  try {
    const [total, deficiencies] = await Promise.all([
      prisma.deficiency.count({ where }),
      prisma.deficiency.findMany({ where, select: DEF_SELECT, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
    ]);
    return res.json({ success: true, data: deficiencies, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('[v1/deficiencies] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Invalid deficiency ID format' });
  try {
    const def = await prisma.deficiency.findFirst({ where: { id, accountId: req.apiKeyAccountId }, select: DEF_SELECT });
    if (!def) return res.status(404).json({ success: false, error: 'Deficiency not found' });
    return res.json({ success: true, data: def });
  } catch (err) {
    console.error('[v1/deficiencies] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
