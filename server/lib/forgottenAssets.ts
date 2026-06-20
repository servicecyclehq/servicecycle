'use strict';

/**
 * forgottenAssets.ts -- Phase 1 #2 "Forgotten / untracked assets" lens.
 *
 * Surfaces the equipment that has quietly fallen off the maintenance radar -- the
 * single most common real-world audit/insurer surprise ("you have how many
 * transformers nobody has touched?"). Two buckets, both NFPA 70B-scoped:
 *
 *   untracked  -- in-service, non-archived assets with NO active maintenance
 *                 schedule at all (identical definition to the Path-to-100
 *                 "uncovered" set, so the counts reconcile). Invisible to the
 *                 per-standard compliance math entirely.
 *   forgotten  -- assets that ARE on a program but have not been serviced in
 *                 more than the threshold (default 3 years), including those
 *                 with a schedule but no completed work order ever
 *                 (neverServiced). On the books, but nobody is doing the work.
 *
 * Reuses the same live-asset scope + completed-work-order history the rest of the
 * compliance layer uses; it does not recompute compliance, it re-presents which
 * assets are off the radar.
 *
 *   buildForgottenAssets(prisma, accountId, { siteId?, years? })
 *     -> { generatedAt, scope, thresholdYears, summary, untrackedAssets, forgottenAssets }
 *
 * Account-scoped: throws SITE_NOT_FOUND for a missing / cross-tenant siteId.
 */

const DAY_MS = 86_400_000;
const DEFAULT_YEARS = 3;

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

function clampYears(years: any): number {
  const n = Number(years);
  if (!Number.isFinite(n)) return DEFAULT_YEARS;
  return Math.min(20, Math.max(1, Math.round(n)));
}

async function buildForgottenAssets(
  prisma: any,
  accountId: string,
  { siteId = null, years = DEFAULT_YEARS }: { siteId?: string | null; years?: number } = {},
) {
  const now = new Date();
  const thresholdYears = clampYears(years);
  const thresholdDays = thresholdYears * 365;
  const thresholdDate = new Date(now.getTime() - thresholdDays * DAY_MS);

  let site = null;
  if (siteId) {
    site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
    if (!site) { const e: any = new Error('Site not found.'); e.code = 'SITE_NOT_FOUND'; throw e; }
  }
  const assetScope: any = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const [assets, woAgg] = await Promise.all([
    prisma.asset.findMany({
      where: { accountId, ...assetScope },
      select: {
        id: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, criticalityScore: true, createdAt: true,
        site: { select: { name: true } },
        // Active schedule ids only -- length tells us if the asset is on a program.
        schedules: { where: { isActive: true }, select: { id: true } },
      },
    }),
    prisma.workOrder.groupBy({
      by: ['assetId'],
      where: { accountId, status: 'COMPLETE', asset: assetScope },
      _max: { completedDate: true },
    }),
  ]);

  const lastServiceByAsset = new Map<string, Date | null>(
    woAgg.map((r: any) => [r.assetId, r._max.completedDate ? new Date(r._max.completedDate) : null]),
  );

  const untrackedAssets: any[] = [];
  const forgottenAssets: any[] = [];
  let neverServiced = 0;
  let oldestDays = 0;

  for (const a of assets) {
    const activeScheduleCount = a.schedules ? a.schedules.length : 0;
    const lastService = lastServiceByAsset.get(a.id) || null;
    const daysSinceService = lastService ? Math.floor((now.getTime() - lastService.getTime()) / DAY_MS) : null;

    const row = {
      assetId: a.id,
      label: assetLabel(a),
      equipmentType: a.equipmentType,
      siteName: a.site ? a.site.name : null,
      criticalityScore: a.criticalityScore ?? null,
      activeScheduleCount,
      lastServiceDate: lastService,
      daysSinceService,
      addedDaysAgo: Math.floor((now.getTime() - new Date(a.createdAt).getTime()) / DAY_MS),
    };

    if (activeScheduleCount === 0) {
      untrackedAssets.push({ ...row, reason: 'No maintenance program (not on any active schedule).' });
      continue;
    }

    // On a program -- is it actually being maintained?
    if (!lastService) {
      neverServiced += 1;
      forgottenAssets.push({ ...row, neverServiced: true, reason: 'On a maintenance program but never serviced (no completed work order).' });
    } else if (lastService < thresholdDate) {
      if (daysSinceService && daysSinceService > oldestDays) oldestDays = daysSinceService;
      forgottenAssets.push({ ...row, neverServiced: false, reason: `Not serviced in over ${thresholdYears} year(s) (last ${daysSinceService}d ago).` });
    }
  }

  // Untracked: highest-criticality first (the dangerous unknowns).
  untrackedAssets.sort((a, b) => (b.criticalityScore || 0) - (a.criticalityScore || 0));
  // Forgotten: never-serviced first, then longest-since-service first.
  forgottenAssets.sort((a, b) => {
    const da = a.daysSinceService == null ? Infinity : a.daysSinceService;
    const db = b.daysSinceService == null ? Infinity : b.daysSinceService;
    if (da !== db) return db - da;
    return (b.criticalityScore || 0) - (a.criticalityScore || 0);
  });
  for (const r of forgottenAssets) {
    if (r.daysSinceService && r.daysSinceService > oldestDays) oldestDays = r.daysSinceService;
  }

  return {
    generatedAt: now,
    scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
    thresholdYears,
    summary: {
      totalAssets: assets.length,
      untracked: untrackedAssets.length,
      forgotten: forgottenAssets.length,
      neverServiced,
      flagged: untrackedAssets.length + forgottenAssets.length,
      oldestDays,
      clean: untrackedAssets.length === 0 && forgottenAssets.length === 0,
    },
    untrackedAssets,
    forgottenAssets,
  };
}

module.exports = { buildForgottenAssets };

export {};
