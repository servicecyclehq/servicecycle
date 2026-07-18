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

// ── 7. 1 / 3 / 5-Year Maintenance Plan ───────────────────────────────────────
// Projects every ACTIVE maintenance schedule forward over a 5-year horizon from
// its task interval + the asset's governing condition, so a customer (or a
// contractor quoting the work) can see the maintenance load coming in Year 1,
// Years 1-3, and Years 1-5 — the "1/3/5-year plan" NFPA 70B programs are built
// around. Pure projection from data already in the system (MaintenanceSchedule
// nextDueDate + MaintenanceTaskDefinition.intervalC{1,2,3}Months); it forecasts
// cadence, it does NOT assert condition or PPE (system of record, not analysis).
const PLAN_HORIZON_YEARS = 5;
const MAX_OCC_PER_SCHEDULE = 240; // safety cap (monthly task over 5 yr = 60)

function addMonths(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setMonth(x.getMonth() + n);
  return x;
}

// Interval (months) that applies for the asset's governing condition. C2 is the
// always-present baseline; C1/C3 are used only when the standard defines a
// condition-specific interval and the asset carries that condition.
function intervalForCondition(td: any, cond: string): number | null {
  if (cond === 'C1' && td.intervalC1Months) return td.intervalC1Months;
  if (cond === 'C3' && td.intervalC3Months) return td.intervalC3Months;
  return td.intervalC2Months || null;
}

// EQUIPMENT_TYPE enum -> readable label ("SWITCHGEAR" -> "Switchgear").
function prettyType(t: string): string {
  return String(t || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Cadence in months -> plain English ("12" -> "Annual", "6" -> "Every 6 mo").
function everyLabel(months: number): string {
  if (!months || months <= 0) return '—';
  if (months === 12) return 'Annual';
  if (months === 24) return 'Every 2 yr';
  if (months === 36) return 'Every 3 yr';
  if (months === 60) return 'Every 5 yr';
  if (months % 12 === 0) return `Every ${months / 12} yr`;
  return `Every ${months} mo`;
}

async function buildMultiYearMaintenancePlanReport(prisma: any, accountId: string, opts: any = {}): Promise<any> {
  const now = new Date();
  const horizonEnd = addMonths(now, PLAN_HORIZON_YEARS * 12);
  const siteFilter = opts.siteId ? { siteId: String(opts.siteId) } : {};

  const schedules = await prisma.maintenanceSchedule.findMany({
    where: { accountId, isActive: true, asset: { archivedAt: null, ...siteFilter } },
    select: {
      nextDueDate: true,
      conditionOverride: true,
      asset: {
        select: {
          id: true, siteId: true, equipmentType: true, governingCondition: true,
          manufacturer: true, model: true, serialNumber: true,
          position: { select: { name: true, code: true } },
        },
      },
      taskDefinition: {
        select: {
          taskName: true, standardRef: true, intervalC1Months: true, intervalC2Months: true, intervalC3Months: true,
          requiresOutage: true, requiresNetaCertified: true,
        },
      },
    },
  });

  const sites = await siteNameMap(prisma, accountId);

  const byYear = Array.from({ length: PLAN_HORIZON_YEARS }, (_v, i) => ({
    year: i + 1,
    label: `Year ${i + 1}`,
    tasks: 0, outageTasks: 0, netaTasks: 0,
    _assets: new Set<string>(), _sites: new Set<string>(),
  }));
  const byAsset = new Map<string, any>();
  const bySite = new Map<string, any>();
  const byType = new Map<string, any>();
  // The PLAN itself: one line per active schedule — equipment, task, cadence,
  // and when it's next due. This is what makes the report a maintenance plan
  // rather than a per-year tally.
  const plan: any[] = [];

  let schedulesProjected = 0;
  let schedulesSkipped = 0;

  for (const s of schedules) {
    const td = s.taskDefinition;
    const asset = s.asset;
    if (!td || !asset) { schedulesSkipped++; continue; }
    const cond = s.conditionOverride || asset.governingCondition || 'C2';
    const interval = intervalForCondition(td, cond);
    if (!interval || interval <= 0) { schedulesSkipped++; continue; }

    // First occurrence AT OR AFTER now: overdue schedules roll forward to their
    // next future occurrence (overdue backlog is its own report, not the plan).
    let occ: Date;
    if (s.nextDueDate) {
      occ = new Date(s.nextDueDate);
      let guard = 0;
      while (occ < now && guard < MAX_OCC_PER_SCHEDULE) { occ = addMonths(occ, interval); guard++; }
    } else {
      occ = addMonths(now, interval);
    }

    schedulesProjected++;
    const siteKey = asset.siteId || '__unassigned__';
    const siteName = asset.siteId ? (sites.get(asset.siteId) || 'Unknown site') : 'Unassigned';
    const etype = asset.equipmentType || 'UNKNOWN';

    // Build the plan line item from the FIRST future occurrence (occ, before the
    // projection loop advances it). Label the asset by its position/tag if it
    // has one, else equipment type + make/model.
    const pos = asset.position;
    const makeModel = [asset.manufacturer, asset.model].filter(Boolean).join(' ');
    const assetLabel = (pos && (pos.code || pos.name))
      || (makeModel ? `${prettyType(etype)} — ${makeModel}` : prettyType(etype))
      || etype;
    const firstMonths = (occ.getFullYear() - now.getFullYear()) * 12 + (occ.getMonth() - now.getMonth());
    const firstYear = Math.min(PLAN_HORIZON_YEARS, Math.max(1, Math.floor(firstMonths / 12) + 1));
    plan.push({
      dueDate: occ.toISOString().slice(0, 10),
      year: firstYear,
      site: siteName,
      asset: assetLabel,
      serial: asset.serialNumber || null,
      equipmentType: etype,
      task: td.taskName,
      standardRef: td.standardRef || null,
      everyMonths: interval,
      cadence: everyLabel(interval),
      requiresOutage: !!td.requiresOutage,
      requiresNeta: !!td.requiresNetaCertified,
    });

    let count = 0;
    while (occ <= horizonEnd && count < MAX_OCC_PER_SCHEDULE) {
      // Calendar-month difference so Year 1 = months 0-11, Year 2 = 12-23, etc.
      // (a task due at exactly the 12-month mark is Year 2, not a rounding edge).
      const monthsFromNow = (occ.getFullYear() - now.getFullYear()) * 12 + (occ.getMonth() - now.getMonth());
      const yIdx = Math.min(PLAN_HORIZON_YEARS - 1, Math.max(0, Math.floor(monthsFromNow / 12)));
      if (yIdx >= 0) {
        const yb = byYear[yIdx];
        yb.tasks++;
        if (td.requiresOutage) yb.outageTasks++;
        if (td.requiresNetaCertified) yb.netaTasks++;
        yb._assets.add(asset.id);
        yb._sites.add(siteKey);

        if (!byAsset.has(asset.id)) byAsset.set(asset.id, { assetId: asset.id, siteName, equipmentType: etype, y1: 0, y3: 0, y5: 0 });
        const ab = byAsset.get(asset.id);
        if (yIdx < 1) ab.y1++;
        if (yIdx < 3) ab.y3++;
        ab.y5++;

        if (!bySite.has(siteKey)) bySite.set(siteKey, { siteId: asset.siteId || null, siteName, y1: 0, y3: 0, y5: 0 });
        const sb = bySite.get(siteKey);
        if (yIdx < 1) sb.y1++;
        if (yIdx < 3) sb.y3++;
        sb.y5++;

        if (!byType.has(etype)) byType.set(etype, { equipmentType: etype, y1: 0, y3: 0, y5: 0 });
        const tb = byType.get(etype);
        if (yIdx < 1) tb.y1++;
        if (yIdx < 3) tb.y3++;
        tb.y5++;
      }
      occ = addMonths(occ, interval);
      count++;
    }
  }

  const byYearRows = byYear.map((y) => ({
    year: y.year, label: y.label,
    tasks: y.tasks, outageTasks: y.outageTasks, netaTasks: y.netaTasks,
    assets: y._assets.size, sites: y._sites.size,
  }));

  const oneYearTasks = byYearRows[0] ? byYearRows[0].tasks : 0;
  const threeYearTasks = byYearRows.slice(0, 3).reduce((sum, y) => sum + y.tasks, 0);
  const fiveYearTasks = byYearRows.reduce((sum, y) => sum + y.tasks, 0);

  return {
    generatedAt: now,
    horizonYears: PLAN_HORIZON_YEARS,
    summary: {
      oneYearTasks, threeYearTasks, fiveYearTasks,
      assetsPlanned: byAsset.size,
      sitesPlanned: bySite.size,
      schedulesProjected, schedulesSkipped,
    },
    byYear: byYearRows,
    byEquipmentType: Array.from(byType.values()).sort((a, b) => b.y5 - a.y5),
    bySite: Array.from(bySite.values()).sort((a, b) => b.y5 - a.y5),
    byAsset: Array.from(byAsset.values()).sort((a, b) => b.y5 - a.y5).slice(0, 500),
    // The line-by-line plan: every active schedule, earliest-due first.
    plan: plan.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)).slice(0, 500),
  };
}

module.exports = {
  buildDeficiencySummaryReport,
  buildOverdueWorkOrdersReport,
  buildFailedTestRecapReport,
  buildInstalledBaseAgeByOemReport,
  buildAssetRulWatchlistReport,
  buildArcFlashCoverageReport,
  buildMultiYearMaintenancePlanReport,
};

export {};
