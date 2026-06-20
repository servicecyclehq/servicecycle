'use strict';

/**
 * proposalBuilder.ts — #5 Multi-year scope / proposal builder (repair/replace/defer).
 *
 * Turns the asset population + open deficiencies + RUL/modernization scoring +
 * rate cards into a sellable multi-year maintenance program: one line item per
 * asset that needs action, each classified repair / replace / defer with a cost
 * range and a funding year, then packaged into three sellable options
 * (Essential / Recommended / Comprehensive). Extends the quote-request economics
 * and reuses the same cost model as the Maintenance Debt Ledger.
 *
 * Recommendation logic (worst-driver-wins, per asset):
 *   REPLACE  — modernizationRiskScore >= 0.70 (end-of-life). Priced at the
 *              equipment's modernization rate. Year: >=0.85 -> 1, else -> 3.
 *   REPAIR   — open deficiency, governing Condition 3, or aging (0.50-0.69 RUL).
 *              Priced at repairCostEstimate when known, else the inspection rate.
 *              Year: IMMEDIATE deficiency -> 1, else -> 2/3 by severity.
 *   DEFER    — only overdue routine maintenance, no deficiency / not EOL.
 *              Priced at the inspection rate. Year 5 ("as budget allows").
 *
 *   buildProposal(prisma, accountId, { siteId? }) -> proposal bundle
 */

const { buildRateResolver } = require('./rateResolver');

const SEV_RANK: any = { IMMEDIATE: 0, RECOMMENDED: 1, ADVISORY: 2 };
const round = (n: number) => Math.round(n);

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

async function buildProposal(prisma: any, accountId: string, { siteId = null }: { siteId?: string | null } = {}) {
  const now = new Date();
  let site = null;
  if (siteId) {
    site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
    if (!site) { const e: any = new Error('Site not found.'); e.code = 'SITE_NOT_FOUND'; throw e; }
  }
  const assetScope: any = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true, partnerOrgId: true, enterpriseGroupId: true } });
  const resolver = await buildRateResolver(prisma, { accountId, partnerOrgId: account?.partnerOrgId ?? null, enterpriseGroupId: account?.enterpriseGroupId ?? null });
  const inspection = resolver.get('INSPECTION');
  const inspMin = inspection ? inspection.minCents / 100 : 0;
  const inspMax = inspection ? inspection.maxCents / 100 : 0;

  // Candidate assets: anything with a deficiency, an RUL flag, C3, a repair
  // estimate, or an overdue schedule. One query each, stitched per asset.
  const [assets, openDefs, overdue] = await Promise.all([
    prisma.asset.findMany({
      where: { accountId, ...assetScope, OR: [
        { modernizationRiskScore: { gte: 0.50 } },
        { governingCondition: 'C3' },
        { repairCostEstimate: { not: null } },
        { deficiencies: { some: { resolvedAt: null } } },
        { schedules: { some: { isActive: true, nextDueDate: { lt: now } } } },
      ] },
      select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true,
                modernizationRiskScore: true, governingCondition: true, repairCostEstimate: true,
                site: { select: { name: true } } },
    }),
    prisma.deficiency.groupBy({ by: ['assetId', 'severity'], where: { accountId, resolvedAt: null, asset: assetScope }, _count: { _all: true } }),
    prisma.maintenanceSchedule.groupBy({ by: ['assetId'], where: { accountId, isActive: true, nextDueDate: { lt: now }, asset: assetScope }, _count: { _all: true } }),
  ]);

  // Per-asset worst deficiency severity + counts.
  const defBest = new Map<string, number>(); // assetId -> best (lowest) sev rank
  const defCount = new Map<string, number>();
  for (const d of openDefs) {
    const rank = SEV_RANK[d.severity] ?? 2;
    if (!defBest.has(d.assetId) || rank < (defBest.get(d.assetId) as number)) defBest.set(d.assetId, rank);
    defCount.set(d.assetId, (defCount.get(d.assetId) || 0) + (d._count._all || 0));
  }
  const overdueMap = new Map<string, number>(overdue.map((r: any) => [r.assetId, r._count._all || 0]));

  const lineItems = [];
  for (const a of assets) {
    const rul = Number(a.modernizationRiskScore) || 0;
    const defSev = defBest.has(a.id) ? (defBest.get(a.id) as number) : null;
    const defN = defCount.get(a.id) || 0;
    const overdueN = overdueMap.get(a.id) || 0;
    const repairEst = a.repairCostEstimate != null ? Number(a.repairCostEstimate) : null;

    let recommendation: 'replace' | 'repair' | 'defer';
    let year: 1 | 3 | 5;
    let costMin: number, costMax: number;
    const drivers: string[] = [];

    if (rul >= 0.70) {
      recommendation = 'replace';
      year = rul >= 0.85 ? 1 : 3;
      const r = resolver.forEquip(a.equipmentType);
      costMin = r ? round(r.minCents / 100) : 0;
      costMax = r ? round(r.maxCents / 100) : 0;
      drivers.push(`End-of-life risk ${(rul).toFixed(2)}`);
    } else if (defN > 0 || a.governingCondition === 'C3' || rul >= 0.50 || repairEst != null) {
      recommendation = 'repair';
      year = defSev === 0 ? 1 : (defSev === 1 ? 1 : 3);
      if (repairEst != null) { costMin = round(repairEst); costMax = round(repairEst); }
      else { costMin = round(inspMin); costMax = round(inspMax); }
      if (defN > 0) drivers.push(`${defN} open deficienc${defN === 1 ? 'y' : 'ies'}${defSev === 0 ? ' (IMMEDIATE)' : ''}`);
      if (a.governingCondition === 'C3') drivers.push('Condition 3');
      if (rul >= 0.50) drivers.push(`Aging risk ${(rul).toFixed(2)}`);
    } else {
      recommendation = 'defer';
      year = 5;
      costMin = round(inspMin); costMax = round(inspMax);
      drivers.push(`${overdueN} overdue task${overdueN === 1 ? '' : 's'} (deferrable)`);
    }

    lineItems.push({
      assetId: a.id,
      assetLabel: assetLabel(a),
      siteName: a.site?.name ?? null,
      equipmentType: a.equipmentType,
      recommendation,
      year,
      costMin,
      costMax,
      drivers,
      priority: recommendation === 'replace' && year === 1 ? 0 : (defSev === 0 ? 0 : year),
    });
  }

  // Order: year asc, then replace>repair>defer, then cost desc.
  const recRank: any = { replace: 0, repair: 1, defer: 2 };
  lineItems.sort((a, b) => (a.year - b.year) || (recRank[a.recommendation] - recRank[b.recommendation]) || (b.costMax - a.costMax));

  const sumRange = (items: any[]) => items.reduce((acc, i) => ({ min: acc.min + i.costMin, max: acc.max + i.costMax }), { min: 0, max: 0 });
  const yr1 = lineItems.filter((i) => i.year === 1);
  const yr3 = lineItems.filter((i) => i.year === 3);
  const yr5 = lineItems.filter((i) => i.year === 5);
  const nonDefer = lineItems.filter((i) => i.recommendation !== 'defer');

  const options = [
    {
      key: 'essential', label: 'Essential (safety-first)',
      description: 'Year-1 critical work only: end-of-life replacements due now and immediate repairs.',
      lineItems: yr1.map((i) => i.assetId), count: yr1.length, total: sumRange(yr1),
    },
    {
      key: 'recommended', label: 'Recommended (phased)',
      description: 'All non-deferrable work scheduled across years 1–3 to keep the program compliant.',
      lineItems: nonDefer.map((i) => i.assetId), count: nonDefer.length, total: sumRange(nonDefer),
    },
    {
      key: 'comprehensive', label: 'Comprehensive (5-year)',
      description: 'The full program including deferrable routine maintenance, spread across years 1–5.',
      lineItems: lineItems.map((i) => i.assetId), count: lineItems.length, total: sumRange(lineItems),
    },
  ];

  return {
    generatedAt: now,
    accountName: account?.companyName || 'Account',
    scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
    currency: 'USD',
    summary: {
      lineItems: lineItems.length,
      replace: lineItems.filter((i) => i.recommendation === 'replace').length,
      repair: lineItems.filter((i) => i.recommendation === 'repair').length,
      defer: lineItems.filter((i) => i.recommendation === 'defer').length,
      byYear: { year1: { count: yr1.length, ...sumRange(yr1) }, year3: { count: yr3.length, ...sumRange(yr3) }, year5: { count: yr5.length, ...sumRange(yr5) } },
      total: sumRange(lineItems),
    },
    options,
    lineItems,
    disclaimer:
      'BUDGETARY PROPOSAL — NOT A FIRM QUOTE. Costs are estimated ranges from ' +
      'published service-rate benchmarks, recorded repair estimates, and equipment-' +
      'life models. Final pricing requires a site assessment. Not an engineering ' +
      'certification or a guarantee of remaining useful life.',
  };
}

/**
 * Strip every dollar figure from a proposal for customer-facing surfaces. The
 * customer sees WHAT / WHEN / WHY (recommendation, year, drivers, counts) but no
 * pricing — pricing is the contractor's to present, via the rep. Mutates a clone.
 */
function redactProposalCosts(data: any) {
  const clone = JSON.parse(JSON.stringify(data));
  for (const li of clone.lineItems || []) { delete li.costMin; delete li.costMax; }
  for (const o of clone.options || []) { delete o.total; }
  if (clone.summary) {
    delete clone.summary.total;
    if (clone.summary.byYear) {
      for (const k of Object.keys(clone.summary.byYear)) {
        const y = clone.summary.byYear[k];
        if (y) { delete y.min; delete y.max; } // keep the count
      }
    }
  }
  clone.costsRedacted = true;
  return clone;
}

module.exports = { buildProposal, redactProposalCosts };

export {};
