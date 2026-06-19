'use strict';

/**
 * maintenanceDebt.ts — Maintenance Debt Ledger + capital-plan generator.
 *
 * Quantifies overdue / deferred / end-of-life maintenance as accruing "$ debt"
 * and rolls it into a cumulative 1 / 3 / 5-year funding plan grouped by site.
 * Pure repackaging of data ServiceCycle already computes — no new inputs:
 *
 *   1. Deferred maintenance  — assets carrying >=1 OVERDUE active schedule,
 *      priced at the INSPECTION service rate (one catch-up mobilization per
 *      asset). The cost to bring the maintenance program current.
 *   2. Repair backlog        — assets with an open deficiency AND a recorded
 *      repairCostEstimate. The known, already-scoped repair spend (point value).
 *   3. Modernization / EOL   — assets with modernizationRiskScore >= 0.50 (the
 *      RUL engine), priced via the ServiceRateCard for their equipment type and
 *      bucketed into the funding year by risk (>=0.85 yr1, 0.70-0.84 yr3,
 *      0.50-0.69 yr5) — same tiering the Fleet forecast uses.
 *
 * Rates resolve account > partner > platform via lib/rateResolver. Ranges are
 * min/max; repairCostEstimate is an exact USD value (min === max). The plan is
 * CUMULATIVE: year3 includes year1, year5 includes year3 — a board reads "fund
 * $X by year 1, $Y by year 3, $Z by year 5".
 *
 *   buildMaintenanceDebtData(prisma, accountId) -> ledger bundle
 *   debtLedgerToCsv(data)                       -> CSV string (export)
 */

const { buildRateResolver } = require('./rateResolver');

// Risk-score -> funding year bucket (mirrors fleetDashboard forecast tiers).
function scoreToBucket(score: number): 1 | 3 | 5 {
  if (score >= 0.85) return 1;
  if (score >= 0.70) return 3;
  return 5;
}

const zeroRange = () => ({ min: 0, max: 0 });
function addRange(a: any, b: any) { return { min: a.min + b.min, max: a.max + b.max }; }
const round = (n: number) => Math.round(n);

async function buildMaintenanceDebtData(prisma: any, accountId: string) {
  const now = new Date();
  const assetScope = { archivedAt: null, inService: true };

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { companyName: true, partnerOrgId: true },
  });

  const resolver = await buildRateResolver(prisma, { accountId, partnerOrgId: account?.partnerOrgId ?? null });
  const inspectionCents = resolver.get('INSPECTION'); // { minCents, maxCents } | null
  const inspMin = inspectionCents ? inspectionCents.minCents / 100 : 0;
  const inspMax = inspectionCents ? inspectionCents.maxCents / 100 : 0;

  const [overdueSchedules, repairAssets, modAssets] = await Promise.all([
    // Assets with >=1 overdue active schedule (we de-dup to distinct assets below).
    prisma.maintenanceSchedule.findMany({
      where: { accountId, isActive: true, nextDueDate: { lt: now }, asset: assetScope },
      select: { assetId: true, asset: { select: { siteId: true, site: { select: { name: true } } } } },
    }),
    // Assets with an open deficiency AND a repair-cost estimate (known repair backlog).
    prisma.asset.findMany({
      where: { accountId, ...assetScope, repairCostEstimate: { not: null }, deficiencies: { some: { resolvedAt: null } } },
      select: { id: true, repairCostEstimate: true, siteId: true, site: { select: { name: true } } },
    }),
    // End-of-life / modernization candidates (RUL engine).
    prisma.asset.findMany({
      where: { accountId, ...assetScope, modernizationRiskScore: { gte: 0.50 } },
      select: { id: true, equipmentType: true, modernizationRiskScore: true, siteId: true, site: { select: { name: true } } },
    }),
  ]);

  // Per-site accumulator.
  type SiteBucket = {
    siteId: string | null; siteName: string;
    deferredAssetIds: Set<string>;
    repair: number;
    mod: { 1: { min: number; max: number; count: number }; 3: { min: number; max: number; count: number }; 5: { min: number; max: number; count: number } };
  };
  const sites = new Map<string, SiteBucket>();
  const siteKey = (id: string | null) => id || '__unassigned__';
  function ensureSite(id: string | null, name: string | null): SiteBucket {
    const k = siteKey(id);
    let s = sites.get(k);
    if (!s) {
      s = { siteId: id, siteName: name || 'Unassigned', deferredAssetIds: new Set(),
            repair: 0, mod: { 1: { min: 0, max: 0, count: 0 }, 3: { min: 0, max: 0, count: 0 }, 5: { min: 0, max: 0, count: 0 } } };
      sites.set(k, s);
    }
    return s;
  }

  // 1. Deferred maintenance — distinct assets with overdue schedules.
  for (const s of overdueSchedules) {
    const site = ensureSite(s.asset?.siteId ?? null, s.asset?.site?.name ?? null);
    site.deferredAssetIds.add(s.assetId);
  }
  // 2. Repair backlog.
  for (const a of repairAssets) {
    const site = ensureSite(a.siteId, a.site?.name ?? null);
    site.repair += Number(a.repairCostEstimate) || 0;
  }
  // 3. Modernization.
  for (const a of modAssets) {
    const site = ensureSite(a.siteId, a.site?.name ?? null);
    const r = resolver.forEquip(a.equipmentType); // { minCents, maxCents } | null
    if (!r) continue;
    const bucket = scoreToBucket(Number(a.modernizationRiskScore) || 0);
    site.mod[bucket].min += r.minCents / 100;
    site.mod[bucket].max += r.maxCents / 100;
    site.mod[bucket].count += 1;
  }

  // Shape per-site rows with cumulative 1/3/5-year plans.
  const bySite = [...sites.values()].map((s) => {
    const deferredCount = s.deferredAssetIds.size;
    const deferred = { min: round(deferredCount * inspMin), max: round(deferredCount * inspMax), count: deferredCount };
    const repair = round(s.repair);
    const mod1 = { min: round(s.mod[1].min), max: round(s.mod[1].max), count: s.mod[1].count };
    const mod3 = { min: round(s.mod[3].min), max: round(s.mod[3].max), count: s.mod[3].count };
    const mod5 = { min: round(s.mod[5].min), max: round(s.mod[5].max), count: s.mod[5].count };

    // Year 1 = deferred + repair + modernization due now (>=0.85).
    const year1 = { min: deferred.min + repair + mod1.min, max: deferred.max + repair + mod1.max };
    const year3 = { min: year1.min + mod3.min, max: year1.max + mod3.max };
    const year5 = { min: year3.min + mod5.min, max: year3.max + mod5.max };

    return {
      siteId: s.siteId, siteName: s.siteName,
      deferredMaintenance: deferred,
      repairBacklog: { amount: repair, assets: 0 },
      modernization: {
        year1: mod1, year3: mod3, year5: mod5,
        assetCount: mod1.count + mod3.count + mod5.count,
      },
      debtTotal: { min: year5.min, max: year5.max },
      plan: { year1, year3, year5 },
    };
  });

  // Sort sites by year-5 debt, biggest first.
  bySite.sort((a, b) => b.debtTotal.max - a.debtTotal.max);

  // Account-level rollups.
  const totals = {
    deferredMaintenance: bySite.reduce((acc, s) => ({ min: acc.min + s.deferredMaintenance.min, max: acc.max + s.deferredMaintenance.max, count: acc.count + s.deferredMaintenance.count }), { min: 0, max: 0, count: 0 }),
    repairBacklog: { amount: round(bySite.reduce((n, s) => n + s.repairBacklog.amount, 0)), assets: repairAssets.length },
    modernization: bySite.reduce((acc, s) => addRange(acc, addRange(addRange(s.modernization.year1, s.modernization.year3), s.modernization.year5)), zeroRange()),
    debtTotal: bySite.reduce((acc, s) => addRange(acc, s.debtTotal), zeroRange()),
  };
  const plan = {
    year1: bySite.reduce((acc, s) => addRange(acc, s.plan.year1), zeroRange()),
    year3: bySite.reduce((acc, s) => addRange(acc, s.plan.year3), zeroRange()),
    year5: bySite.reduce((acc, s) => addRange(acc, s.plan.year5), zeroRange()),
  };

  return {
    accountName: account?.companyName || 'Account',
    generatedAt: now,
    currency: 'USD',
    totals,
    plan,
    bySite,
    basis: {
      inspectionRate: { min: round(inspMin), max: round(inspMax), source: inspectionCents ? 'rate-card' : 'unpriced' },
      deferredAssets: totals.deferredMaintenance.count,
      modernizationAssets: modAssets.length,
      repairAssets: repairAssets.length,
      notes: 'Deferred maintenance = one INSPECTION-rate catch-up per asset with an overdue task. Repair backlog = sum of repairCostEstimate on assets with open deficiencies. Modernization = ServiceRateCard rate for at-risk assets (modernizationRiskScore >= 0.50), bucketed by risk into the funding year.',
    },
    disclaimer:
      'ESTIMATE — NOT A QUOTE. The Maintenance Debt Ledger projects budgetary ranges from the data in ' +
      'ServiceCycle, published service-rate benchmarks, and equipment-life models. Actual costs vary by ' +
      'site, configuration, and labor market. Not an engineering assessment or a guarantee of remaining ' +
      'useful life; have a qualified professional review before committing capital.',
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────
function csvCell(s: any): string {
  const v = s == null ? '' : String(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function debtLedgerToCsv(data: any): string {
  const rows: string[][] = [];
  rows.push(['Site', 'Deferred maint. (min)', 'Deferred maint. (max)', 'Repair backlog', 'Modernization (min)', 'Modernization (max)', 'Year 1 (min)', 'Year 1 (max)', 'Year 3 (min)', 'Year 3 (max)', 'Year 5 (min)', 'Year 5 (max)']);
  for (const s of data.bySite) {
    const modMin = s.modernization.year1.min + s.modernization.year3.min + s.modernization.year5.min;
    const modMax = s.modernization.year1.max + s.modernization.year3.max + s.modernization.year5.max;
    rows.push([
      s.siteName,
      String(s.deferredMaintenance.min), String(s.deferredMaintenance.max),
      String(s.repairBacklog.amount),
      String(modMin), String(modMax),
      String(s.plan.year1.min), String(s.plan.year1.max),
      String(s.plan.year3.min), String(s.plan.year3.max),
      String(s.plan.year5.min), String(s.plan.year5.max),
    ]);
  }
  rows.push([
    'TOTAL',
    String(data.totals.deferredMaintenance.min), String(data.totals.deferredMaintenance.max),
    String(data.totals.repairBacklog.amount),
    String(data.totals.modernization.min), String(data.totals.modernization.max),
    String(data.plan.year1.min), String(data.plan.year1.max),
    String(data.plan.year3.min), String(data.plan.year3.max),
    String(data.plan.year5.min), String(data.plan.year5.max),
  ]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildMaintenanceDebtData, debtLedgerToCsv };

export {};
