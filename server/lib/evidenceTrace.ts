'use strict';

/**
 * evidenceTrace.ts — #2 Evidence-to-requirement trace map + evidence-gap detector.
 *
 * Every active MaintenanceSchedule (asset × task definition) is a 70B program
 * requirement. The "evidence" that satisfies it is the latest COMPLETE work
 * order on that schedule — and NETA MTS-grade evidence means a recorded result
 * (decal / as-left), measurements, and calibrated-instrument provenance. This
 * maps requirement → evidence per asset and flags what's missing, so:
 *   - the customer can see, at audit time, exactly which tests back which
 *     requirement (and which have no record), and
 *   - the contractor gets a ready list of missing tests to quote.
 *
 * Evidence tiers per requirement:
 *   documented   — a completed WO exists and the requirement is not overdue
 *   stale        — a completed WO exists but the requirement is now overdue
 *   undocumented — a last-service date is recorded but NO completed WO/test on
 *                  file (claimed done, no torque log / IR scan to prove it)
 *   missing      — no completion of any kind
 * Anything but "documented" is an evidence GAP.
 *
 *   buildAssetEvidenceTrace(prisma, accountId, assetId)        -> per-asset map
 *   buildEvidenceGapSummary(prisma, accountId, { siteId? })    -> account/site roll-up
 */

const DAY_MS = 86_400_000;

function assetLabel(a: any): string {
  if (!a) return 'Asset';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType || 'Asset');
}

// Classify one schedule's evidence tier from its latest completed WO + dates.
function evidenceStatusOf(schedule: any, latestWo: any, now: Date): string {
  const hasWo = !!latestWo;
  const hasCompletion = hasWo || !!schedule.lastCompletedDate;
  if (!hasCompletion) return 'missing';
  if (!hasWo) return 'undocumented';
  if (schedule.nextDueDate && new Date(schedule.nextDueDate) < now) return 'stale';
  return 'documented';
}

function isGap(status: string): boolean {
  return status !== 'documented';
}

// Shared select for a schedule + its latest completed WO (the evidence).
const TRACE_SELECT = {
  id: true, nextDueDate: true, lastCompletedDate: true, assetId: true,
  taskDefinition: { select: { taskName: true, taskCode: true, standardRef: true, requiresOutage: true } },
  workOrders: {
    where: { status: 'COMPLETE' },
    orderBy: { completedDate: 'desc' as const },
    take: 1,
    select: {
      id: true, completedDate: true, netaDecal: true, asFoundCondition: true,
      asLeftCondition: true, reportPdfUrl: true, testEquipment: true,
      _count: { select: { measurements: true, documents: true } },
    },
  },
};

function evidenceShape(wo: any) {
  if (!wo) return null;
  const measurementCount = wo._count?.measurements ?? 0;
  const docCount = wo._count?.documents ?? 0;
  const hasInstrumentProvenance = Array.isArray(wo.testEquipment) ? wo.testEquipment.length > 0 : !!wo.testEquipment;
  return {
    workOrderId: wo.id,
    completedDate: wo.completedDate,
    netaDecal: wo.netaDecal,
    asFoundCondition: wo.asFoundCondition,
    asLeftCondition: wo.asLeftCondition,
    measurementCount,
    hasInstrumentProvenance,
    reportOnFile: !!wo.reportPdfUrl || docCount > 0,
  };
}

/**
 * Per-asset requirement → evidence map. Account-scoped (throws ASSET_NOT_FOUND
 * for a missing / cross-tenant asset, mapped to 404 by the route).
 */
async function buildAssetEvidenceTrace(prisma: any, accountId: string, assetId: string) {
  const now = new Date();
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, accountId, archivedAt: null },
    select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, site: { select: { name: true } } },
  });
  if (!asset) { const e: any = new Error('Asset not found.'); e.code = 'ASSET_NOT_FOUND'; throw e; }

  const schedules = await prisma.maintenanceSchedule.findMany({
    where: { accountId, assetId, isActive: true },
    select: TRACE_SELECT,
    orderBy: { nextDueDate: 'asc' },
  });

  const counts = { documented: 0, stale: 0, undocumented: 0, missing: 0 };
  const requirements = schedules.map((s: any) => {
    const wo = s.workOrders && s.workOrders.length ? s.workOrders[0] : null;
    const status = evidenceStatusOf(s, wo, now);
    counts[status as keyof typeof counts] += 1;
    const overdue = !!(s.nextDueDate && new Date(s.nextDueDate) < now);
    return {
      scheduleId: s.id,
      taskName: s.taskDefinition?.taskName ?? 'Task',
      taskCode: s.taskDefinition?.taskCode ?? null,
      standardRef: s.taskDefinition?.standardRef ?? null,
      requiresOutage: s.taskDefinition?.requiresOutage ?? false,
      nextDueDate: s.nextDueDate,
      lastCompletedDate: s.lastCompletedDate,
      overdue,
      daysOverdue: overdue ? Math.floor((now.getTime() - new Date(s.nextDueDate).getTime()) / DAY_MS) : 0,
      evidenceStatus: status,
      isGap: isGap(status),
      evidence: evidenceShape(wo),
    };
  });

  // Gaps first (missing → undocumented → stale → documented), then by name.
  const RANK: any = { missing: 0, undocumented: 1, stale: 2, documented: 3 };
  requirements.sort((a, b) => (RANK[a.evidenceStatus] - RANK[b.evidenceStatus]) || String(a.taskName).localeCompare(String(b.taskName)));

  return {
    generatedAt: now,
    asset: { id: asset.id, label: assetLabel(asset), equipmentType: asset.equipmentType, siteName: asset.site?.name ?? null },
    requirements,
    summary: {
      requirements: requirements.length,
      ...counts,
      gapTotal: counts.stale + counts.undocumented + counts.missing,
      fullyDocumented: requirements.length > 0 && counts.documented === requirements.length,
    },
  };
}

/**
 * Account- (or site-) wide evidence-gap roll-up: how much of the program is
 * backed by documented evidence, which test types are most under-evidenced, and
 * which assets have the biggest gaps (the contractor's upsell list).
 */
async function buildEvidenceGapSummary(prisma: any, accountId: string, { siteId = null, topAssetsLimit = 25 }: { siteId?: string | null; topAssetsLimit?: number } = {}) {
  const now = new Date();
  let site = null;
  if (siteId) {
    site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
    if (!site) { const e: any = new Error('Site not found.'); e.code = 'SITE_NOT_FOUND'; throw e; }
  }
  const assetScope: any = { archivedAt: null, inService: true, ...(siteId ? { siteId } : {}) };

  const schedules = await prisma.maintenanceSchedule.findMany({
    where: { accountId, isActive: true, asset: assetScope },
    select: {
      ...TRACE_SELECT,
      asset: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true, site: { select: { name: true } } } },
    },
  });

  const counts = { documented: 0, stale: 0, undocumented: 0, missing: 0 };
  const byType = new Map<string, { taskCode: string; taskName: string; requirements: number; gaps: number }>();
  const byAsset = new Map<string, { assetId: string; assetLabel: string; siteName: string | null; requirements: number; gaps: number }>();

  for (const s of schedules) {
    const wo = s.workOrders && s.workOrders.length ? s.workOrders[0] : null;
    const status = evidenceStatusOf(s, wo, now);
    counts[status as keyof typeof counts] += 1;
    const gap = isGap(status) ? 1 : 0;

    const code = s.taskDefinition?.taskCode || s.taskDefinition?.taskName || 'task';
    let t = byType.get(code);
    if (!t) { t = { taskCode: code, taskName: s.taskDefinition?.taskName ?? code, requirements: 0, gaps: 0 }; byType.set(code, t); }
    t.requirements += 1; t.gaps += gap;

    const a = s.asset;
    let r = byAsset.get(s.assetId);
    if (!r) { r = { assetId: s.assetId, assetLabel: assetLabel(a), siteName: a?.site?.name ?? null, requirements: 0, gaps: 0 }; byAsset.set(s.assetId, r); }
    r.requirements += 1; r.gaps += gap;
  }

  const total = schedules.length;
  const gapTotal = counts.stale + counts.undocumented + counts.missing;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  const byRequirementType = [...byType.values()].filter((t) => t.gaps > 0).sort((a, b) => b.gaps - a.gaps);
  // 2026-07-13: default 25 preserves existing callers (the dashboard card).
  // auditFindings.ts passes a much larger topAssetsLimit for its "show every
  // matching asset" drill-down page -- see fullKind there.
  const topAssets = [...byAsset.values()].filter((a) => a.gaps > 0).sort((a, b) => b.gaps - a.gaps).slice(0, topAssetsLimit);

  return {
    generatedAt: now,
    scope: { siteId: site?.id ?? null, siteName: site?.name ?? null },
    totals: {
      requirements: total,
      documented: counts.documented,
      stale: counts.stale,
      undocumented: counts.undocumented,
      missing: counts.missing,
      gapTotal,
    },
    documentedPct: pct(counts.documented),
    byRequirementType,
    topAssets,
    fullyDocumented: total > 0 && gapTotal === 0,
  };
}

module.exports = { buildAssetEvidenceTrace, buildEvidenceGapSummary };

export {};
