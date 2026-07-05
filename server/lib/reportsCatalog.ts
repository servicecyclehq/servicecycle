'use strict';

/**
 * lib/reportsCatalog.ts
 * ----------------------
 * Backend query logic for the /api/reports/* named-report endpoints (2026-07-05,
 * §9 of the overnight ingest-hardening session — see
 * docs/scoping/audits/reports-landing-inventory.md for the full inventory this
 * was scoped from). Pure + testable: every function takes a prisma client +
 * accountId (+ opts) and returns a plain JS object, so tests mock prisma and
 * never touch a real DB. Routes (routes/reports.ts) only parse query params,
 * call these, and shape the HTTP envelope (JSON or PDF).
 *
 * Six reports shipped tonight, in the audit's priority order (cleanest to
 * query first). Two candidates from the same audit were EXPLICITLY NOT built:
 *   - "Deferred Maintenance $ Estimate" — no estimatedCost field exists on
 *     WorkOrder; a true version needs a schema migration, and the only
 *     buildable-today proxy (summing Asset.repairCostEstimate) changes the
 *     semantics from "cost of the deferred work order" to "replacement cost
 *     of the deferred asset" — needs a product decision before building either.
 *   - "Compliance Status by NETA Class" — no NETA-class field/enum exists
 *     anywhere in the schema; cannot be built as specified without a modeling
 *     decision (a real field, or explicitly substituting Asset.equipmentType
 *     as the grouping dimension).
 * Both are flagged here so the gap is visible in the one file future readers
 * will actually open, not just in a dated audit doc.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Work-order statuses that represent "not yet done" for the overdue report.
const OPEN_WO_STATUSES = ['SCHEDULED', 'AWAITING_APPROVAL', 'IN_PROGRESS'];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Shared helper: fetch every Site for the account once, return an id->name map.
// Every report below needs site names but none of the underlying models
// (WorkOrder, Deficiency, TestMeasurement, Asset) carry a direct Site FK —
// site lives on Asset only — so this is looked up once per report call
// rather than N+1'd per row.
async function siteNameMap(prisma: any, accountId: string): Promise<Map<string, string>> {
  const sites = await prisma.site.findMany({
    where: { accountId },
    select: { id: true, name: true },
  });
  const map = new Map<string, string>();
  for (const s of sites) map.set(s.id, s.name);
  return map;
}

// ── 1. Deficiency Summary by Severity × Site ─────────────────────────────────
// Cleanest report in the set: @@index([accountId, severity, resolvedAt])
// already exists on Deficiency for exactly this access pattern.
async function buildDeficiencySummaryReport(prisma: any, accountId: string, opts: any = {}): Promise<any> {
  const includeResolved = !!opts.includeResolved;
  const where: any = { accountId };
  if (!includeResolved) where.resolvedAt = null;

  const rows = await prisma.deficiency.findMany({
    where,
    select: {
      id: true, severity: true, createdAt: true, resolvedAt: true,
      asset: { select: { id: true, siteId: true, equipmentType: true } },
    },
  });

  const sites = await siteNameMap(prisma, accountId);
  const bySite = new Map<string, any>();
  const totals = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };

  for (const d of rows) {
    const siteId = d.asset?.siteId || null;
    const siteName = siteId ? (sites.get(siteId) || 'Unknown site') : 'Unassigned';
    const key = siteId || '__unassigned__';
    if (!bySite.has(key)) {
      bySite.set(key, { siteId, siteName, IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0, total: 0 });
    }
    const bucket = bySite.get(key);
    bucket[d.severity] = (bucket[d.severity] || 0) + 1;
    bucket.total += 1;
    totals[d.severity as keyof typeof totals] = (totals[d.severity as keyof typeof totals] || 0) + 1;
  }

  const siteRows = Array.from(bySite.values()).sort((a, b) => b.IMMEDIATE - a.IMMEDIATE || b.total - a.total);

  return {
    generatedAt: new Date(),
    includeResolved,
    summary: { total: rows.length, ...totals },
    bySite: siteRows,
  };
}

// ── 2. Overdue Work Orders by Site ───────────────────────────────────────────
async function buildOverdueWorkOrdersReport(prisma: any, accountId: string, _opts: any = {}): Promise<any> {
  const now = new Date();
  const rows = await prisma.workOrder.findMany({
    where: {
      accountId,
      status: { in: OPEN_WO_STATUSES },
      scheduledDate: { lt: now },
    },
    select: {
      id: true, status: true, scheduledDate: true, workOrderType: true,
      asset: { select: { id: true, siteId: true, equipmentType: true, manufacturer: true, model: true } },
    },
    orderBy: { scheduledDate: 'asc' },
  });

  const sites = await siteNameMap(prisma, accountId);
  const bySite = new Map<string, any>();

  for (const wo of rows) {
    const siteId = wo.asset?.siteId || null;
    const siteName = siteId ? (sites.get(siteId) || 'Unknown site') : 'Unassigned';
    const key = siteId || '__unassigned__';
    if (!bySite.has(key)) bySite.set(key, { siteId, siteName, count: 0, oldestDueDate: null, workOrders: [] });
    const bucket = bySite.get(key);
    bucket.count += 1;
    const daysOverdue = wo.scheduledDate ? Math.floor((now.getTime() - new Date(wo.scheduledDate).getTime()) / DAY_MS) : null;
    if (!bucket.oldestDueDate || (wo.scheduledDate && new Date(wo.scheduledDate) < new Date(bucket.oldestDueDate))) {
      bucket.oldestDueDate = wo.scheduledDate;
    }
    bucket.workOrders.push({
      id: wo.id, status: wo.status, scheduledDate: wo.scheduledDate, daysOverdue,
      assetId: wo.asset?.id || null, equipmentType: wo.asset?.equipmentType || null,
      manufacturer: wo.asset?.manufacturer || null, model: wo.asset?.model || null,
    });
  }

  const siteRows = Array.from(bySite.values()).sort((a, b) => b.count - a.count);

  return {
    generatedAt: now,
    summary: { totalOverdue: rows.length, sitesAffected: siteRows.length },
    bySite: siteRows,
  };
}

// ── 3. Failed-Test Recap (measurements outside pass band in last N days) ────
async function buildFailedTestRecapReport(prisma: any, accountId: string, opts: any = {}): Promise<any> {
  const days = [30, 90, 365].includes(Number(opts.days)) ? Number(opts.days) : 90;
  const since = new Date(Date.now() - days * DAY_MS);
  const severities = opts.includeYellow ? ['RED', 'YELLOW'] : ['RED'];

  const rows = await prisma.testMeasurement.findMany({
    where: {
      accountId,
      deletedAt: null,
      passFail: { in: severities },
      createdAt: { gte: since },
    },
    select: {
      id: true, measurementType: true, phase: true, asFoundValue: true, asFoundUnit: true,
      passFail: true, expectedRange: true, createdAt: true,
      workOrder: { select: { id: true, assetId: true, asset: { select: { siteId: true, equipmentType: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 2000, // hard cap — this is a recap, not a full export
  });

  const byType = new Map<string, { measurementType: string; RED: number; YELLOW: number; total: number }>();
  for (const m of rows) {
    if (!byType.has(m.measurementType)) {
      byType.set(m.measurementType, { measurementType: m.measurementType, RED: 0, YELLOW: 0, total: 0 });
    }
    const bucket = byType.get(m.measurementType)!;
    (bucket as any)[m.passFail] = ((bucket as any)[m.passFail] || 0) + 1;
    bucket.total += 1;
  }

  const byTypeRows = Array.from(byType.values()).sort((a, b) => b.total - a.total);

  return {
    generatedAt: new Date(),
    windowDays: days,
    includeYellow: !!opts.includeYellow,
    summary: { total: rows.length, byMeasurementType: byTypeRows.length },
    byMeasurementType: byTypeRows,
    readings: rows.slice(0, 200).map((m: any) => ({
      id: m.id, measurementType: m.measurementType, phase: m.phase,
      asFoundValue: m.asFoundValue, asFoundUnit: m.asFoundUnit, passFail: m.passFail,
      expectedRange: m.expectedRange, createdAt: m.createdAt,
      assetId: m.workOrder?.assetId || null, siteId: m.workOrder?.asset?.siteId || null,
      equipmentType: m.workOrder?.asset?.equipmentType || null,
    })),
    truncated: rows.length >= 2000,
  };
}

// ── 4. Installed-Base Age by OEM ─────────────────────────────────────────────
// Re-aggregation, not new plumbing — same Asset fields /installed-base already
// fetches for the modernization pipeline, grouped by manufacturer instead of
// by individual asset.
async function buildInstalledBaseAgeByOemReport(prisma: any, accountId: string, _opts: any = {}): Promise<any> {
  const now = new Date();
  const assets = await prisma.asset.findMany({
    where: { accountId, archivedAt: null },
    select: { id: true, manufacturer: true, installDate: true, equipmentType: true },
  });

  const byOem = new Map<string, { manufacturer: string; count: number; withInstallDate: number; ageSumYears: number; oldestYears: number | null }>();
  for (const a of assets) {
    const mfr = a.manufacturer || 'Unknown';
    if (!byOem.has(mfr)) byOem.set(mfr, { manufacturer: mfr, count: 0, withInstallDate: 0, ageSumYears: 0, oldestYears: null });
    const bucket = byOem.get(mfr)!;
    bucket.count += 1;
    if (a.installDate) {
      const ageYears = (now.getTime() - new Date(a.installDate).getTime()) / (365.25 * DAY_MS);
      bucket.withInstallDate += 1;
      bucket.ageSumYears += ageYears;
      if (bucket.oldestYears == null || ageYears > bucket.oldestYears) bucket.oldestYears = ageYears;
    }
  }

  const rows = Array.from(byOem.values())
    .map((b) => ({
      manufacturer: b.manufacturer,
      assetCount: b.count,
      avgAgeYears: b.withInstallDate > 0 ? round1(b.ageSumYears / b.withInstallDate) : null,
      oldestAgeYears: b.oldestYears != null ? round1(b.oldestYears) : null,
      assetsMissingInstallDate: b.count - b.withInstallDate,
    }))
    .sort((a, b) => b.assetCount - a.assetCount);

  return {
    generatedAt: now,
    summary: { totalAssets: assets.length, manufacturers: rows.length },
    byManufacturer: rows,
  };
}

// ── 5. Asset RUL Watchlist ────────────────────────────────────────────────────
// Wraps the already-computed Watch/Plan/Act modernization pipeline
// (lib/installedBaseIntel.ts) rather than re-deriving RUL — two independent
// notions of "remaining useful life" already exist in the codebase
// (modernizationRiskScore, and MaintenanceSchedule.nextDueDate proximity);
// this report surfaces the former since it is already a single stored/derivable
// per-asset score, banded and sorted.
async function buildAssetRulWatchlistReport(prisma: any, accountId: string, _opts: any = {}): Promise<any> {
  const { buildModernizationPipeline } = require('./installedBaseIntel');
  const pipeline = await buildModernizationPipeline(prisma, accountId);
  return {
    generatedAt: pipeline.generatedAt,
    caveat: pipeline.caveat,
    summary: pipeline.summary,
    // "Watchlist" = anything the pipeline already flagged as non-healthy
    // (act/plan/watch bands), already sorted worst-first.
    watchlist: pipeline.rows,
  };
}

// ── 6. Arc-Flash Coverage by Site ────────────────────────────────────────────
// "Assets with zero current arc-flash coverage" is an anti-join Prisma can't
// express directly — fetch both sides and diff in JS (the audit's documented
// approach; a raw-SQL LEFT JOIN ... IS NULL would be faster at scale but this
// keeps the report portable and testable with mocked prisma).
async function buildArcFlashCoverageReport(prisma: any, accountId: string, _opts: any = {}): Promise<any> {
  const [assets, studyAssets] = await Promise.all([
    prisma.asset.findMany({
      where: { accountId, archivedAt: null },
      select: { id: true, siteId: true, equipmentType: true },
    }),
    // "Current" = belongs to a study that hasn't been superseded — same
    // filter routes/arcFlashIngest.ts already uses for its /report endpoint.
    prisma.systemStudyAsset.findMany({
      where: { accountId, study: { supersededById: null, studyType: 'arc_flash' } },
      select: { assetId: true },
    }),
  ]);

  const covered = new Set(studyAssets.map((sa: any) => sa.assetId));
  const sites = await siteNameMap(prisma, accountId);
  const bySite = new Map<string, any>();

  for (const a of assets) {
    const siteId = a.siteId || null;
    const siteName = siteId ? (sites.get(siteId) || 'Unknown site') : 'Unassigned';
    const key = siteId || '__unassigned__';
    if (!bySite.has(key)) bySite.set(key, { siteId, siteName, totalAssets: 0, covered: 0, uncovered: 0, uncoveredAssetIds: [] });
    const bucket = bySite.get(key);
    bucket.totalAssets += 1;
    if (covered.has(a.id)) bucket.covered += 1;
    else { bucket.uncovered += 1; bucket.uncoveredAssetIds.push(a.id); }
  }

  const siteRows = Array.from(bySite.values())
    .map((b) => ({ ...b, coveragePct: b.totalAssets > 0 ? Math.round((b.covered / b.totalAssets) * 1000) / 10 : null }))
    .sort((a, b) => a.coveragePct - b.coveragePct);

  return {
    generatedAt: new Date(),
    summary: {
      totalAssets: assets.length,
      covered: covered.size,
      uncovered: assets.length - covered.size,
      coveragePct: assets.length > 0 ? Math.round((covered.size / assets.length) * 1000) / 10 : null,
    },
    bySite: siteRows,
  };
}

module.exports = {
  buildDeficiencySummaryReport,
  buildOverdueWorkOrdersReport,
  buildFailedTestRecapReport,
  buildInstalledBaseAgeByOemReport,
  buildAssetRulWatchlistReport,
  buildArcFlashCoverageReport,
};

export {};
