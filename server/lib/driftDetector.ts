'use strict';

/**
 * driftDetector.ts — #4 Repeat-failure / compliance-drift detector.
 *
 * Looks across maintenance cycles (trailing 24 months) for assets that are
 * drifting — not to file another ticket, but to recommend a PROGRAM change:
 *
 *   worsening_trend     — open ADVISORY "trending up/down …% since last test"
 *                         deficiencies (the YoY trend flags commitTestReport
 *                         writes). Readings degrading between cycles while still
 *                         technically in spec → recommend SHORTENING the interval
 *                         (treat as Condition 3) before it fails.
 *   unclosed_corrective — a deficiency open > 120 days that PREDATES the asset's
 *                         most recent completed maintenance: inspections kept
 *                         happening but the finding was never corrected →
 *                         recommend opening a corrective work order / escalating.
 *   repeat_failure      — >= 3 deficiencies on the asset in the window: a
 *                         recurring problem maintenance isn't solving →
 *                         recommend reviewing the procedure / considering
 *                         replacement.
 *
 *   buildDriftDetector(prisma, accountId, { siteId? }) -> findings + summary
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 730;
const UNCLOSED_MIN_AGE_DAYS = 120;
const REPEAT_THRESHOLD = 3;

const SEV_RANK: any = { IMMEDIATE: 0, RECOMMENDED: 1, ADVISORY: 2 };

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

const RECOMMENDATION: any = {
  worsening_trend: { action: 'shorten_interval', text: 'Tighten the maintenance interval (treat as Condition 3) — readings are drifting between cycles.' },
  unclosed_corrective: { action: 'close_corrective', text: 'Inspections continued but this finding was never corrected — open a corrective work order or escalate.' },
  repeat_failure: { action: 'review_procedure', text: 'Recurring deficiencies despite maintenance — review the procedure or evaluate replacement.' },
};

async function buildDriftDetector(prisma: any, accountId: string, { siteId = null }: { siteId?: string | null } = {}) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  let site = null;
  if (siteId) {
    site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
    if (!site) { const e: any = new Error('Site not found.'); e.code = 'SITE_NOT_FOUND'; throw e; }
  }
  const assetScope: any = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const [defs, woAgg] = await Promise.all([
    prisma.deficiency.findMany({
      where: { accountId, createdAt: { gte: windowStart }, asset: assetScope },
      select: {
        assetId: true, severity: true, description: true, createdAt: true, resolvedAt: true,
        asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, governingCondition: true, site: { select: { name: true } } } },
      },
    }),
    prisma.workOrder.groupBy({ by: ['assetId'], where: { accountId, status: 'COMPLETE', completedDate: { gte: windowStart }, asset: assetScope }, _max: { completedDate: true } }),
  ]);

  const latestWoByAsset = new Map<string, Date | null>(woAgg.map((r: any) => [r.assetId, r._max.completedDate]));

  // Group deficiencies by asset.
  const byAsset = new Map<string, any>();
  for (const d of defs) {
    let g = byAsset.get(d.assetId);
    if (!g) { g = { asset: d.asset, defs: [] }; byAsset.set(d.assetId, g); }
    g.defs.push(d);
  }

  const findings = [];
  for (const [assetId, g] of byAsset) {
    const open = g.defs.filter((d: any) => !d.resolvedAt);
    const trendingOpen = open.filter((d: any) => /trending/i.test(d.description || ''));
    const totalInWindow = g.defs.length;
    const latestWo = latestWoByAsset.get(assetId) || null;

    // Worst open severity + oldest open age.
    let worstSev: number | null = null;
    let oldestOpenAgeDays = 0;
    for (const d of open) {
      const rank = SEV_RANK[d.severity] ?? 2;
      if (worstSev === null || rank < worstSev) worstSev = rank;
      const age = Math.floor((now.getTime() - new Date(d.createdAt).getTime()) / DAY_MS);
      if (age > oldestOpenAgeDays) oldestOpenAgeDays = age;
    }

    // Unclosed corrective: an open def older than the threshold that predates the
    // most recent completed maintenance on the asset.
    const unclosed = open.some((d: any) => {
      const age = Math.floor((now.getTime() - new Date(d.createdAt).getTime()) / DAY_MS);
      return age > UNCLOSED_MIN_AGE_DAYS && latestWo && new Date(d.createdAt) < new Date(latestWo);
    });

    let driftType: string | null = null;
    if (trendingOpen.length > 0) driftType = 'worsening_trend';
    else if (unclosed) driftType = 'unclosed_corrective';
    else if (totalInWindow >= REPEAT_THRESHOLD) driftType = 'repeat_failure';
    if (!driftType) continue;

    // Score for ranking: worsening_trend with critical open severity first;
    // weight by open count + age.
    const typeWeight: any = { worsening_trend: 30, unclosed_corrective: 20, repeat_failure: 10 };
    const sevWeight = worstSev === 0 ? 15 : worstSev === 1 ? 8 : 3;
    const score = typeWeight[driftType] + sevWeight + Math.min(open.length, 10) + Math.min(Math.floor(oldestOpenAgeDays / 30), 12);

    const rec = RECOMMENDATION[driftType];
    findings.push({
      assetId,
      assetLabel: assetLabel(g.asset),
      siteName: g.asset?.site?.name ?? null,
      equipmentType: g.asset?.equipmentType ?? null,
      governingCondition: g.asset?.governingCondition ?? null,
      driftType,
      recommendation: rec.action,
      recommendationText: rec.text,
      openDeficiencies: open.length,
      trendingDeficiencies: trendingOpen.length,
      totalInWindow,
      oldestOpenAgeDays,
      lastMaintenance: latestWo,
      score,
    });
  }

  findings.sort((a, b) => b.score - a.score);

  const summary = {
    flagged: findings.length,
    worseningTrend: findings.filter((f) => f.driftType === 'worsening_trend').length,
    unclosedCorrective: findings.filter((f) => f.driftType === 'unclosed_corrective').length,
    repeatFailure: findings.filter((f) => f.driftType === 'repeat_failure').length,
  };

  return {
    generatedAt: now,
    scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
    windowDays: WINDOW_DAYS,
    summary,
    findings,
  };
}

module.exports = { buildDriftDetector };

export {};
