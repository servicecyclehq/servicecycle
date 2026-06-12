/**
 * routes/leaveBehind.ts — POST /api/work-orders/:id/leave-behind-pdf
 *
 * Generates the 3-section inspection leave-behind PDF (Task 28):
 *   1. What We Found — deficiencies from this work order
 *   2. What We Fixed — resolved deficiencies
 *   3. What to Budget For — open QuoteRequests + RUL-scored assets >= 0.70
 *
 * Auth: any authenticated user on the account.
 * Also mounted at POST /api/inspections/:id/leave-behind-pdf (alias).
 */

const router = require('express').Router({ mergeParams: true });
import prisma from '../lib/prisma';
import { renderLeaveBehindPdf } from '../lib/leaveBehindPdf';
import { getAccountBranding } from '../lib/partnerBranding';

// Map asset EquipmentType to rate-card service type
function equipToServiceType(equipmentType: string): string {
  const mapping: Record<string, string> = {
    TRANSFORMER_LIQUID:  'TRANSFORMER_REPLACEMENT',
    TRANSFORMER_DRY:     'TRANSFORMER_REPLACEMENT',
    SWITCHGEAR:          'SWITCHGEAR_MODERNIZATION',
    SWITCHBOARD:         'SWITCHGEAR_MODERNIZATION',
    CIRCUIT_BREAKER:     'BREAKER_RETROFIT',
    PROTECTION_RELAY:    'RELAY_UPGRADE',
    MCC:                 'SWITCHGEAR_MODERNIZATION',
    UPS_BATTERY:         'INSPECTION',
    BATTERY_SYSTEM:      'INSPECTION',
    TRANSFER_SWITCH:     'INSPECTION',
  };
  return mapping[equipmentType] ?? 'INSPECTION';
}

router.post('/', async (req: any, res: any) => {
  const { id } = req.params;
  const { accountId } = req.user;

  try {
    // ── Load work order ────────────────────────────────────────────────────
    const wo = await prisma.workOrder.findFirst({
      where: { id, accountId },
      select: {
        id: true,
        scheduledDate: true,
        completedDate: true,
        asset: {
          select: {
            id: true, accountId: true,
            equipmentType: true, manufacturer: true, model: true, serialNumber: true,
            site: { select: { name: true } },
          },
        },
        account: {
          select: { companyName: true, serviceRepName: true, serviceRepPhone: true },
        },
        contractor: { select: { name: true } },
        deficiencies: {
          select: {
            severity: true,
            description: true,
            correctiveAction: true,
            resolvedAt: true,
          },
          orderBy: [
            { severity: 'asc' }, // IMMEDIATE first (alphabetically after RECOMMENDED/ADVISORY)
            { createdAt: 'asc' },
          ],
        },
      },
    });

    if (!wo) return res.status(404).json({ error: 'Work order not found' });

    // Sort deficiencies: IMMEDIATE first, then RECOMMENDED, then ADVISORY
    const severityOrder: Record<string, number> = { IMMEDIATE: 0, RECOMMENDED: 1, ADVISORY: 2 };
    const sortedDefs = [...wo.deficiencies].sort(
      (a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
    );

    // ── Load open QuoteRequests for the account ────────────────────────────
    const openQuotes = await prisma.quoteRequest.findMany({
      where: {
        accountId,
        status: { in: ['requested', 'quoted'] },
      },
      select: {
        triggerType: true,
        notes:       true,
        createdAt:   true,
        asset: {
          select: {
            equipmentType: true, manufacturer: true,
            model: true, serialNumber: true,
          },
        },
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    // ── Load assets with modernizationRiskScore >= 0.70 ───────────────────
    const atRiskAssets = await prisma.asset.findMany({
      where: {
        accountId,
        archivedAt:             null,
        modernizationRiskScore: { gte: 0.70 },
      },
      select: {
        equipmentType:           true,
        manufacturer:            true,
        model:                   true,
        serialNumber:            true,
        modernizationRiskScore:  true,
        site: { select: { name: true } },
      },
      orderBy: { modernizationRiskScore: 'desc' },
      take: 20,
    });

    // Look up rate card for each at-risk asset
    const rateCards = await prisma.serviceRateCard.findMany({
      where: { partnerOrgId: null, accountId: null },
    });
    const rateMap = new Map<string, { minCents: number; maxCents: number }>();
    for (const r of rateCards) rateMap.set(r.serviceType, r);

    const modernizationAssets = atRiskAssets.map((a) => {
      const svcType = equipToServiceType(a.equipmentType);
      const rate    = rateMap.get(svcType);
      return {
        ...a,
        rateMin:         rate?.minCents ?? null,
        rateMax:         rate?.maxCents ?? null,
        rateServiceType: svcType,
      };
    });

    // ── Render PDF ─────────────────────────────────────────────────────────
    const branding = await getAccountBranding(accountId); // #15 co-brand
    const pdfBuffer = await renderLeaveBehindPdf({
      workOrder:           wo as any,
      deficiencies:        sortedDefs,
      openQuoteRequests:   openQuotes as any,
      modernizationAssets,
      branding,
    });

    const filename = `leave-behind-${id.slice(-8).toUpperCase()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);

  } catch (err: any) {
    console.error('[leaveBehind] render failed:', err.message);
    res.status(500).json({ error: 'Failed to generate leave-behind PDF' });
  }
});

module.exports = router;
