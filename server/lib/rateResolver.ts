/**
 * rateResolver.ts  ServiceRateCard resolution shared across the digest,
 * fleet forecast, and modernization alerts.
 *
 * Resolution hierarchy (most specific wins):
 *   account override (accountId = X)         set by the contractor for this customer
 *   group standard   (enterpriseGroupId = G) HoldCo-wide rate inherited by OpCos (#9)
 *   partner default  (partnerOrgId = P)      the contractor's house pricing
 *   platform default (all null)              seeded read-only benchmark
 *
 * One DB read per resolver (loads the three scopes in a single findMany), then
 * a pure lookup by serviceType. Build one resolver per account in a loop 
 * cheap, and avoids an N+1 across a partner org's whole book.
 *
 * GAP closed alongside this (see routes/rateCards.ts): a manager-guarded CRUD
 * that writes ONLY account-level overrides, so a customer's rep can make the
 * benchmark match the real agreed pricing without touching the platform seed.
 */

import prisma from './prisma';

export interface RateRange { minCents: number; maxCents: number }

// EquipmentType (Prisma enum)  ServiceRateCard.serviceType. Mirrors the
// mapping in modernizationAlerts.ts; kept here so the digest, the rate-card
// editor, and the forecast all speak one vocabulary. Unmapped types fall back
// to INSPECTION (the lowest-cost generic service line).
const EQUIP_TO_SERVICE_TYPE: Record<string, string> = {
  TRANSFORMER_LIQUID: 'TRANSFORMER_REPLACEMENT',
  TRANSFORMER_DRY:    'TRANSFORMER_REPLACEMENT',
  SWITCHGEAR:         'SWITCHGEAR_MODERNIZATION',
  SWITCHBOARD:        'SWITCHGEAR_MODERNIZATION',
  PANELBOARD:         'SWITCHGEAR_MODERNIZATION',
  CIRCUIT_BREAKER:    'BREAKER_RETROFIT',
  PROTECTION_RELAY:   'RELAY_UPGRADE',
  MCC:                'SWITCHGEAR_MODERNIZATION',
  UPS_BATTERY:        'INSPECTION',
  BATTERY_SYSTEM:     'INSPECTION',
  TRANSFER_SWITCH:    'INSPECTION',
};

// The full set of service lines an account can price. Drives the editor UI and
// the GET that merges defaults with overrides.
export const SERVICE_TYPES = [
  'ARC_FLASH_STUDY',
  'SWITCHGEAR_MODERNIZATION',
  'BREAKER_RETROFIT',
  'TRANSFORMER_REPLACEMENT',
  'RELAY_UPGRADE',
  'INSPECTION',
  'LOAD_STUDY',
  'QEMW_TRAINING',
];

export function mapEquipTypeToServiceType(equipmentType: string | null | undefined): string {
  if (!equipmentType) return 'INSPECTION';
  return EQUIP_TO_SERVICE_TYPE[equipmentType] ?? 'INSPECTION';
}

export function formatRange(r: RateRange | null | undefined): string | null {
  if (!r) return null;
  return `$${(r.minCents / 100).toLocaleString()}  $${(r.maxCents / 100).toLocaleString()}`;
}

export interface ResolvedRate extends RateRange {
  serviceType: string;
  source: 'account' | 'group' | 'partner' | 'platform';
}

/**
 * Resolver scoped to ONE account. Loads the three rate-card scopes in a single
 * query and returns a pure lookup. `partnerOrgId` is optional (standalone
 * accounts have none)  pass it so partner-default pricing is honoured.
 */
export async function buildRateResolver(
  prismaClient: any,
  { accountId, partnerOrgId, enterpriseGroupId }: { accountId: string; partnerOrgId?: string | null; enterpriseGroupId?: string | null },
): Promise<{
  get: (serviceType: string) => RateRange | null;
  forEquip: (equipmentType: string | null | undefined) => RateRange | null;
  resolvedAll: () => ResolvedRate[];
}> {
  const orFilters: any[] = [{ partnerOrgId: null, accountId: null, enterpriseGroupId: null }]; // platform
  if (enterpriseGroupId) orFilters.push({ enterpriseGroupId, accountId: null }); // group standard (#9)
  if (partnerOrgId) orFilters.push({ partnerOrgId, accountId: null, enterpriseGroupId: null }); // partner default
  orFilters.push({ accountId }); // account override (any partnerOrgId)

  const rows = await prismaClient.serviceRateCard.findMany({ where: { OR: orFilters } });

  // Bucket by scope, then collapse per serviceType: account > group > partner > platform.
  const platform = new Map<string, RateRange>();
  const partner = new Map<string, RateRange>();
  const group = new Map<string, RateRange>();
  const account = new Map<string, RateRange>();
  for (const r of rows) {
    const range: RateRange = { minCents: r.minCents, maxCents: r.maxCents };
    if (r.accountId === accountId) account.set(r.serviceType, range);
    else if (enterpriseGroupId && r.enterpriseGroupId === enterpriseGroupId && !r.accountId) group.set(r.serviceType, range);
    else if (partnerOrgId && r.partnerOrgId === partnerOrgId && !r.accountId && !r.enterpriseGroupId) partner.set(r.serviceType, range);
    else if (!r.partnerOrgId && !r.accountId && !r.enterpriseGroupId) platform.set(r.serviceType, range);
  }

  const get = (serviceType: string): RateRange | null =>
    account.get(serviceType) ?? group.get(serviceType) ?? partner.get(serviceType) ?? platform.get(serviceType) ?? null;

  const resolvedAll = (): ResolvedRate[] =>
    SERVICE_TYPES.map((st) => {
      const a = account.get(st);
      if (a) return { serviceType: st, ...a, source: 'account' as const };
      const g = group.get(st);
      if (g) return { serviceType: st, ...g, source: 'group' as const };
      const p = partner.get(st);
      if (p) return { serviceType: st, ...p, source: 'partner' as const };
      const pl = platform.get(st);
      if (pl) return { serviceType: st, ...pl, source: 'platform' as const };
      return { serviceType: st, minCents: 0, maxCents: 0, source: 'platform' as const };
    });

  return {
    get,
    forEquip: (equipmentType) => get(mapEquipTypeToServiceType(equipmentType)),
    resolvedAll,
  };
}

module.exports = { buildRateResolver, mapEquipTypeToServiceType, formatRange, SERVICE_TYPES };
export {};
