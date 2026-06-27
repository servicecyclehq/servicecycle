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

const round = (n: number) => Math.round(n);

async function buildMaintenanceDebtData(prisma: any, accountId: string) {
  const now = new Date();
  const assetScope = { archivedAt: null, inService: true };

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { companyName: true, partnerOrgId: true, enterpriseGroupId: true },
  });

  const resolver = await buildRateResolver(prisma, { accountId, partnerOrgId: account?.partnerOrgId ?? null, enterpriseGroupId: account?.enterpriseGroupId ?? null });
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
    repairAssets: number;
    mod: { 1: { min: number; max: number; count: number }; 3: { min: number; max: number; count: number }; 5: { min: number; max: number; count: number } };
  };
  const sites = new Map<string, SiteBucket>();
  const siteKey = (id: string | null) => id || '__unassigned__';
  function ensureSite(id: string | null, name: string | null): SiteBucket {
    const k = siteKey(id);
    let s = sites.get(k);
    if (!s) {
      s = { siteId: id, siteName: name || 'Unassigned', deferredAssetIds: new Set(),
            repair: 0, repairAssets: 0, mod: { 1: { min: 0, max: 0, count: 0 }, 3: { min: 0, max: 0, count: 0 }, 5: { min: 0, max: 0, count: 0 } } };
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
    site.repairAssets += 1;
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

  // CFO-8-5: keep RAW (unrounded) per-site sub-totals so the account rollups can
  // sum raw and round ONCE at the end. Summing already-rounded per-site rows (the
  // old approach) accumulated up to ±(siteCount/2) dollars of drift across a
  // 120-site book, so the displayed TOTAL diverged from the true aggregate.
  // All values here are DOLLARS (cents were divided by 100 at accumulation time).
  const rawTotals = {
    deferredMin: 0, deferredMax: 0, deferredCount: 0,
    repair: 0,
    modMin: 0, modMax: 0,
    year1Min: 0, year1Max: 0, year3Min: 0, year3Max: 0, year5Min: 0, year5Max: 0,
    debtMin: 0, debtMax: 0,
  };

  // Shape per-site rows with cumulative 1/3/5-year plans. Each DISPLAYED row is
  // the rounded raw value; the account TOTAL is the rounded raw SUM (below).
  const bySite = [...sites.values()].map((s) => {
    const deferredCount = s.deferredAssetIds.size;
    // Raw (dollar) sub-totals for this site.
    const rawDeferredMin = deferredCount * inspMin;
    const rawDeferredMax = deferredCount * inspMax;
    const rawRepair = s.repair;
    const rawMod = {
      1: { min: s.mod[1].min, max: s.mod[1].max },
      3: { min: s.mod[3].min, max: s.mod[3].max },
      5: { min: s.mod[5].min, max: s.mod[5].max },
    };
    const rawYear1 = { min: rawDeferredMin + rawRepair + rawMod[1].min, max: rawDeferredMax + rawRepair + rawMod[1].max };
    const rawYear3 = { min: rawYear1.min + rawMod[3].min, max: rawYear1.max + rawMod[3].max };
    const rawYear5 = { min: rawYear3.min + rawMod[5].min, max: rawYear3.max + rawMod[5].max };

    // Accumulate the account totals from RAW values (rounded once after the loop).
    rawTotals.deferredMin += rawDeferredMin; rawTotals.deferredMax += rawDeferredMax; rawTotals.deferredCount += deferredCount;
    rawTotals.repair += rawRepair;
    rawTotals.modMin += rawMod[1].min + rawMod[3].min + rawMod[5].min;
    rawTotals.modMax += rawMod[1].max + rawMod[3].max + rawMod[5].max;
    rawTotals.year1Min += rawYear1.min; rawTotals.year1Max += rawYear1.max;
    rawTotals.year3Min += rawYear3.min; rawTotals.year3Max += rawYear3.max;
    rawTotals.year5Min += rawYear5.min; rawTotals.year5Max += rawYear5.max;
    rawTotals.debtMin += rawYear5.min; rawTotals.debtMax += rawYear5.max;

    // Rounded values for display.
    const deferred = { min: round(rawDeferredMin), max: round(rawDeferredMax), count: deferredCount };
    const repair = round(rawRepair);
    const mod1 = { min: round(rawMod[1].min), max: round(rawMod[1].max), count: s.mod[1].count };
    const mod3 = { min: round(rawMod[3].min), max: round(rawMod[3].max), count: s.mod[3].count };
    const mod5 = { min: round(rawMod[5].min), max: round(rawMod[5].max), count: s.mod[5].count };
    const year1 = { min: round(rawYear1.min), max: round(rawYear1.max) };
    const year3 = { min: round(rawYear3.min), max: round(rawYear3.max) };
    const year5 = { min: round(rawYear5.min), max: round(rawYear5.max) };

    return {
      siteId: s.siteId, siteName: s.siteName,
      deferredMaintenance: deferred,
      repairBacklog: { amount: repair, assets: s.repairAssets },
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

  // Account-level rollups — round the RAW sums ONCE (CFO-8-5).
  const totals = {
    deferredMaintenance: { min: round(rawTotals.deferredMin), max: round(rawTotals.deferredMax), count: rawTotals.deferredCount },
    repairBacklog: { amount: round(rawTotals.repair), assets: repairAssets.length },
    modernization: { min: round(rawTotals.modMin), max: round(rawTotals.modMax) },
    debtTotal: { min: round(rawTotals.debtMin), max: round(rawTotals.debtMax) },
  };
  const plan = {
    year1: { min: round(rawTotals.year1Min), max: round(rawTotals.year1Max) },
    year3: { min: round(rawTotals.year3Min), max: round(rawTotals.year3Max) },
    year5: { min: round(rawTotals.year5Min), max: round(rawTotals.year5Max) },
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
  // CFO-8-6: make the column semantics unambiguous so the workbook reconciles.
  //   • "Modernization total" = mod1 + mod3 + mod5 (the INCREMENTAL modernization
  //     dollars; the new spend on top of the catch-up + repair backlog).
  //   • The Year 1/3/5 columns are CUMULATIVE (each contains the prior year), so
  //     they must NOT be summed across years. The reconciling identity, per row
  //     and on the TOTAL, is:
  //         Year 5 = Deferred maint. + Repair backlog + Modernization total
  //   These labels + the documentation row below stop a reader from double-
  //   counting modernization (Year 3 already contains Year 1; Year 5 contains
  //   Year 3) or expecting "Repair + Modernization = Year 5" (it omits Deferred).
  const rows: string[][] = [];
  rows.push([
    'Site',
    'Deferred maint. (min)', 'Deferred maint. (max)',
    'Repair backlog',
    'Modernization total (min, incremental)', 'Modernization total (max, incremental)',
    'Year 1 cumulative (min)', 'Year 1 cumulative (max)',
    'Year 3 cumulative (min)', 'Year 3 cumulative (max)',
    'Year 5 cumulative (min)', 'Year 5 cumulative (max)',
  ]);
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
  const totalModMin = data.totals.modernization.min;
  const totalModMax = data.totals.modernization.max;
  rows.push([
    'TOTAL',
    String(data.totals.deferredMaintenance.min), String(data.totals.deferredMaintenance.max),
    String(data.totals.repairBacklog.amount),
    String(totalModMin), String(totalModMax),
    String(data.plan.year1.min), String(data.plan.year1.max),
    String(data.plan.year3.min), String(data.plan.year3.max),
    String(data.plan.year5.min), String(data.plan.year5.max),
  ]);
  // Documentation row: the identity the columns satisfy (do not sum year columns).
  rows.push([
    'Note: Year columns are CUMULATIVE (do not add them together). Identity: Year 5 = Deferred maint. + Repair backlog + Modernization total. Modernization total is the incremental new spend.',
  ]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildMaintenanceDebtData, debtLedgerToCsv };

export {};
