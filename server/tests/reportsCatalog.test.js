'use strict';

/**
 * lib/reportsCatalog — pure-core unit tests for the six /api/reports/* named
 * reports shipped 2026-07-05 (§9). Every function takes a mocked prisma
 * client (no real DB) and asserts on the aggregation/shape it returns.
 */

const {
  buildDeficiencySummaryReport,
  buildOverdueWorkOrdersReport,
  buildFailedTestRecapReport,
  buildInstalledBaseAgeByOemReport,
  buildAssetRulWatchlistReport,
  buildArcFlashCoverageReport,
  buildMultiYearMaintenancePlanReport,
} = require('../lib/reportsCatalog');

// Shared site lookup every report calls once via siteNameMap().
function mockSites() {
  return [
    { id: 'site-1', name: 'Plant A' },
    { id: 'site-2', name: 'Plant B' },
  ];
}

describe('buildDeficiencySummaryReport', () => {
  test('groups open deficiencies by severity x site', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      deficiency: {
        findMany: jest.fn(async () => [
          { id: 'd1', severity: 'IMMEDIATE', createdAt: new Date(), resolvedAt: null, asset: { id: 'a1', siteId: 'site-1', equipmentType: 'TRANSFORMER' } },
          { id: 'd2', severity: 'ADVISORY', createdAt: new Date(), resolvedAt: null, asset: { id: 'a2', siteId: 'site-1', equipmentType: 'BREAKER' } },
          { id: 'd3', severity: 'RECOMMENDED', createdAt: new Date(), resolvedAt: null, asset: { id: 'a3', siteId: 'site-2', equipmentType: 'SWITCHGEAR' } },
        ]),
      },
    };
    const out = await buildDeficiencySummaryReport(prisma, 'acct-1', {});
    expect(out.summary.total).toBe(3);
    expect(out.summary.IMMEDIATE).toBe(1);
    expect(prisma.deficiency.findMany.mock.calls[0][0].where.resolvedAt).toBe(null);
    const siteA = out.bySite.find((s) => s.siteId === 'site-1');
    expect(siteA.siteName).toBe('Plant A');
    expect(siteA.total).toBe(2);
    expect(siteA.IMMEDIATE).toBe(1);
    expect(siteA.ADVISORY).toBe(1);
  });

  test('includeResolved=true drops the resolvedAt:null filter', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      deficiency: { findMany: jest.fn(async () => []) },
    };
    await buildDeficiencySummaryReport(prisma, 'acct-1', { includeResolved: true });
    expect(prisma.deficiency.findMany.mock.calls[0][0].where.resolvedAt).toBeUndefined();
  });
});

describe('buildOverdueWorkOrdersReport', () => {
  test('groups overdue WOs by site and tracks the oldest due date', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      workOrder: {
        findMany: jest.fn(async () => [
          { id: 'wo1', status: 'SCHEDULED', scheduledDate: new Date('2026-01-01'), workOrderType: 'PREVENTIVE', asset: { id: 'a1', siteId: 'site-1', equipmentType: 'TRANSFORMER', manufacturer: 'GE', model: 'X' } },
          { id: 'wo2', status: 'IN_PROGRESS', scheduledDate: new Date('2026-03-01'), workOrderType: 'CORRECTIVE', asset: { id: 'a2', siteId: 'site-1', equipmentType: 'BREAKER', manufacturer: 'Eaton', model: 'Y' } },
        ]),
      },
    };
    const out = await buildOverdueWorkOrdersReport(prisma, 'acct-1', {});
    expect(out.summary.totalOverdue).toBe(2);
    expect(prisma.workOrder.findMany.mock.calls[0][0].where.status.in).toEqual(
      expect.arrayContaining(['SCHEDULED', 'AWAITING_APPROVAL', 'IN_PROGRESS']),
    );
    const site1 = out.bySite.find((s) => s.siteId === 'site-1');
    expect(site1.count).toBe(2);
    expect(new Date(site1.oldestDueDate).toISOString()).toBe(new Date('2026-01-01').toISOString());
  });
});

describe('buildFailedTestRecapReport', () => {
  test('defaults to RED-only, 90-day window, grouped by measurementType', async () => {
    const prisma = {
      testMeasurement: {
        findMany: jest.fn(async () => [
          { id: 'm1', measurementType: 'insulation_resistance', phase: 'A', asFoundValue: 2, asFoundUnit: 'MΩ', passFail: 'RED', expectedRange: '>=100', createdAt: new Date(), workOrder: { id: 'wo1', assetId: 'a1', asset: { siteId: 'site-1', equipmentType: 'TRANSFORMER' } } },
          { id: 'm2', measurementType: 'insulation_resistance', phase: 'B', asFoundValue: 3, asFoundUnit: 'MΩ', passFail: 'RED', expectedRange: '>=100', createdAt: new Date(), workOrder: { id: 'wo2', assetId: 'a2', asset: { siteId: 'site-2', equipmentType: 'TRANSFORMER' } } },
        ]),
      },
    };
    const out = await buildFailedTestRecapReport(prisma, 'acct-1', {});
    expect(out.windowDays).toBe(90);
    expect(prisma.testMeasurement.findMany.mock.calls[0][0].where.passFail.in).toEqual(['RED']);
    expect(out.summary.total).toBe(2);
    expect(out.byMeasurementType[0].measurementType).toBe('insulation_resistance');
    expect(out.byMeasurementType[0].RED).toBe(2);
  });

  test('includeYellow adds YELLOW to the passFail filter and days clamps to an allowed value', async () => {
    const prisma = { testMeasurement: { findMany: jest.fn(async () => []) } };
    await buildFailedTestRecapReport(prisma, 'acct-1', { includeYellow: true, days: 30 });
    const where = prisma.testMeasurement.findMany.mock.calls[0][0].where;
    expect(where.passFail.in).toEqual(expect.arrayContaining(['RED', 'YELLOW']));
  });

  test('an out-of-range days value falls back to the 90-day default', async () => {
    const prisma = { testMeasurement: { findMany: jest.fn(async () => []) } };
    const out = await buildFailedTestRecapReport(prisma, 'acct-1', { days: 999 });
    expect(out.windowDays).toBe(90);
  });
});

describe('buildInstalledBaseAgeByOemReport', () => {
  test('aggregates asset count + average age by manufacturer', async () => {
    const now = new Date();
    const fiveYearsAgo = new Date(now.getTime() - 5 * 365.25 * 24 * 60 * 60 * 1000);
    const prisma = {
      asset: {
        findMany: jest.fn(async () => [
          { id: 'a1', manufacturer: 'GE', installDate: fiveYearsAgo, equipmentType: 'TRANSFORMER' },
          { id: 'a2', manufacturer: 'GE', installDate: null, equipmentType: 'TRANSFORMER' },
          { id: 'a3', manufacturer: 'Eaton', installDate: fiveYearsAgo, equipmentType: 'BREAKER' },
        ]),
      },
    };
    const out = await buildInstalledBaseAgeByOemReport(prisma, 'acct-1', {});
    expect(out.summary.totalAssets).toBe(3);
    expect(out.summary.manufacturers).toBe(2);
    const ge = out.byManufacturer.find((m) => m.manufacturer === 'GE');
    expect(ge.assetCount).toBe(2);
    expect(ge.assetsMissingInstallDate).toBe(1);
    expect(ge.avgAgeYears).toBeGreaterThan(4.9);
    expect(ge.avgAgeYears).toBeLessThan(5.1);
  });
});

describe('buildAssetRulWatchlistReport', () => {
  test('wraps installedBaseIntel.buildModernizationPipeline unchanged', async () => {
    jest.resetModules();
    jest.doMock('../lib/installedBaseIntel', () => ({
      buildModernizationPipeline: jest.fn(async () => ({
        generatedAt: new Date('2026-07-05'),
        caveat: 'test caveat',
        summary: { act: 1, plan: 2, watch: 3, healthy: 4 },
        rows: [{ assetId: 'a1', band: 'act', score: 0.9 }],
      })),
    }));
    const { buildAssetRulWatchlistReport: freshBuild } = require('../lib/reportsCatalog');
    const out = await freshBuild({}, 'acct-1', {});
    expect(out.summary).toEqual({ act: 1, plan: 2, watch: 3, healthy: 4 });
    expect(out.watchlist).toEqual([{ assetId: 'a1', band: 'act', score: 0.9 }]);
    jest.dontMock('../lib/installedBaseIntel');
  });
});

describe('buildArcFlashCoverageReport', () => {
  test('diffs assets against current arc-flash study coverage, by site', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      asset: {
        findMany: jest.fn(async () => [
          { id: 'a1', siteId: 'site-1', equipmentType: 'TRANSFORMER' },
          { id: 'a2', siteId: 'site-1', equipmentType: 'BREAKER' },
          { id: 'a3', siteId: 'site-2', equipmentType: 'SWITCHGEAR' },
        ]),
      },
      systemStudyAsset: {
        findMany: jest.fn(async () => [{ assetId: 'a1' }]),
      },
    };
    const out = await buildArcFlashCoverageReport(prisma, 'acct-1', {});
    expect(out.summary.totalAssets).toBe(3);
    expect(out.summary.covered).toBe(1);
    expect(out.summary.uncovered).toBe(2);
    const site1 = out.bySite.find((s) => s.siteId === 'site-1');
    expect(site1.covered).toBe(1);
    expect(site1.uncovered).toBe(1);
    expect(site1.uncoveredAssetIds).toEqual(['a2']);
    // Studies must be filtered to non-superseded arc_flash studies only.
    const studyWhere = prisma.systemStudyAsset.findMany.mock.calls[0][0].where;
    expect(studyWhere.study.supersededById).toBe(null);
    expect(studyWhere.study.studyType).toBe('arc_flash');
  });
});

describe('buildMultiYearMaintenancePlanReport', () => {
  const plusMonths = (n) => { const d = new Date(); d.setMonth(d.getMonth() + n); return d; };

  test('projects active schedules across 1/3/5-year horizons; skips broken rows', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      maintenanceSchedule: {
        findMany: jest.fn(async () => [
          // 12-month interval, first due in 3 months -> one occurrence per year
          { nextDueDate: plusMonths(3), conditionOverride: null,
            asset: { id: 'a1', siteId: 'site-1', equipmentType: 'SWITCHGEAR', governingCondition: 'C2' },
            taskDefinition: { taskName: 'IR', intervalC1Months: null, intervalC2Months: 12, intervalC3Months: null, requiresOutage: true, requiresNetaCertified: true } },
          // 6-month interval, no nextDueDate -> first occurrence at +6 months
          { nextDueDate: null, conditionOverride: null,
            asset: { id: 'a2', siteId: 'site-1', equipmentType: 'MCC', governingCondition: 'C2' },
            taskDefinition: { taskName: 'Thermo', intervalC1Months: null, intervalC2Months: 6, intervalC3Months: null, requiresOutage: false, requiresNetaCertified: false } },
          // overdue -> rolls forward to its next future occurrence, still planned
          { nextDueDate: plusMonths(-8), conditionOverride: null,
            asset: { id: 'a3', siteId: 'site-2', equipmentType: 'TRANSFORMER', governingCondition: 'C2' },
            taskDefinition: { taskName: 'DGA', intervalC1Months: null, intervalC2Months: 12, intervalC3Months: null, requiresOutage: false, requiresNetaCertified: false } },
          // missing taskDefinition -> skipped
          { nextDueDate: plusMonths(2), conditionOverride: null,
            asset: { id: 'a4', siteId: 'site-1', equipmentType: 'MCC', governingCondition: 'C2' },
            taskDefinition: null },
          // zero interval -> skipped (cannot project a cadence)
          { nextDueDate: plusMonths(2), conditionOverride: null,
            asset: { id: 'a5', siteId: 'site-1', equipmentType: 'MCC', governingCondition: 'C2' },
            taskDefinition: { taskName: 'x', intervalC1Months: null, intervalC2Months: 0, intervalC3Months: null, requiresOutage: false, requiresNetaCertified: false } },
        ]),
      },
    };
    const out = await buildMultiYearMaintenancePlanReport(prisma, 'acct-1', {});
    expect(out.horizonYears).toBe(5);
    expect(out.byYear).toHaveLength(5);
    expect(out.summary.schedulesProjected).toBe(3);
    expect(out.summary.schedulesSkipped).toBe(2);
    // cumulative horizons are monotonic
    expect(out.summary.oneYearTasks).toBeLessThanOrEqual(out.summary.threeYearTasks);
    expect(out.summary.threeYearTasks).toBeLessThanOrEqual(out.summary.fiveYearTasks);
    // 12-month task -> exactly one occurrence per year
    const a1 = out.byAsset.find((a) => a.assetId === 'a1');
    expect(a1.y1).toBe(1);
    expect(a1.y3).toBe(3);
    expect(a1.y5).toBe(5);
    // 6-month task -> 10 occurrences across five years
    const a2 = out.byAsset.find((a) => a.assetId === 'a2');
    expect(a2.y5).toBe(10);
    // grouping surfaces are populated
    expect(out.byEquipmentType.some((t) => t.equipmentType === 'SWITCHGEAR')).toBe(true);
    expect(out.bySite.some((s) => s.siteName === 'Plant A')).toBe(true);
    expect(out.summary.sitesPlanned).toBe(2);
    // only active + non-archived schedules are queried
    const where = prisma.maintenanceSchedule.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.asset.archivedAt).toBe(null);
  });

  test('uses the condition-specific interval (C3) over the C2 baseline', async () => {
    const prisma = {
      site: { findMany: jest.fn(async () => mockSites()) },
      maintenanceSchedule: {
        findMany: jest.fn(async () => [
          { nextDueDate: plusMonths(1), conditionOverride: null,
            asset: { id: 'a1', siteId: 'site-1', equipmentType: 'PANELBOARD', governingCondition: 'C3' },
            taskDefinition: { taskName: 'Insp', intervalC1Months: 24, intervalC2Months: 12, intervalC3Months: 3, requiresOutage: false, requiresNetaCertified: false } },
        ]),
      },
    };
    const out = await buildMultiYearMaintenancePlanReport(prisma, 'acct-1', {});
    // 3-month cadence (C3) => ~20 occurrences over five years, not 5 (C2=12mo)
    const a1 = out.byAsset.find((a) => a.assetId === 'a1');
    expect(a1.y5).toBeGreaterThanOrEqual(19);
  });
});
