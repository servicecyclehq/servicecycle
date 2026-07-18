/**
 * routes/reports.ts
 * -----------------
 * Compliance report endpoints.
 *
 * GET  /                       -- report catalogue (lists the named reports below)
 * GET  /emp                    -- one-click EMP PDF download (streams bytes directly;
 *                                 ?months=24 controls the work-order lookback window).
 *                                 For the snapshot-pipeline variant (stored, hash-anchored,
 *                                 audit-log entry) use POST /api/compliance/emp-document.
 * GET  /deficiency-summary     -- open deficiencies by severity x site
 * GET  /overdue-wos            -- overdue work orders by site
 * GET  /failed-test-recap      -- measurements outside pass band, last 30/90/365d
 * GET  /installed-base-age     -- asset age + count by manufacturer
 * GET  /rul-watchlist          -- assets nearing end of useful life (Watch/Plan/Act)
 * GET  /arc-flash-coverage     -- assets with vs without a current arc-flash study, by site
 *
 * Each named report (added 2026-07-05, see docs/scoping/audits/reports-landing-
 * inventory.md for the scoping this was built from) returns JSON by default;
 * pass ?format=pdf for a plain tabular PDF (lib/reportsPdf.ts). All are
 * requireManager + tenant-scoped via req.user.accountId, matching the posture
 * of routes/installedBase.ts and routes/sales.ts. Query logic lives in
 * lib/reportsCatalog.ts (pure + testable); routes only parse params, call it,
 * and shape JSON vs PDF.
 *
 * NOT built (see lib/reportsCatalog.ts header comment for why): a
 * "Deferred Maintenance $ Estimate" report (no estimatedCost field on
 * WorkOrder — needs a migration + product decision) and a "Compliance Status
 * by NETA Class" report (no NETA-class field/enum anywhere in the schema).
 *
 * Mounted in server/index.ts as:
 *   app.use('/api/reports', authenticateToken, reportRoutes);
 */

'use strict';

const crypto = require('crypto');
const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { buildEmpData, renderEmpPdf } = require('../lib/empDocument');
const { requireManager } = require('../middleware/roles');
const { renderReportTablePdf, renderReportDocPdf } = require('../lib/reportsPdf');
const { formatTimestamp } = require('../lib/pdfStyle');
const {
  buildDeficiencySummaryReport,
  buildOverdueWorkOrdersReport,
  buildFailedTestRecapReport,
  buildInstalledBaseAgeByOemReport,
  buildAssetRulWatchlistReport,
  buildArcFlashCoverageReport,
  buildMultiYearMaintenancePlanReport,
} = require('../lib/reportsCatalog');

const NAMED_REPORTS = [
  { id: 'deficiency-summary', title: 'Deficiency Summary by Severity × Site', path: '/api/reports/deficiency-summary' },
  { id: 'overdue-wos', title: 'Overdue Work Orders by Site', path: '/api/reports/overdue-wos' },
  { id: 'failed-test-recap', title: 'Failed-Test Recap', path: '/api/reports/failed-test-recap' },
  { id: 'installed-base-age', title: 'Installed-Base Age by OEM', path: '/api/reports/installed-base-age' },
  { id: 'rul-watchlist', title: 'Asset RUL Watchlist', path: '/api/reports/rul-watchlist' },
  { id: 'arc-flash-coverage', title: 'Arc-Flash Coverage by Site', path: '/api/reports/arc-flash-coverage' },
  { id: 'multi-year-plan', title: '1 / 3 / 5-Year Maintenance Plan', path: '/api/reports/multi-year-plan' },
];

// -- GET /api/reports ---------------------------------------------------------
router.get('/', async (_req, res) => {
  return res.json({ success: true, data: { reports: NAMED_REPORTS } });
});

// Small helper: every named-report handler below follows the same
// try/catch -> JSON-or-PDF shape, so factor it once rather than repeating
// six times. `build` is one of the lib/reportsCatalog functions; `pdfShape`
// turns its JSON result into { columns, rows, subtitle } for the PDF path.
function namedReportHandler(build: (prisma: any, accountId: string, opts: any) => Promise<any>, title: string, pdfShape: (data: any) => { columns: any[]; rows: any[]; subtitle?: string }) {
  return async (req: any, res: any) => {
    try {
      const accountId = req.user.accountId;
      const data = await build(prisma, accountId, req.query || {});
      if (String(req.query.format || '').toLowerCase() === 'pdf') {
        const shaped = pdfShape(data);
        return renderReportTablePdf(res, {
          title,
          subtitle: shaped.subtitle,
          generatedAt: data.generatedAt,
          columns: shaped.columns,
          rows: shaped.rows,
        });
      }
      return res.json({ success: true, data });
    } catch (e) {
      console.error(`[reports/${title}] error:`, e);
      return res.status(500).json({ success: false, error: `Failed to build report: ${title}` });
    }
  };
}

// -- GET /api/reports/deficiency-summary --------------------------------------
router.get('/deficiency-summary', requireManager, namedReportHandler(
  buildDeficiencySummaryReport,
  'Deficiency Summary by Severity x Site',
  (data) => ({
    columns: [
      { key: 'siteName', label: 'Site', width: 2 },
      { key: 'IMMEDIATE', label: 'Immediate', width: 1 },
      { key: 'RECOMMENDED', label: 'Recommended', width: 1 },
      { key: 'ADVISORY', label: 'Advisory', width: 1 },
      { key: 'total', label: 'Total', width: 1 },
    ],
    rows: data.bySite,
    subtitle: `${data.summary.total} open deficiencies across ${data.bySite.length} site(s)`,
  }),
));

// -- GET /api/reports/overdue-wos ----------------------------------------------
router.get('/overdue-wos', requireManager, namedReportHandler(
  buildOverdueWorkOrdersReport,
  'Overdue Work Orders by Site',
  (data) => ({
    columns: [
      { key: 'siteName', label: 'Site', width: 2 },
      { key: 'count', label: 'Overdue WOs', width: 1 },
      { key: 'oldestDueDate', label: 'Oldest Due Date', width: 1.5 },
    ],
    rows: data.bySite.map((s: any) => ({ ...s, oldestDueDate: s.oldestDueDate ? new Date(s.oldestDueDate).toISOString().slice(0, 10) : '' })),
    subtitle: `${data.summary.totalOverdue} overdue work orders across ${data.summary.sitesAffected} site(s)`,
  }),
));

// -- GET /api/reports/failed-test-recap ----------------------------------------
router.get('/failed-test-recap', requireManager, namedReportHandler(
  buildFailedTestRecapReport,
  'Failed-Test Recap',
  (data) => ({
    columns: [
      { key: 'measurementType', label: 'Measurement Type', width: 2 },
      { key: 'RED', label: 'Red', width: 1 },
      { key: 'YELLOW', label: 'Yellow', width: 1 },
      { key: 'total', label: 'Total', width: 1 },
    ],
    rows: data.byMeasurementType,
    subtitle: `${data.summary.total} failed readings in the last ${data.windowDays} days`,
  }),
));

// -- GET /api/reports/installed-base-age ---------------------------------------
router.get('/installed-base-age', requireManager, namedReportHandler(
  buildInstalledBaseAgeByOemReport,
  'Installed-Base Age by OEM',
  (data) => ({
    columns: [
      { key: 'manufacturer', label: 'Manufacturer', width: 2 },
      { key: 'assetCount', label: 'Assets', width: 1 },
      { key: 'avgAgeYears', label: 'Avg Age (yrs)', width: 1 },
      { key: 'oldestAgeYears', label: 'Oldest (yrs)', width: 1 },
    ],
    rows: data.byManufacturer,
    subtitle: `${data.summary.totalAssets} assets across ${data.summary.manufacturers} manufacturer(s)`,
  }),
));

// -- GET /api/reports/rul-watchlist ---------------------------------------------
router.get('/rul-watchlist', requireManager, namedReportHandler(
  buildAssetRulWatchlistReport,
  'Asset RUL Watchlist',
  (data) => ({
    columns: [
      { key: 'assetLabel', label: 'Asset', width: 2 },
      { key: 'siteName', label: 'Site', width: 1.5 },
      { key: 'band', label: 'Band', width: 1 },
      { key: 'score', label: 'Risk Score', width: 1 },
    ],
    rows: data.watchlist,
    subtitle: `${data.summary.act} act / ${data.summary.plan} plan / ${data.summary.watch} watch`,
  }),
));

// -- GET /api/reports/arc-flash-coverage ----------------------------------------
router.get('/arc-flash-coverage', requireManager, namedReportHandler(
  buildArcFlashCoverageReport,
  'Arc-Flash Coverage by Site',
  (data) => ({
    columns: [
      { key: 'siteName', label: 'Site', width: 2 },
      { key: 'totalAssets', label: 'Assets', width: 1 },
      { key: 'covered', label: 'Covered', width: 1 },
      { key: 'uncovered', label: 'Uncovered', width: 1 },
      { key: 'coveragePct', label: 'Coverage %', width: 1 },
    ],
    rows: data.bySite,
    subtitle: `${data.summary.coveragePct ?? 0}% fleet coverage (${data.summary.covered}/${data.summary.totalAssets})`,
  }),
));

// -- GET /api/reports/multi-year-plan -----------------------------------------
// 1/3/5-year forward maintenance plan. JSON by default; ?format=pdf renders the
// full "Field Report" plan DOCUMENT (lib/reportsPdf.renderReportDocPdf), not a
// bare table: a program-summary narrative (NFPA 70B §4.2 framing + how the
// intervals are derived), the year-by-year forecast, the line-by-line
// maintenance schedule, then load broken out by site and by equipment type.
// Projects active schedules over a 5-year horizon from each task's
// condition-based interval + the asset's governing condition.
router.get('/multi-year-plan', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const data = await buildMultiYearMaintenancePlanReport(prisma, accountId, req.query || {});

    if (String(req.query.format || '').toLowerCase() !== 'pdf') {
      return res.json({ success: true, data });
    }

    // Masthead context: company (org band) + site scope + generated stamp.
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    let companyName = '';
    try {
      const acct = await prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } });
      companyName = (acct && acct.companyName) || '';
    } catch (_) { /* org line is optional */ }
    let siteScope = 'All sites';
    if (siteId) {
      try {
        const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { name: true } });
        siteScope = site ? site.name : 'Selected site';
      } catch (_) { siteScope = 'Selected site'; }
    }

    const s = data.summary || {};
    const horizon = data.horizonYears || 5;
    const planRows = data.plan || [];
    const capped = planRows.length >= 500;

    const sections = [
      {
        title: 'Program summary',
        aux: `${s.assetsPlanned || 0} assets · ${s.sitesPlanned || 0} site(s)`,
        body: [
          `This maintenance plan projects every active preventive-maintenance schedule across a ${horizon}-year horizon. Each task is scheduled from its asset's governing condition (C1/C2/C3) and the task's condition-based interval — the NFPA 70B §4.2 basis for a documented Electrical Maintenance Program. Items already past due are rolled forward to their next occurrence and are tracked in the Overdue Maintenance report rather than counted here.`,
          `Use the forecast by year (Section 02) for budgeting and staffing, and the maintenance schedule (Section 03) as the working task list. In the schedule, "(outage)" marks de-energized work that requires a planned shutdown and "[NETA]" marks a task that requires a NETA-certified technician.`,
        ],
        stats: [
          { label: 'Horizon', value: `${horizon} yr` },
          { label: 'Assets', value: s.assetsPlanned || 0 },
          { label: 'Sites', value: s.sitesPlanned || 0 },
          { label: 'Year 1', value: s.oneYearTasks || 0 },
          { label: 'Through Yr 3', value: s.threeYearTasks || 0 },
          { label: 'Through Yr 5', value: s.fiveYearTasks || 0 },
        ],
      },
      {
        title: 'Forecast by year',
        aux: 'scheduled tasks per year',
        table: {
          columns: [
            { key: 'year',   label: 'Year',   w: 1.4 },
            { key: 'tasks',  label: 'Tasks',  w: 1, numeric: true },
            { key: 'outage', label: 'Outage', w: 1, numeric: true },
            { key: 'neta',   label: 'NETA',   w: 1, numeric: true },
            { key: 'assets', label: 'Assets', w: 1, numeric: true },
            { key: 'sites',  label: 'Sites',  w: 1, numeric: true },
          ],
          rows: (data.byYear || []).map((y: any) => ({
            year: y.label || `Year ${y.year}`,
            tasks: y.tasks || 0,
            outage: y.outageTasks || 0,
            neta: y.netaTasks || 0,
            assets: y.assets || 0,
            sites: y.sites || 0,
          })),
          emptyText: 'No scheduled tasks fall in the planning horizon.',
        },
      },
      {
        title: 'Maintenance schedule',
        aux: capped
          ? `${planRows.length} line items (first 500, earliest due)`
          : `${planRows.length} line items, earliest due first`,
        table: {
          columns: [
            { key: 'dueDate', label: 'Next Due',        w: 1.05, mono: true },
            { key: 'year',    label: 'Yr',              w: 0.4 },
            { key: 'asset',   label: 'Equipment',       w: 2.1 },
            { key: 'task',    label: 'Maintenance Task', w: 2.1 },
            { key: 'cadence', label: 'Frequency',       w: 0.95 },
            { key: 'site',    label: 'Site',            w: 1.2 },
          ],
          rows: planRows.map((p: any) => ({
            dueDate: p.dueDate,
            year: `Y${p.year}`,
            asset: p.asset,
            task: String(p.task) + (p.requiresOutage ? ' (outage)' : '') + (p.requiresNeta ? ' [NETA]' : ''),
            cadence: p.cadence,
            site: p.site,
          })),
          emptyText: 'No active schedules to plan.',
        },
      },
      {
        title: 'Load by site',
        aux: 'task count in each window',
        table: {
          columns: [
            { key: 'siteName', label: 'Site',         w: 2.4 },
            { key: 'y1',       label: 'Year 1',       w: 1, numeric: true },
            { key: 'y3',       label: 'Through Yr 3', w: 1, numeric: true },
            { key: 'y5',       label: 'Through Yr 5', w: 1, numeric: true },
          ],
          rows: (data.bySite || []).map((r: any) => ({
            siteName: r.siteName, y1: r.y1 || 0, y3: r.y3 || 0, y5: r.y5 || 0,
          })),
          emptyText: 'No sites in the plan.',
        },
      },
      {
        title: 'Load by equipment type',
        aux: 'task count in each window',
        table: {
          columns: [
            { key: 'equipmentType', label: 'Equipment Type', w: 2.4 },
            { key: 'y1',            label: 'Year 1',       w: 1, numeric: true },
            { key: 'y3',            label: 'Through Yr 3', w: 1, numeric: true },
            { key: 'y5',            label: 'Through Yr 5', w: 1, numeric: true },
          ],
          rows: (data.byEquipmentType || []).map((r: any) => ({
            equipmentType: r.equipmentType, y1: r.y1 || 0, y3: r.y3 || 0, y5: r.y5 || 0,
          })),
          emptyText: 'No equipment types in the plan.',
        },
      },
    ];

    const genAt = data.generatedAt instanceof Date ? data.generatedAt : new Date();
    const dateStamp = genAt.toISOString().slice(0, 10);
    return renderReportDocPdf(res, {
      title: '1 / 3 / 5-Year Maintenance Plan',
      org: companyName || undefined,
      metaLines: [siteScope, formatTimestamp(genAt)],
      generatedAt: genAt,
      filename: `Maintenance_Plan_1-3-5yr_${dateStamp}`,
      sections,
    });
  } catch (e) {
    console.error('[reports/multi-year-plan] error:', e);
    return res.status(500).json({ success: false, error: 'Failed to build report: 1 / 3 / 5-Year Maintenance Plan' });
  }
});

// -- GET /api/reports/emp -----------------------------------------------------
// Generates the NFPA 70B Section 4.2 Electrical Maintenance Program document
// as a PDF and streams it directly to the client.  Unlike POST
// /api/compliance/emp-document this path does NOT store the file or write an
// audit-log entry -- it is a lightweight, on-demand download for operators who
// want the document immediately without going through the snapshot pipeline.
//
// Query params:
//   months   (integer, 6-60, default 24)  -- work-order history lookback window
//   accountId  -- IGNORED; tenancy is enforced via req.user.accountId (JWT).
//                 The parameter exists only so callers can describe intent in
//                 query strings without the server acting on untrusted input.
//
// Response: application/pdf with Content-Disposition: attachment and an
// X-EMP-Document-Id header carrying the ephemeral document UUID (useful for
// correlating a downloaded file with a support request).
router.get('/emp', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    // Parse + clamp months (6-60).
    const rawMonths = parseInt(String(req.query.months || '24'), 10);
    const months = Number.isFinite(rawMonths) ? Math.min(60, Math.max(6, rawMonths)) : 24;

    const empData = await buildEmpData(prisma, accountId, { months });

    // Pre-generate a document UUID for the footer and response header.
    // This is ephemeral -- it does NOT correspond to a ComplianceSnapshot row.
    const docId       = crypto.randomUUID();
    const generatedAt = new Date();

    // Look up the requesting user's name for the cover page.
    let generatedByName = req.user.name || null;
    if (!generatedByName && req.user.id) {
      try {
        const u = await prisma.user.findUnique({
          where:  { id: req.user.id },
          select: { name: true },
        });
        generatedByName = u?.name || 'Unknown user';
      } catch (_) { generatedByName = 'Unknown user'; }
    }

    const pdfBuffer = await renderEmpPdf(empData, {
      snapshotId:      docId,
      accountName:     empData.accountName,
      generatedByName: generatedByName || 'Unknown user',
      generatedAtIso:  generatedAt.toISOString(),
    });

    // Build a safe ASCII filename:  EMP_AccountName_YYYY-MM-DD.pdf
    const safeName = (empData.accountName || 'Account')
      .replace(/[^\w\s-]/g, '')   // strip non-ASCII
      .replace(/\s+/g, '_')       // spaces to underscores
      .slice(0, 64);
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const filename  = `EMP_${safeName}_${dateStamp}.pdf`;

    const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const rfc5987   = encodeURIComponent(filename);

    res.set('Content-Type',           'application/pdf');
    res.set('Content-Disposition',    `attachment; filename="${safeAscii}"; filename*=UTF-8''${rfc5987}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length',         String(pdfBuffer.length));
    res.set('Cache-Control',          'private, no-store');
    res.set('X-EMP-Document-Id',      docId);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[reports/emp]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate EMP document.' });
  }
});

module.exports = router;

export {};
