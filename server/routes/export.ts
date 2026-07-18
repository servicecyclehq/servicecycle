// ─────────────────────────────────────────────────────────────────────────────
// routes/export.js — unified Export-current-view (assets + work orders).
//
// GET /api/export/xlsx?view=assets|workorders&format=xlsx|csv&...filters
//
// Mounted behind authenticateToken + exportLimiter (10/min/user) in
// server/index.js. Streams an XLSX (default) or CSV of the current list
// view, honouring the same multi-value column-filter params the list pages
// use, plus a `columns=` CSV projection.
//
// Asset columns:      site, equipmentType, manufacturer, model, serialNumber,
//                     governingCondition, inService, nextDue (earliest active
//                     schedule due date).
// Work-order columns: asset, site, contractor, status, scheduledDate,
//                     completedDate, netaDecal.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
// sendXlsx lives in server/lib/xlsxExport.js so report routes can reuse the
// same workbook builder without duplicating ExcelJS plumbing.
const { sendXlsx, sendAccountXlsx } = require('../lib/xlsxExport');
const { renderReportTablePdf } = require('../lib/reportsPdf');
const { buildAccountExport, streamAccountExportJson, EXPORT_SHEETS } = require('../lib/accountExport');
const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
import prisma from '../lib/prisma';

// Pure helper functions — extracted to lib/exportHelpers.js so they can be
// unit-tested without pulling in Prisma or Express.
const {
  BLANK_SENTINEL,
  dateStamp,
  dateRangeClause,
  parseList,
  filterToRequestedColumns,
  earliestNextDue,
  sendCsv,
} = require('../lib/exportHelpers');

const router = express.Router();

// COMP-8-2: the export is pitched as a "complete, portable snapshot / no
// lock-in". The previous behaviour silently sliced at 5,000 rows and only set
// an X-Truncated header the UI never surfaced — a 25k-asset utility got 5,000
// rows and no warning. We now CURSOR-PAGINATE the DB read in PAGE_SIZE batches
// so the export contains the full result set, bounded only by a high safety
// ceiling (EXPORT_HARD_CEILING) that exists purely to protect a single node
// from an absurd request. Realistic datasets (single contractor, 120-site
// book) are never truncated. If the ceiling is genuinely hit we (a) set
// X-Truncated and (b) append a visible warning row to the file itself so the
// truncation can never be silent.
const PAGE_SIZE = 2000;
const EXPORT_HARD_CEILING = 250_000;

// Cursor-paginate a Prisma model into a single in-memory array, capped at
// EXPORT_HARD_CEILING+1 so we can still detect (and surface) the extreme case.
// `id` is the stable cursor for every model here.
async function fetchAllPaged(model: any, { where, include, orderBy }: any): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  let cursor: any = null;
  for (;;) {
    const page = await model.findMany({
      where,
      include,
      orderBy: [...orderBy, { id: 'asc' }], // tie-break on id so the cursor is deterministic
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (rows.length > EXPORT_HARD_CEILING) {
      return { rows: rows.slice(0, EXPORT_HARD_CEILING), truncated: true };
    }
    cursor = page[page.length - 1].id;
  }
  return { rows, truncated: false };
}

// COMP-8-2: when the hard ceiling truncates the result set, append a sentinel
// row whose FIRST column renders an explicit warning, so the truncation is
// visible IN the file (not just an X-Truncated header the UI ignores). Returns
// the columnDefs to use (a shallow clone with the first column's getter wrapped
// to emit the notice for the sentinel) — we must NOT mutate the passed array's
// objects because filterToRequestedColumns can hand back the shared module-level
// registry by reference, which would leak the wrapper into later requests.
// No-op (returns columnDefs unchanged) when not truncated.
function appendTruncationRow(rows, columnDefs, truncated, ceiling) {
  if (!truncated || !columnDefs.length) return columnDefs;
  const realGet = columnDefs[0].get;
  const wrappedFirst = {
    ...columnDefs[0],
    get: (r) => (r && r.__truncationNotice
      ? `*** TRUNCATED: export exceeded ${ceiling.toLocaleString()} rows — this file is INCOMPLETE. Filter the view (by site/date) and export in parts, or contact ServiceCycle for a full data extract. ***`
      : realGet(r)),
  };
  rows.push({ __truncationNotice: true });
  return [wrappedFirst, ...columnDefs.slice(1)];
}

// Equipment-type label passthrough — enum codes are already operator-facing
// (TRANSFORMER_LIQUID etc.); render them verbatim so the export round-trips
// into the CSV importer without a label-mapping table.

// ── ASSETS view ──────────────────────────────────────────────────────────────

const ASSETS_COLUMN_REGISTRY = [
  { id: 'site',               header: 'Site',                type: 'string', get: a => a.site?.name,          width: 24 },
  { id: 'equipmentType',      header: 'Equipment Type',      type: 'string', get: a => a.equipmentType,       width: 22 },
  { id: 'manufacturer',       header: 'Manufacturer',        type: 'string', get: a => a.manufacturer,        width: 20 },
  { id: 'model',              header: 'Model',               type: 'string', get: a => a.model,               width: 20 },
  { id: 'serialNumber',       header: 'Serial Number',       type: 'string', get: a => a.serialNumber,        width: 20 },
  { id: 'governingCondition', header: 'Condition',           type: 'string', get: a => a.governingCondition,  width: 12 },
  { id: 'inService',          header: 'In Service',          type: 'string', get: a => a.inService ? 'Yes' : 'No', width: 12 },
  { id: 'nextDue',            header: 'Next Due',            type: 'date',   get: a => earliestNextDue(a),    width: 12 },
];

// Applies canonical multi-value column-filter params to the assets Prisma
// where object. Mirrors the AssetsList filter param shape.
function applyAssetColumnFilters(where, params) {
  const siteList = parseList(params.siteIn);
  if (siteList.length > 0) {
    where.AND = [...(where.AND || []), { site: { name: { in: siteList } } }];
  }
  const typeList = parseList(params.equipmentTypeIn);
  if (typeList.length > 0) {
    where.AND = [...(where.AND || []), { equipmentType: { in: typeList } }];
  }
  const conditionList = parseList(params.conditionIn);
  if (conditionList.length > 0) {
    where.AND = [...(where.AND || []), { governingCondition: { in: conditionList } }];
  }
  for (const [param, field] of [['manufacturerIn', 'manufacturer'], ['modelIn', 'model'], ['serialNumberIn', 'serialNumber']]) {
    const list = parseList(params[param]);
    if (list.length > 0) {
      const wb = list.includes(BLANK_SENTINEL), rl = list.filter(v => v !== BLANK_SENTINEL), ors = [];
      if (rl.length > 0) ors.push({ [field]: { in: rl } });
      if (wb) ors.push({ OR: [{ [field]: null }, { [field]: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  const inServiceList = parseList(params.inServiceIn);
  if (inServiceList.length > 0) {
    if (inServiceList.includes('Yes') && !inServiceList.includes('No'))      where.inService = true;
    else if (inServiceList.includes('No') && !inServiceList.includes('Yes')) where.inService = false;
  }
}

async function exportAssets(req, res) {
  const where: any = { accountId: req.user.accountId };

  // ?archived=1 flips the WHERE clause so the same endpoint can serve the
  // archived-assets page export without a separate route.
  const archivedFlag = String(req.query.archived || '').toLowerCase();
  const wantArchived = archivedFlag === '1' || archivedFlag === 'true';
  where.archivedAt = wantArchived ? { not: null } : null;

  if (req.query.siteId) where.siteId = String(req.query.siteId);

  if (req.query.search) {
    const search = String(req.query.search);
    where.OR = [
      { manufacturer: { contains: search, mode: 'insensitive' } },
      { model:        { contains: search, mode: 'insensitive' } },
      { serialNumber: { contains: search, mode: 'insensitive' } },
      { site: { name: { contains: search, mode: 'insensitive' } } },
    ];
  }

  applyAssetColumnFilters(where, req.query);

  req.setTimeout(300_000);
  const { rows: assets, truncated } = await fetchAllPaged(prisma.asset, {
    where,
    include: {
      site: { select: { name: true } },
      schedules: {
        where:  { isActive: true, nextDueDate: { not: null } },
        select: { nextDueDate: true },
        orderBy: { nextDueDate: 'asc' },
        take: 1,
      },
    },
    orderBy: [{ siteId: 'asc' }, { equipmentType: 'asc' }],
  });
  if (truncated) res.setHeader('X-Truncated', '1');

  // COMP-8-2: never truncate silently — if the hard ceiling was hit, append a
  // visible warning row so the file itself says so (the X-Truncated header
  // alone was invisible to the user). appendTruncationRow returns the columnDefs
  // to render (wrapped first getter when truncated, unchanged otherwise).
  const columnDefs = appendTruncationRow(
    assets, filterToRequestedColumns(ASSETS_COLUMN_REGISTRY, req.query.columns), truncated, EXPORT_HARD_CEILING,
  );

  if (String(req.query.format || '').toLowerCase() === 'pdf') {
    return renderReportTablePdf(res, {
      title: 'Asset Register',
      subtitle: wantArchived ? 'Archived assets' : 'Active asset register',
      columns: columnDefs.map((c: any) => ({ key: c.id, label: c.header, width: c.width ? c.width / 10 : 1 })),
      rows: assets.map((a: any) => {
        const row: any = {};
        for (const c of columnDefs) {
          let v = c.get(a);
          if (v instanceof Date) v = v.toISOString().slice(0, 10);
          row[c.id] = v == null ? '' : v;
        }
        return row;
      }),
    });
  }

  if (String(req.query.format || '').toLowerCase() === 'csv') {
    return sendCsv(res, { columnDefs, rows: assets, filename: `Assets-${dateStamp()}.csv` });
  }
  return sendXlsx(res, {
    sheetName: 'Assets',
    columnDefs,
    rows: assets,
    filename: `Assets-${dateStamp()}.xlsx`,
    truncated,
  });
}

// ── WORK ORDERS view ─────────────────────────────────────────────────────────

function assetLabel(a) {
  if (!a) return '';
  const parts = [a.equipmentType, a.manufacturer, a.model].filter(Boolean);
  const label = parts.join(' · ');
  return a.serialNumber ? `${label} (SN ${a.serialNumber})` : label;
}

const WORKORDERS_COLUMN_REGISTRY = [
  { id: 'asset',         header: 'Asset',          type: 'string', get: w => assetLabel(w.asset),       width: 36 },
  { id: 'site',          header: 'Site',           type: 'string', get: w => w.asset?.site?.name,       width: 24 },
  { id: 'contractor',    header: 'Contractor',     type: 'string', get: w => w.contractor?.name,        width: 24 },
  { id: 'status',        header: 'Status',         type: 'string', get: w => w.status,                  width: 14 },
  { id: 'scheduledDate', header: 'Scheduled Date', type: 'date',   get: w => w.scheduledDate,           width: 14 },
  { id: 'completedDate', header: 'Completed Date', type: 'date',   get: w => w.completedDate,           width: 14 },
  { id: 'netaDecal',     header: 'NETA Decal',     type: 'string', get: w => w.netaDecal,               width: 12 },
];

function applyWorkOrderColumnFilters(where, params) {
  const statusList = parseList(params.statusIn);
  if (statusList.length > 0) where.status = { in: statusList };

  const contractorList = parseList(params.contractorIn);
  if (contractorList.length > 0) {
    const wb = contractorList.includes(BLANK_SENTINEL), rl = contractorList.filter(v => v !== BLANK_SENTINEL), ors = [];
    if (rl.length > 0) ors.push({ contractor: { name: { in: rl } } });
    if (wb) ors.push({ contractorId: null });
    if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
  }

  const siteList = parseList(params.siteIn);
  if (siteList.length > 0) {
    where.AND = [...(where.AND || []), { asset: { site: { name: { in: siteList } } } }];
  }

  const decalList = parseList(params.netaDecalIn);
  if (decalList.length > 0) {
    const wb = decalList.includes(BLANK_SENTINEL), rl = decalList.filter(v => v !== BLANK_SENTINEL), ors = [];
    if (rl.length > 0) ors.push({ netaDecal: { in: rl } });
    if (wb) ors.push({ netaDecal: null });
    if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
  }

  for (const [f, fr, to] of [['scheduledDate', 'scheduledFrom', 'scheduledTo'], ['completedDate', 'completedFrom', 'completedTo']]) {
    const c = dateRangeClause(f, params[fr], params[to]);
    if (c) where.AND = [...(where.AND || []), c];
  }
}

async function exportWorkOrders(req, res) {
  const where: any = { accountId: req.user.accountId };

  if (req.query.assetId) where.assetId = String(req.query.assetId);

  applyWorkOrderColumnFilters(where, req.query);

  req.setTimeout(300_000);
  const { rows: workOrders, truncated } = await fetchAllPaged(prisma.workOrder, {
    where,
    include: {
      asset: {
        select: {
          equipmentType: true, manufacturer: true, model: true, serialNumber: true,
          site: { select: { name: true } },
        },
      },
      contractor: { select: { name: true } },
    },
    orderBy: [{ scheduledDate: 'asc' }, { createdAt: 'asc' }],
  });
  if (truncated) res.setHeader('X-Truncated', '1');

  const columnDefs = appendTruncationRow(
    workOrders, filterToRequestedColumns(WORKORDERS_COLUMN_REGISTRY, req.query.columns), truncated, EXPORT_HARD_CEILING,
  );

  if (String(req.query.format || '').toLowerCase() === 'csv') {
    return sendCsv(res, { columnDefs, rows: workOrders, filename: `WorkOrders-${dateStamp()}.csv` });
  }
  return sendXlsx(res, {
    sheetName: 'Work Orders',
    columnDefs,
    rows: workOrders,
    filename: `WorkOrders-${dateStamp()}.xlsx`,
    truncated,
  });
}

// ── GET /api/export/account?format=json|xlsx ─────────────────────────────────
// Phase 3 #5 -- "export everything / no lock-in": a complete, portable snapshot
// of the account (sites, assets, schedules, work orders, deficiencies, quote
// requests in full; documents + immutable snapshots as metadata + retrieval
// paths) in open formats. JSON is the lossless default; xlsx is a multi-sheet
// workbook. requireManager -- this is the whole account.
router.get('/account', requireManager, async (req, res) => {
  try {
    req.setTimeout(120_000);
    const data = await buildAccountExport(prisma, req.user.accountId);
    const stamp = dateStamp();
    const format = String(req.query.format || 'json').toLowerCase();

    // 2026-07-03 scan P0 (SCAN 4): the full-tenant export must leave an audit
    // trail -- user_data_exported already covers the much smaller per-user GDPR
    // export; this is its account-wide sibling. Fire-and-forget AFTER the
    // snapshot is built (a failed build never logs a false success) and before
    // the bytes stream out, mirroring the user_data_exported placement.
    // req.ip per INFOSEC-8-4 (privileged/security route).
    writeActivityLog({
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'account_exported',
      details:   { format, counts: data.counts ?? null },
      ipAddress: req.ip,
    });

    if (format === 'xlsx') {
      return await sendAccountXlsx(res, {
        exportData: data,
        sheetPlan: EXPORT_SHEETS,
        filename: `ServiceCycle-Account-Export-${stamp}.xlsx`,
      });
    }

    // JSON (default) -- the canonical, lossless no-lock-in artifact. COMP-8-2b:
    // stream it element-by-element rather than JSON.stringify-then-send so the
    // whole account isn't held in memory twice (object graph + giant string).
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ServiceCycle-Account-Export-${stamp}.json"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    await streamAccountExportJson(res, data);
    return res.end();
  } catch (err) {
    console.error('Account export error:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Account export failed' });
  }
});

// ── GET /api/export/xlsx?view=assets|workorders ──────────────────────────────

router.get('/xlsx', requireManager, async (req, res) => {
  try {
    const view = String(req.query.view || 'assets').toLowerCase();
    if (view === 'assets')                              return await exportAssets(req, res);
    if (view === 'workorders' || view === 'work-orders') return await exportWorkOrders(req, res);
    return res.status(400).json({ success: false, error: 'view must be assets or workorders' });
  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Export failed' });
    }
  }
});

// Direct aliases for the two views — same handlers, no ?view= needed. Keeps
// per-view toolbar links one query-param simpler.
router.get('/assets', requireManager, async (req, res) => {
  try { await exportAssets(req, res); }
  catch (err) {
    console.error('Export assets error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/workorders', requireManager, async (req, res) => {
  try { await exportWorkOrders(req, res); }
  catch (err) {
    console.error('Export work orders error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Export failed' });
  }
});

module.exports = router;

export {};
