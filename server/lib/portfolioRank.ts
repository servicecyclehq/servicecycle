/**
 * portfolioRank.ts — B2: contractor-only customer-portfolio ranking + talking
 * points.
 *
 * Ranks every customer account ACROSS the contractor's own book on five signals
 * the contractor already owns — work-order completion rate, overdue %, average
 * asset condition, deficiency-clearance velocity, and the B1 NFPA 70B maturity
 * score — turns each into a portfolio percentile, blends them into one composite
 * rank, and auto-generates the rep's discussion points for each account.
 *
 * HARD RULE (enforced by callers): this is oem_admin / contractor-only. It must
 * NEVER appear on any customer-facing surface (customer digest, share links,
 * co-brand, the quote-request dossier the customer can read). The customer only
 * ever sees their OWN B1 maturity score. The data here uses only what the
 * contractor already owns about its book — but the RANKING (where a customer
 * sits vs other customers) is competitive intel, not the customer's to see.
 *
 *   buildPortfolioRank(prisma, accountIds, { meta? }) -> ranked rows
 *   buildAccountTalkingPoints(prisma, accountId)      -> one account's rank +
 *                                                        discussion points
 *                                                        (resolves its own book)
 */

const { buildComplianceGap } = require('./complianceReport');
const { summarizeMaturity } = require('./maturityScore');

const DAY_MS = 86_400_000;

// Metric directions: 'good' = higher is better; 'bad' = higher is worse.
// Percentile is always normalized so 100 = best-in-book for that metric.
const METRICS = [
  { key: 'completionRate', dir: 'good', label: 'Work-order completion' },
  { key: 'overduePct', dir: 'bad', label: 'Overdue maintenance' },
  { key: 'avgCondition', dir: 'bad', label: 'Asset condition' },
  { key: 'clearanceRate', dir: 'good', label: 'Deficiency clearance' },
  { key: 'maturityScore', dir: 'good', label: 'Program maturity' },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Percentile of `value` within `values` (non-null), normalized so higher is
 * always better. n<=1 -> 100 (trivially top of a one-account book).
 */
function percentile(value: number, values: number[], dir: string): number {
  const arr = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  const n = arr.length;
  if (n <= 1) return 100;
  let countBetterOrEqual: number;
  if (dir === 'good') {
    countBetterOrEqual = arr.filter((v) => v <= value).length; // higher value ranks up
  } else {
    countBetterOrEqual = arr.filter((v) => v >= value).length; // lower value ranks up
  }
  return Math.round((countBetterOrEqual / n) * 100);
}

// ── Raw metric collection (bulk, one query per metric across the whole book) ──
async function collectRawMetrics(prisma: any, accountIds: string[]) {
  const now = new Date();
  const ago90 = new Date(now.getTime() - 90 * DAY_MS);
  const assetScope = { archivedAt: null, inService: true };

  const [woByStatus, schedAll, schedOverdue, condAgg, c3Counts, defResolved90, defOpen] = await Promise.all([
    prisma.workOrder.groupBy({ by: ['accountId', 'status'], where: { accountId: { in: accountIds } }, _count: { _all: true } }),
    prisma.maintenanceSchedule.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, isActive: true, asset: assetScope }, _count: { _all: true } }),
    prisma.maintenanceSchedule.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, isActive: true, nextDueDate: { lt: now }, asset: assetScope }, _count: { _all: true } }),
    prisma.asset.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, ...assetScope, conditionScore: { not: null } }, _avg: { conditionScore: true } }),
    prisma.asset.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, ...assetScope, governingCondition: 'C3' }, _count: { _all: true } }),
    prisma.deficiency.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, resolvedAt: { gte: ago90 } }, _count: { _all: true } }),
    prisma.deficiency.groupBy({ by: ['accountId'], where: { accountId: { in: accountIds }, resolvedAt: null }, _count: { _all: true } }),
  ]);

  // Work orders: completion = COMPLETE / (COMPLETE + SCHEDULED + IN_PROGRESS); CANCELLED ignored.
  const woComplete = new Map<string, number>();
  const woOpen = new Map<string, number>();
  for (const r of woByStatus) {
    const c = r._count._all || 0;
    if (r.status === 'COMPLETE') woComplete.set(r.accountId, (woComplete.get(r.accountId) || 0) + c);
    else if (r.status === 'SCHEDULED' || r.status === 'IN_PROGRESS') woOpen.set(r.accountId, (woOpen.get(r.accountId) || 0) + c);
  }
  const schedAllMap = new Map<string, number>(schedAll.map((r: any) => [r.accountId, r._count._all || 0]));
  const schedOverdueMap = new Map<string, number>(schedOverdue.map((r: any) => [r.accountId, r._count._all || 0]));
  const condMap = new Map<string, number | null>(condAgg.map((r: any) => [r.accountId, r._avg.conditionScore ?? null]));
  const c3Map = new Map<string, number>(c3Counts.map((r: any) => [r.accountId, r._count._all || 0]));
  const defResolvedMap = new Map<string, number>(defResolved90.map((r: any) => [r.accountId, r._count._all || 0]));
  const defOpenMap = new Map<string, number>(defOpen.map((r: any) => [r.accountId, r._count._all || 0]));

  // Maturity needs the full gap per account (same per-account pass fleet already does).
  const gapByAccount = new Map<string, any>();
  const CHUNK = 8;
  for (let __i = 0; __i < accountIds.length; __i += CHUNK) {
  await Promise.all(accountIds.slice(__i, __i + CHUNK).map(async (id) => {
    try { gapByAccount.set(id, await buildComplianceGap(prisma, id, { limit: Number.MAX_SAFE_INTEGER })); }
    catch (e: any) { gapByAccount.set(id, null); }
  }));
  }

  const raw = new Map<string, any>();
  for (const id of accountIds) {
    const comp = woComplete.get(id) || 0;
    const open = woOpen.get(id) || 0;
    const totalWo = comp + open;
    const schedTotal = schedAllMap.get(id) || 0;
    const overdue = schedOverdueMap.get(id) || 0;
    const avgCond = condMap.get(id) ?? null;
    const resolved90 = defResolvedMap.get(id) || 0;
    const openDefs = defOpenMap.get(id) || 0;
    const gap = gapByAccount.get(id);
    const maturity = gap ? summarizeMaturity(gap, {}) : null;

    raw.set(id, {
      metrics: {
        completionRate: totalWo > 0 ? round1((comp / totalWo) * 100) : null,
        overduePct: schedTotal > 0 ? round1((overdue / schedTotal) * 100) : null,
        avgCondition: avgCond != null ? round1(avgCond) : null,
        clearanceRate: (resolved90 + openDefs) > 0 ? round1((resolved90 / (resolved90 + openDefs)) * 100) : null,
        maturityScore: maturity ? maturity.score : null,
      },
      detail: {
        completedWorkOrders: comp,
        openWorkOrders: open,
        activeSchedules: schedTotal,
        overdueSchedules: overdue,
        avgConditionScore: avgCond != null ? round1(avgCond) : null,
        c3Assets: c3Map.get(id) || 0,
        deficienciesResolved90d: resolved90,
        openDeficiencies: openDefs,
        maturityLevel: maturity ? maturity.level : null,
        maturityLevelLabel: maturity ? maturity.levelLabel : null,
        maturityNextLevel: maturity ? maturity.nextLevel : null,
      },
    });
  }
  return raw;
}

// ── Discussion points (rep-facing sales talking points) ──────────────────────
function discussionPoints(row: any): Array<{ kind: string; severity: string; text: string }> {
  const m = row.metrics;
  const d = row.detail;
  const p = row.percentiles;
  const points: Array<{ kind: string; severity: string; text: string }> = [];

  // LEAD — the thing to open the conversation with.
  if (d.overdueSchedules > 0 && ((p.overduePct != null && p.overduePct <= 34) || (m.overduePct != null && m.overduePct >= 25))) {
    points.push({ kind: 'overdue', severity: 'lead',
      text: `${d.overdueSchedules} overdue maintenance item${d.overdueSchedules === 1 ? '' : 's'} (${m.overduePct}% of active schedules) — lead with the overdue punch list.` });
  }
  if (d.maturityLevel != null && d.maturityLevel <= 2) {
    const next = d.maturityNextLevel ? ` (${d.maturityNextLevel.pointsToNext} pts to ${d.maturityNextLevel.label})` : '';
    points.push({ kind: 'maturity', severity: 'lead',
      text: `Program maturity Level ${d.maturityLevel} of 5 (${d.maturityLevelLabel})${next} — pitch a foundational 70B service agreement.` });
  }

  // OPPORTUNITY — upsell / remediation angles.
  if (d.openDeficiencies > 0 && m.clearanceRate != null && m.clearanceRate < 50) {
    points.push({ kind: 'clearance', severity: 'opportunity',
      text: `Deficiencies are clearing slowly (${d.openDeficiencies} open, ${d.deficienciesResolved90d} cleared in 90 days) — propose a remediation sprint.` });
  }
  if (d.c3Assets > 0 || (m.avgCondition != null && m.avgCondition >= 3)) {
    points.push({ kind: 'condition', severity: 'opportunity',
      text: `${d.c3Assets > 0 ? `${d.c3Assets} asset${d.c3Assets === 1 ? '' : 's'} at Condition 3` : `Average asset condition ${m.avgCondition}/5`} — open a modernization / replacement conversation.` });
  }
  if (m.completionRate != null && m.completionRate < 60 && (d.completedWorkOrders + d.openWorkOrders) >= 3) {
    points.push({ kind: 'completion', severity: 'opportunity',
      text: `Only ${m.completionRate}% of work orders are completed (${d.openWorkOrders} open) — a scheduling/follow-up gap to close together.` });
  }

  // POSITIVE — protect-the-renewal framing for strong accounts.
  if (points.length === 0 && row.portfolioPercentile != null && row.portfolioPercentile >= 75) {
    points.push({ kind: 'strong', severity: 'positive',
      text: `Top-quartile account in your book — strong program; protect the renewal and offer the modernization forecast as the next step.` });
  }
  if (points.length === 0) {
    points.push({ kind: 'steady', severity: 'positive',
      text: `No urgent gaps flagged — steady account; a periodic check-in keeps the relationship warm and reports flowing.` });
  }

  return points.slice(0, 4);
}

/**
 * Rank a whole portfolio. `meta` (optional) maps accountId -> { companyName,
 * serviceRepName, assignedRepId } for display; missing entries fall back.
 */
async function buildPortfolioRank(prisma: any, accountIds: string[], { meta = new Map() }: { meta?: Map<string, any> } = {}) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const raw = await collectRawMetrics(prisma, ids);

  // Build per-metric value distributions for percentile math.
  const valuesByMetric: Record<string, number[]> = {};
  for (const mDef of METRICS) {
    valuesByMetric[mDef.key] = ids
      .map((id) => raw.get(id).metrics[mDef.key])
      .filter((v) => v !== null && v !== undefined);
  }

  const rows = ids.map((id) => {
    const r = raw.get(id);
    const percentiles: Record<string, number | null> = {};
    const avail: number[] = [];
    for (const mDef of METRICS) {
      const v = r.metrics[mDef.key];
      if (v === null || v === undefined) { percentiles[mDef.key] = null; continue; }
      const pct = percentile(v, valuesByMetric[mDef.key], mDef.dir);
      percentiles[mDef.key] = pct;
      avail.push(pct);
    }
    const composite = avail.length > 0 ? Math.round(avail.reduce((a, b) => a + b, 0) / avail.length) : null;
    const md = meta.get(id) || {};
    return {
      accountId: id,
      companyName: md.companyName || 'Account',
      serviceRepName: md.serviceRepName || null,
      assignedRepId: md.assignedRepId || null,
      metrics: r.metrics,
      detail: r.detail,
      percentiles,
      portfolioPercentile: composite,
    };
  });

  // Rank: best composite first (highest percentile). Nulls (no data) trail.
  rows.sort((a, b) => {
    if (a.portfolioPercentile === null && b.portfolioPercentile === null) return 0;
    if (a.portfolioPercentile === null) return 1;
    if (b.portfolioPercentile === null) return -1;
    return b.portfolioPercentile - a.portfolioPercentile;
  });
  rows.forEach((row, i) => {
    (row as any).rank = i + 1;
    (row as any).rankOf = rows.length;
    (row as any).discussionPoints = discussionPoints(row);
  });

  return rows;
}

/**
 * One account's rank + talking points, resolved within ITS OWN contractor book
 * (same partnerOrg). Used to enrich the rep-facing quote-request event. Returns
 * null when the account isn't linked to a partner org (standalone — no book to
 * rank against; talking points still computed against a single-account book).
 */
async function buildAccountTalkingPoints(prisma: any, accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, companyName: true, partnerOrgId: true, serviceRepName: true, assignedRepId: true },
  });
  if (!account) return null;

  let bookIds: string[] = [accountId];
  if (account.partnerOrgId) {
    const book = await prisma.account.findMany({
      where: { partnerOrgId: account.partnerOrgId, status: 'active' },
      select: { id: true, companyName: true, serviceRepName: true, assignedRepId: true },
    });
    bookIds = book.map((a: any) => a.id);
    const meta = new Map<string, any>(book.map((a: any) => [a.id, a] as [string, any]));
    const ranked = await buildPortfolioRank(prisma, bookIds, { meta });
    return ranked.find((r: any) => r.accountId === accountId) ?? null;
  }

  const meta = new Map<string, any>([[accountId, account]]);
  const ranked = await buildPortfolioRank(prisma, bookIds, { meta });
  return ranked[0] ?? null;
}

module.exports = { buildPortfolioRank, buildAccountTalkingPoints, METRICS };

export {};
