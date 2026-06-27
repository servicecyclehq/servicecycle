/**
 * leaveBehindData.ts — shared leave-behind PDF builder.
 *
 * Assembles the 3-section leave-behind data (found / fixed / budget-for) for a
 * work order and renders the co-branded PDF. Extracted from routes/leaveBehind
 * so the on-demand download route AND the #16 auto-send-on-completion path use
 * exactly the same document. Returns null if the work order isn't found.
 */

import prisma from './prisma';
import { renderLeaveBehindPdf } from './leaveBehindPdf';
import { getAccountBranding } from './partnerBranding';

// Map asset EquipmentType to rate-card service type.
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

export interface BuiltLeaveBehind {
  pdfBuffer: Buffer;
  workOrder: any;
  filename: string;
}

/** Build the leave-behind PDF for a work order, or null if not found. */
export async function buildLeaveBehindPdf(accountId: string, workOrderId: string): Promise<BuiltLeaveBehind | null> {
  const wo = await prisma.workOrder.findFirst({
    where: { id: workOrderId, accountId },
    select: {
      id: true, scheduledDate: true, completedDate: true,
      // [NETA-8-7] as-left condition + decal for the certification block.
      asLeftCondition: true, netaDecal: true,
      asset: {
        select: {
          id: true, accountId: true,
          equipmentType: true, manufacturer: true, model: true, serialNumber: true,
          site: { select: { name: true } },
        },
      },
      account: { select: { companyName: true, serviceRepName: true, serviceRepPhone: true } },
      // [NETA-8-7] netaAccredited drives the certification line; technician is the
      // assigned ContractorTech or the assigned login user who did the work.
      contractor: { select: { name: true, netaAccredited: true } },
      assignedTech: { select: { name: true } },
      assignedUser: { select: { name: true } },
      deficiencies: {
        select: { severity: true, description: true, correctiveAction: true, resolvedAt: true },
        orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  if (!wo) return null;

  // [NETA-8-7] Prefer the named field tech (ContractorTech), then the assigned
  // login user; null when neither is recorded (the signature line still prints).
  const technicianName = (wo as any).assignedTech?.name || (wo as any).assignedUser?.name || null;

  const severityOrder: Record<string, number> = { IMMEDIATE: 0, RECOMMENDED: 1, ADVISORY: 2 };
  const sortedDefs = [...wo.deficiencies].sort(
    (a: any, b: any) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99),
  );

  const openQuotes = await prisma.quoteRequest.findMany({
    where: { accountId, status: { in: ['requested', 'quoted'] } },
    select: {
      triggerType: true, notes: true, createdAt: true,
      asset: { select: { equipmentType: true, manufacturer: true, model: true, serialNumber: true } },
    },
    take: 20, orderBy: { createdAt: 'desc' },
  });

  const atRiskAssets = await prisma.asset.findMany({
    where: { accountId, archivedAt: null, modernizationRiskScore: { gte: 0.70 } },
    select: {
      equipmentType: true, manufacturer: true, model: true, serialNumber: true,
      modernizationRiskScore: true, site: { select: { name: true } },
    },
    orderBy: { modernizationRiskScore: 'desc' }, take: 20,
  });

  const rateCards = await prisma.serviceRateCard.findMany({ where: { partnerOrgId: null, accountId: null } });
  const rateMap = new Map<string, { minCents: number; maxCents: number }>();
  for (const r of rateCards as any[]) rateMap.set(r.serviceType, r);

  const modernizationAssets = atRiskAssets.map((a: any) => {
    const svcType = equipToServiceType(a.equipmentType);
    const rate = rateMap.get(svcType);
    return { ...a, rateMin: rate?.minCents ?? null, rateMax: rate?.maxCents ?? null, rateServiceType: svcType };
  });

  const branding = await getAccountBranding(accountId); // #15 co-brand
  const pdfBuffer = await renderLeaveBehindPdf({
    // [NETA-8-7] surface the technician + as-left fields the certification block reads.
    workOrder: { ...(wo as any), technicianName },
    deficiencies: sortedDefs as any,
    openQuoteRequests: openQuotes as any,
    modernizationAssets,
    branding,
  });

  return { pdfBuffer, workOrder: wo, filename: `leave-behind-${workOrderId.slice(-8).toUpperCase()}.pdf` };
}
