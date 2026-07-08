/**
 * routes/rateCards.ts  manager-guarded CRUD for ACCOUNT-LEVEL ServiceRateCard
 * overrides.
 *
 * GET  /api/rate-cards             effective rates for the account (platform/
 *                                   partner defaults merged with this account's
 *                                   overrides), each tagged with its source.
 * PUT  /api/rate-cards/:type       upsert this account's override for a service
 *                                   line (minDollars/maxDollars, USD).
 * DELETE /api/rate-cards/:type     drop the override, reverting to the default.
 *
 * Writes are strictly scoped to accountId overrides (partnerOrgId stays null) 
 * a customer admin can tune their own benchmark but can never mutate the
 * platform seed or another tenant's pricing. Manager+ only.
 */

const express = require('express');
const router = express.Router();
const { requireManager } = require('../middleware/roles');
import prisma from '../lib/prisma';
const { buildRateResolver, SERVICE_TYPES } = require('../lib/rateResolver');

// GET /api/rate-cards  effective, merged view for the editor.
router.get('/', requireManager, async (req: any, res: any) => {
  try {
    const account = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { partnerOrgId: true },
    });
    const resolver = await buildRateResolver(prisma, {
      accountId: req.user.accountId,
      partnerOrgId: account?.partnerOrgId ?? null,
    });
    const rates = resolver.resolvedAll().map((r: any) => ({
      serviceType: r.serviceType,
      // CFO-8-9: emit EXACT dollars from cents (no rounding). The old
      // Math.round(cents/100) silently mutated any non-whole-dollar rate on a
      // save-without-edit round-trip (e.g. 123450¢ = $1,234.50 → shown $1,235 →
      // saved 123500¢), and disagreed with the PDF/digest formatters that read
      // raw cents. minCents/maxCents are CENTS; min/maxDollars are exact USD.
      minDollars: r.minCents / 100,
      maxDollars: r.maxCents / 100,
      source: r.source, // 'account' (override) | 'partner' | 'platform'
    }));
    return res.json({ success: true, data: { rates } });
  } catch (err) {
    console.error('[rate-cards GET]', err);
    return res.status(500).json({ success: false, error: 'Failed to load rate cards' });
  }
});

// PUT /api/rate-cards/:serviceType  upsert the account override.
router.put('/:serviceType', requireManager, async (req: any, res: any) => {
  try {
    const serviceType = String(req.params.serviceType || '').toUpperCase();
    if (!SERVICE_TYPES.includes(serviceType)) {
      return res.status(400).json({ success: false, error: `Unknown service type: ${serviceType}` });
    }
    const minDollars = Number(req.body?.minDollars);
    const maxDollars = Number(req.body?.maxDollars);
    if (!Number.isFinite(minDollars) || !Number.isFinite(maxDollars) || minDollars < 0 || maxDollars < 0) {
      return res.status(400).json({ success: false, error: 'minDollars and maxDollars must be non-negative numbers' });
    }
    if (minDollars > maxDollars) {
      return res.status(400).json({ success: false, error: 'minDollars cannot exceed maxDollars' });
    }
    if (maxDollars > 100_000_000) {
      return res.status(400).json({ success: false, error: 'Rate exceeds the maximum allowed value' });
    }
    const minCents = Math.round(minDollars * 100);
    const maxCents = Math.round(maxDollars * 100);

    // [2026-07-08 audit item 10] ServiceRateCard has NO unique constraint on
    // (accountId, partnerOrgId, serviceType) anywhere in schema.prisma or any
    // migration (verified against live code — the audit assumed one existed
    // and asked for a real Prisma .upsert() on it; it doesn't exist, so that
    // isn't directly possible without a schema migration, which is out of
    // scope for this pass). The prior manual findFirst-then-create/update
    // raced on money-adjacent config: two concurrent saves for the same
    // service type could both read "no existing row" and both insert,
    // leaving a duplicate override with an unpredictable winner downstream.
    // SERIALIZABLE isolation closes that window without a schema change:
    // Postgres aborts one of two overlapping read-then-write transactions on
    // the same row(s) with a serialization failure (Prisma P2034) instead of
    // silently letting both "succeed".
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.serviceRateCard.findFirst({
          where: { accountId: req.user.accountId, partnerOrgId: null, serviceType },
          select: { id: true },
        });
        if (existing) {
          await tx.serviceRateCard.update({ where: { id: existing.id }, data: { minCents, maxCents } });
        } else {
          await tx.serviceRateCard.create({
            data: { accountId: req.user.accountId, partnerOrgId: null, serviceType, minCents, maxCents },
          });
        }
      }, { isolationLevel: 'Serializable' });
    } catch (txErr: any) {
      if (txErr?.code === 'P2034') {
        return res.status(409).json({ success: false, error: 'This rate card was just updated by another request — please retry.' });
      }
      throw txErr;
    }

    try {
      const { writeLog } = require('../lib/activityLog');
      writeLog({
        userId: req.user.id,
        action: 'rate_card_changed',
        details: { serviceType, minCents, maxCents },
      });
    } catch (logErr) { console.error('activity log error (rate_card_changed):', logErr); }

    return res.json({ success: true, data: { serviceType, minDollars, maxDollars, source: 'account' } });
  } catch (err) {
    console.error('[rate-cards PUT]', err);
    return res.status(500).json({ success: false, error: 'Failed to save rate card' });
  }
});

// DELETE /api/rate-cards/:serviceType  revert to default by dropping override.
router.delete('/:serviceType', requireManager, async (req: any, res: any) => {
  try {
    const serviceType = String(req.params.serviceType || '').toUpperCase();
    if (!SERVICE_TYPES.includes(serviceType)) {
      return res.status(400).json({ success: false, error: `Unknown service type: ${serviceType}` });
    }
    await prisma.serviceRateCard.deleteMany({
      where: { accountId: req.user.accountId, partnerOrgId: null, serviceType },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[rate-cards DELETE]', err);
    return res.status(500).json({ success: false, error: 'Failed to delete rate card override' });
  }
});

module.exports = router;
export {};
