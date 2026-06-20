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
const { buildAccountExport, EXPORT_SHEETS } = require('../lib/accountExport');
const { requireManager } = require('../middleware/roles');
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

// CR-9: every export fetches cap+1 rows so truncation is detectable. The
// X-Truncated:1 response header signals when the cap was hit.
const EXPORT_ROW_CAP = 5000;

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

  req.setTimeout(120_000);
  const assetsRaw = await prisma.asset.findMany({
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
    take: EXPORT_ROW_CAP + 1,
  });
  const truncated = assetsRaw.length > EXPORT_ROW_CAP;
  const assets = truncated ? assetsRaw.slice(0, EXPORT_ROW_CAP) : assetsRaw;
  if (truncated) res.setHeader('X-Truncated', '1');

  const columnDefs = filterToRequestedColumns(ASSETS_COLUMN_REGISTRY, req.query.columns);

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

  req.setTimeout(120_000);
  const workOrdersRaw = await prisma.workOrder.findMany({
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
    take: EXPORT_ROW_CAP + 1,
  });
  const truncated = workOrdersRaw.length > EXPORT_ROW_CAP;
  const workOrders = truncated ? workOrdersRaw.slice(0, EXPORT_ROW_CAP) : workOrdersRaw;
  if (truncated) res.setHeader('X-Truncated', '1');

  const columnDefs = filterToRequestedColumns(WORKORDERS_COLUMN_REGISTRY, req.query.columns);

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

    if (format === 'xlsx') {
      return await sendAccountXlsx(res, {
        exportData: data,
        sheetPlan: EXPORT_SHEETS,
        filename: `ServiceCycle-Account-Export-${stamp}.xlsx`,
      });
    }

    // JSON (default) -- the canonical, lossless no-lock-in artifact.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ServiceCycle-Account-Export-${stamp}.json"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Account export error:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Account export failed' });
  }
});

// ── GET /api/export/xlsx?view=assets|workorders ──────────────────────────────

router.get('/xlsx', async (req, res) => {
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
router.get('/assets', async (req, res) => {
  try { await exportAssets(req, res); }
  catch (err) {
    console.error('Export assets error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/workorders', async (req, res) => {
  try { await exportWorkOrders(req, res); }
  catch (err) {
    console.error('Export work orders error:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Export failed' });
  }
});

module.exports = router;

export {};
