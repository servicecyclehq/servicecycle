/**
 * GET /api/v1/reports/upcoming-renewals
 *
 * Returns contracts renewing within the next N days, sorted ascending by endDate.
 * Excludes archived contracts and those with status = 'cancelled' or 'expired'.
 *
 * Auth: API key (req.apiKeyAccountId)
 *
 * Query params:
 *   ?days=90  — look-ahead window in days (default 90, max 730)
 */

const router = require('express').Router();
const { z }  = require('zod');
import prisma from '../../lib/prisma';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(730).default(90),
});

router.get('/upcoming-renewals', async (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { days } = parsed.data;
  const accountId = req.apiKeyAccountId;

  const now     = new Date();
  const cutoff  = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  try {
    // Pass-5 / Agent 3: defensive take(1000) cap. The public REST API
    // returns a JSON array — an unbounded findMany under a wide window
    // (max 730 days) on a large-tenancy account would blow request
    // memory + bandwidth. 1000 fits well within any realistic enterprise
    // contract count for a 2-year renewal horizon; if a caller legitimately
    // needs more they'll page (paging not yet shipped — added to backlog).
    const contracts = await prisma.contract.findMany({
      where: {
        accountId,
        archivedAt: null,
        status: { notIn: ['cancelled', 'expired'] },
        endDate: {
          gte: now,
          lte: cutoff,
        },
      },
      select: {
        id:             true,
        contractNumber: true,
        product:        true,
        status:         true,
        endDate:        true,
        cancelByDate:   true,
        autoRenewal:    true,
        autoRenewalNoticeDays: true,
        totalValue:     true,
        vendor: {
          select: { id: true, name: true },
        },
        category: {
          select: { id: true, name: true, slug: true },
        },
      },
      orderBy: { endDate: 'asc' },
      take: 1000,
    });

    return res.json({
      success: true,
      data: contracts,
      meta: {
        days,
        windowStart: now.toISOString(),
        windowEnd:   cutoff.toISOString(),
        count:       contracts.length,
      },
    });
  } catch (err) {
    console.error('[v1/reports] upcoming-renewals error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
