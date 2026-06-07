/**
 * GET /api/v1/contracts      — paginated list, filterable
 * GET /api/v1/contracts/:id  — single contract detail
 *
 * Auth: API key (req.apiKeyAccountId set by apiKeyAuth middleware)
 * Read-only — no write endpoints in v1.
 *
 * Query params (list):
 *   ?page=1          — 1-based page number (default 1)
 *   ?limit=50        — results per page (max 100, default 50)
 *   ?status=active   — filter by ContractStatus enum value
 *   ?vendor=<name>   — case-insensitive substring match on vendor name
 *   ?renewalBefore=  — ISO 8601 date; returns contracts where endDate <= value
 */

const router = require('express').Router();
const { z }  = require('zod');
import prisma from '../../lib/prisma';
const { sanitiseLikeValue } = require('../../lib/safeSearch'); // v0.37.1 W5 MT-131

// ── Zod query-param schema ────────────────────────────────────────────────────
// vendor cap tightened from 200 -> 80 chars per MT-131 (vendor names don't
// legitimately exceed this and the previous cap let pathological inputs
// through). sanitiseLikeValue also strips % / _ wildcards downstream.
const ListQuerySchema = z.object({
  page:          z.coerce.number().int().positive().default(1),
  limit:         z.coerce.number().int().min(1).max(100).default(50),
  status:        z.enum(['active', 'under_review', 'renewed', 'cancelled', 'expired']).optional(),
  vendor:        z.string().max(80).optional(),
  renewalBefore: z.string().datetime({ offset: true }).optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()), // accept YYYY-MM-DD too
});

// ── Shared select shape ───────────────────────────────────────────────────────
// Return enough fields to be useful without exposing internal IDs the caller
// doesn't need (e.g. evaluationStartedById) or large text blobs (renewalBrief).
const CONTRACT_SELECT: any = {
  id:              true,
  contractNumber:  true,
  product:         true,
  status:          true,
  startDate:       true,
  endDate:         true,
  autoRenewal:     true,
  autoRenewalNoticeDays: true,
  cancelByDate:    true,
  quantity:        true,
  costPerLicense:  true,
  totalValue:      true,
  poNumber:        true,
  department:      true,
  team:            true,
  notes:           true,
  coTermGroup:     true,
  createdAt:       true,
  updatedAt:       true,
  vendor: {
    select: { id: true, name: true },
  },
  category: {
    select: { id: true, name: true, slug: true },
  },
};

// ── GET /api/v1/contracts ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'Invalid query parameters',
      details: parsed.error.flatten().fieldErrors,
    });
  }

  const { page, limit, status, vendor, renewalBefore } = parsed.data;
  const accountId = req.apiKeyAccountId;

  // Build where clause
  const where: any = {
    accountId,
    archivedAt: null, // never expose archived contracts via the API
  };
  if (status)        where.status = status;
  if (renewalBefore) where.endDate = { lte: new Date(renewalBefore) };
  if (vendor) {
    // v0.37.1 W5 MT-131: sanitise the search value before handing it to
    // Prisma's `contains` filter. Strips % and _ wildcards (which would
    // otherwise translate directly into ILIKE wildcards and let a hostile
    // caller force a deep pattern scan); caps length; trims/collapses
    // whitespace. Returns null on empty/non-string input, in which case
    // we simply skip the vendor filter rather than 400 — the cap on the
    // upstream zod schema already rejects clearly-bad shapes.
    const safe = sanitiseLikeValue(vendor);
    if (safe) {
      where.vendor = { name: { contains: safe, mode: 'insensitive' } };
    }
  }

  try {
    const [total, contracts] = await Promise.all([
      prisma.contract.count({ where }),
      prisma.contract.findMany({
        where,
        select: CONTRACT_SELECT,
        orderBy: { endDate: 'asc' },
        skip:  (page - 1) * limit,
        take:  limit,
      }),
    ]);

    return res.json({
      success: true,
      data: contracts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('[v1/contracts] list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/v1/contracts/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  // Basic UUID shape check before hitting the DB
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid contract ID format' });
  }

  try {
    const contract = await prisma.contract.findFirst({
      where:  { id, accountId: req.apiKeyAccountId, archivedAt: null },
      select: {
        ...CONTRACT_SELECT,
        // Extra detail fields for single-resource view
        customerNumber:        true,
        invoiceNumber:         true,
        requestor:             true,
        deliveryMethod:        true,
        resellerName:          true,
        resellerAccountNumber: true,
        resellerContactName:   true,
        resellerContactEmail:  true,
        signatureStatus:       true,
        signedAt:              true,
        signerName:            true,
        originalAsk:           true,
        finalNegotiatedPrice:  true,
        seatsLicensed:         true,
        seatsActivelyInUse:    true,
        annualUpliftPercent:   true,
        renewalChecklist:      true,
        tags: {
          select: { tag: true },
        },
        flags: {
          select: { flagType: true, description: true },
        },
      },
    });

    if (!contract) {
      return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    return res.json({ success: true, data: contract });
  } catch (err) {
    console.error('[v1/contracts] get error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
