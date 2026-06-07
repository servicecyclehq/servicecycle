// ─────────────────────────────────────────────────────────────────────────────
// routes/export.js — v0.40 Phase 4 unified Export-current-view
//                    v0.56.0: accept vendorIn/productIn multi-value params on
//                    the alerts export so the new ColumnFilterDropdown shape
//                    round-trips cleanly.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
// v0.58.0: sendXlsx moved to server/lib/xlsxExport.js so server/routes/reports.js
// can reuse the same workbook builder without duplicating ExcelJS plumbing.
const { sendXlsx } = require('../lib/xlsxExport');
import prisma from '../lib/prisma';

// Pure helper functions — extracted to lib/exportHelpers.js so they can be
// unit-tested without pulling in Prisma or Express.
const {
  BLANK_SENTINEL,
  dateOrNull,     // eslint-disable-line no-unused-vars -- used in ALERTS route
  daysUntil,
  dateStamp,
  parseDateStartUtc,
  parseDateEndUtc,
  dateRangeClause,
  parseNum,
  parseList,
  filterToRequestedColumns,
  vendorSpend,
  vendorLastContact,
  buildActivityWhere,
} = require('../lib/exportHelpers');

const router = express.Router();

// Applies canonical v0.44+ column-header filter params to a Prisma where object.
// Kept in-file to avoid circular-require with contracts.js.
function applyContractColumnFilters(where, params) {
  const vList = parseList(params.vendorIn);
  if (vList.length > 0) where.vendor = { ...(where.vendor || {}), name: { in: vList } };
  const pList = parseList(params.productIn);
  if (pList.length > 0) where.AND = [...(where.AND || []), { product: { in: pList } }];
  const poList = parseList(params.poIn);
  if (poList.length > 0) {
    const wb = poList.includes(BLANK_SENTINEL), rl = poList.filter(v => v !== BLANK_SENTINEL), ors = [];
    if (rl.length > 0) { ors.push({ poNumber: { in: rl } }); ors.push({ purchaseOrders: { some: { archivedAt: null, poNumber: { in: rl } } } }); }
    if (wb) ors.push({ AND: [{ poNumber: null }, { purchaseOrders: { none: { archivedAt: null } } }] });
    if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
  }
  const oList = parseList(params.ownerIn);
  if (oList.length > 0) {
    const wb = oList.includes(BLANK_SENTINEL), rl = oList.filter(v => v !== BLANK_SENTINEL), ors = [];
    if (rl.length > 0) { ors.push({ internalOwner: { name: { in: rl } } }); ors.push({ internalOwnerName: { in: rl } }); }
    if (wb) ors.push({ AND: [{ internalOwnerId: null }, { internalOwnerName: null }] });
    if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
  }
  const sList = parseList(params.statusIn);
  if (sList.length > 0) where.status = { in: sList };
  const cList = parseList(params.categoryIn);
  if (cList.length > 0) {
    const wb = cList.includes(BLANK_SENTINEL), rl = cList.filter(v => v !== BLANK_SENTINEL), ors = [];
    if (rl.length > 0) ors.push({ category: { name: { in: rl } } });
    if (wb) ors.push({ categoryId: null });
    if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
  }
  const arList = parseList(params.autoRenewalIn);
  if (arList.length > 0) {
    if (arList.includes('Yes') && !arList.includes('No'))      where.autoRenewal = true;
    else if (arList.includes('No') && !arList.includes('Yes')) where.autoRenewal = false;
  }
  for (const [param, field] of [['departmentIn','department'],['contractNumberIn','contractNumber'],['customerNumberIn','customerNumber'],['resellerIn','resellerName']]) {
    const list = parseList(params[param]);
    if (list.length > 0) {
      const wb = list.includes(BLANK_SENTINEL), rl = list.filter(v => v !== BLANK_SENTINEL), ors = [];
      if (rl.length > 0) ors.push({ [field]: { in: rl } });
      if (wb) ors.push({ OR: [{ [field]: null }, { [field]: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  for (const [f, fr, to] of [['endDate','endDateFrom','endDateTo'],['evaluationStartByDate','evalStartFrom','evalStartTo'],['cancelByDate','cancelByFrom','cancelByTo'],['startDate','startDateFrom','startDateTo']]) {
    const c = dateRangeClause(f, params[fr], params[to]);
    if (c) where.AND = [...(where.AND || []), c];
  }
  const vMin = parseNum(params.valueMin), vMax = parseNum(params.valueMax);
  if (vMin !== null || vMax !== null) {
    const clause: any = {};
    if (vMin !== null) clause.gte = vMin;
    if (vMax !== null) clause.lte = vMax;
    where.AND = [...(where.AND || []), { totalValue: clause }];
  }
}

// ── CONTRACTS export ─────────────────────────────────────────────────────────

const CONTRACTS_COLUMN_REGISTRY = [
  { id: 'vendor',          header: 'Vendor',      type: 'string',   get: c => c.vendor?.name },
  { id: 'product',         header: 'Product',     type: 'string',   get: c => c.product },
  { id: 'contractNumber',  header: 'Contract #',  type: 'string',   get: c => c.contractNumber },
  { id: 'customerNumber',  header: 'Customer #',  type: 'string',   get: c => c.customerNumber },
  { id: 'poNumber',        header: 'PO Number',   type: 'string',   get: c => c.poNumber },
  { id: 'owner',           header: 'Owner',       type: 'string',   get: c => c.internalOwner?.name },
  { id: 'status',          header: 'Status',      type: 'string',   get: c => c.status },
  { id: 'startDate',       header: 'Start Date',  type: 'date',     get: c => c.startDate, width: 12 },
  { id: 'endDate',         header: 'End Date',    type: 'date',     get: c => c.endDate,   width: 12 },
  { id: 'evaluationStart', header: 'Evaluate By', type: 'date',     get: c => c.evaluationStartByDate, width: 12 },
  { id: 'cancelBy',        header: 'Cancel By',   type: 'date',     get: c => c.cancelByDate,           width: 12 },
  { id: 'quantity',        header: 'Quantity',    type: 'number',   get: c => c.quantity, width: 10 },
  { id: 'costPerLicense',  header: 'Cost / License', type: 'currency', get: c => c.costPerLicense, width: 14 },
  { id: 'value',           header: 'Value',       type: 'currency', get: c => {
    if (!c.costPerLicense || !c.quantity) return null;
    return parseFloat(c.costPerLicense) * parseInt(c.quantity);
  }, width: 14 },
  { id: 'autoRenewal',     header: 'Auto Renewal',type: 'string',   get: c => c.autoRenewal ? 'Yes' : 'No', width: 12 },
  { id: 'department',      header: 'Department',  type: 'string',   get: c => c.department },
  { id: 'reseller',        header: 'Reseller',    type: 'string',   get: c => c.resellerName },
  { id: 'notes',           header: 'Notes',       type: 'string',   get: c => c.notes,    width: 40 },
];

router.get('/contracts', async (req, res) => {
  try {
    const {
      columns,
      status, vendorId, ownerId, categoryId, hasPO, evaluateBy,
      endMonth, renewal, search, excludeExpired, ids,
    } = req.query;

    // v0.71.0: ?archived=1 flips the WHERE clause so the same endpoint can
    // serve the /contracts/archived page export without a separate route.
    const archivedFlag = String(req.query.archived || '').toLowerCase();
    const wantArchived = archivedFlag === '1' || archivedFlag === 'true';

    const where: any = { accountId: req.user.accountId };
    if (req.user.contractScopeRestricted) where.internalOwnerId = req.user.id;
    if (!ids) where.archivedAt = wantArchived ? { not: null } : null;

    if (status) where.status = status;
    if (excludeExpired === 'true' && !status) {
      where.status = { not: 'expired' };
    }
    if (vendorId) where.vendorId = vendorId;
    if (ownerId === 'unassigned') where.internalOwnerId = null;
    else if (ownerId) where.internalOwnerId = ownerId;
    if (categoryId) where.categoryId = categoryId;
    if (hasPO === 'true')  where.poNumber = { not: null };
    if (hasPO === 'false') where.poNumber = null;

    const now = new Date();
    if (evaluateBy) {
      const n = parseInt(evaluateBy, 10);
      if (!Number.isNaN(n) && n > 0) {
        const upper = new Date(now.getTime() + n * 86400000);
        where.evaluationStartByDate = { gte: now, lte: upper };
      }
    }
    if (endMonth && /^\d{4}-\d{2}$/.test(endMonth)) {
      const [y, m] = endMonth.split('-').map(Number);
      const startMo = new Date(y, m - 1, 1);
      const endMo   = new Date(y, m,     1);
      where.endDate = { gte: startMo, lt: endMo };
    }
    if (renewal) {
      const windows: any = {
        renewing30:    { gte: now, lte: new Date(now.getTime() + 30 * 86400000) },
        renewing60:    { gte: now, lte: new Date(now.getTime() + 60 * 86400000) },
        renewing90:    { gte: now, lte: new Date(now.getTime() + 90 * 86400000) },
        overdue:       { lt:  now },
        expiringMonth: { gte: new Date(now.getFullYear(), now.getMonth(),     1),
                         lt:  new Date(now.getFullYear(), now.getMonth() + 1, 1) },
      };
      if (windows[renewal]) where.endDate = windows[renewal];
      else if (renewal === 'cancel30') {
        where.autoRenewal = true;
        where.cancelByDate = { gte: now, lte: new Date(now.getTime() + 30 * 86400000) };
      }
    }

    if (ids) {
      const idArr = String(ids).split(',').map(s => s.trim()).filter(Boolean);
      if (idArr.length === 0) return res.status(400).json({ success: false, error: 'ids query is empty' });
      if (idArr.length > 500) return res.status(400).json({ success: false, error: 'ids query exceeds 500 contract limit' });
      where.id = { in: idArr };
    }
    if (search) {
      where.OR = [
        { product:        { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { poNumber:       { contains: search, mode: 'insensitive' } },
        { department:     { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    // CR-9 (audit-2 2026-05-22): fetch take+1 so we can detect truncation.
    // Consumers should check X-Truncated:1 response header or the truncated
    // field in the XLSX metadata to know the result set was capped.
    // v0.73.3: apply canonical column-filter params (vendorIn, productIn, statusIn,
    // ownerIn, poIn, categoryIn, autoRenewalIn, departmentIn, contractNumberIn,
    // customerNumberIn, resellerIn, date ranges, valueMin/Max) so Export honours
    // the active ContractsList filter state.
    applyContractColumnFilters(where, req.query);
    req.setTimeout(120_000);
    const contractsRaw = await prisma.contract.findMany({
      where,
      include: {
        vendor:        { select: { name: true } },
        internalOwner: { select: { name: true } },
      },
      orderBy: { endDate: 'asc' },
      take: 1001,
    });
    const truncatedContracts = contractsRaw.length > 1000;
    const contracts = truncatedContracts ? contractsRaw.slice(0, 1000) : contractsRaw;
    if (truncatedContracts) res.setHeader('X-Truncated', '1');

    const columnDefs = filterToRequestedColumns(CONTRACTS_COLUMN_REGISTRY, columns);
    return sendXlsx(res, {
      sheetName: 'Contracts',
      columnDefs,
      rows: contracts,
      filename: `Contracts-${dateStamp()}.xlsx`,
      truncated: truncatedContracts,
    });
  } catch (err) {
    console.error('Export contracts error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});

// ── ALERTS export ────────────────────────────────────────────────────────────

const ALERT_TYPE_LABELS: any = {
  cancel_by:   'Cancel Window',
  review_by:   'Review Due',
  renewal:     'Renewal',
  billing_60:  'Billing (60 days)',
  billing_30:  'Billing (30 days)',
  billing_48:  'Billing (48 hours)',
  payment_due: 'Payment Due',
};

const ALERTS_COLUMN_REGISTRY = [
  { id: 'type',      header: 'Type',       type: 'string', get: r => ALERT_TYPE_LABELS[r.alertType] || r.alertType, width: 18 },
  { id: 'vendor',    header: 'Vendor',     type: 'string', get: r => r.contract?.vendor?.name },
  { id: 'product',   header: 'Product',    type: 'string', get: r => r.contract?.product },
  { id: 'date',      header: 'Date',       type: 'date',   get: r => r.relevantDate, width: 12 },
  { id: 'daysUntil', header: 'Days Until', type: 'number', get: r => r.daysUntil, width: 12 },
];

function getAlertRelevantDate(a) {
  if (a.alertType === 'cancel_by') return a.contract?.cancelByDate;
  if (a.alertType === 'review_by') return a.contract?.evaluationStartByDate;
  return a.contract?.endDate;
}

router.get('/alerts', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now       = new Date();
    const in7       = new Date(now.getTime() + 7 * 86400000);
    const startOfMonth     = new Date(now.getFullYear(), now.getMonth(),     1);
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const scope = req.user.contractScopeRestricted
      ? { internalOwnerId: req.user.id }
      : {};

    const contractSelect: any = {
      id: true, product: true, endDate: true,
      cancelByDate: true, evaluationStartByDate: true,
      autoRenewal: true, status: true,
      vendor: { select: { id: true, name: true } },
    };

    const [cancelUrgent, overdueReviews, expiringThisMonth, persistedAlerts] = await Promise.all([
      prisma.contract.findMany({
        where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
                 autoRenewal: true, cancelByDate: { gte: now, lte: in7 } },
        select: contractSelect, orderBy: { cancelByDate: 'asc' }, take: 50,
      }),
      prisma.contract.findMany({
        where: { accountId, ...scope, status: { in: ['active', 'under_review'] },
                 evaluationStartByDate: { lt: now } },
        select: contractSelect, orderBy: { evaluationStartByDate: 'asc' }, take: 50,
      }),
      prisma.contract.findMany({
        where: { accountId, ...scope, status: 'active',
                 endDate: { gte: startOfMonth, lt: startOfNextMonth } },
        select: contractSelect, orderBy: { endDate: 'asc' }, take: 50,
      }),
      prisma.alert.findMany({
        // H1 (audit High, 2026-05-22): mirror the same scope filter the
        // contract findMany calls above already use, so a restricted user
        // can't XLSX-export alerts on contracts they don't own.
        where: {
          accountId,
          status: { in: ['pending', 'sent'] },
          ...(req.user.contractScopeRestricted
            ? { contract: { internalOwnerId: req.user.id } }
            : {}),
        },
        include: {
          contract: {
            select: {
              id: true, product: true, endDate: true,
              cancelByDate: true, evaluationStartByDate: true,
              vendor: { select: { name: true } },
            },
          },
        },
        orderBy: { scheduledAt: 'asc' }, take: 100,
      }),
    ]);

    const allRows: any[] = [
      ...cancelUrgent.map(c => ({
        alertType: 'cancel_by', contract: c, relevantDate: c.cancelByDate, daysUntil: daysUntil(c.cancelByDate),
      })),
      ...overdueReviews.map(c => ({
        alertType: 'review_by', contract: c, relevantDate: c.evaluationStartByDate, daysUntil: daysUntil(c.evaluationStartByDate),
      })),
      ...expiringThisMonth.map(c => ({
        alertType: 'renewal', contract: c, relevantDate: c.endDate, daysUntil: daysUntil(c.endDate),
      })),
      ...persistedAlerts.map(a => {
        const rd = getAlertRelevantDate(a);
        return { alertType: a.alertType, contract: a.contract, relevantDate: rd, daysUntil: daysUntil(rd) };
      }),
    ];

    const chip = String(req.query.chip || 'all');
    const chipMatch = (t) => {
      if (chip === 'all')      return true;
      if (chip === 'billing')  return typeof t === 'string' && t.startsWith('billing_');
      return t === chip;
    };
    let filtered = allRows.filter(r => chipMatch(r.alertType));

    // v0.56.0: vendor + product accept multi-value (vendorIn / productIn,
    // comma-separated, exact-match). Legacy `vendor` / `product` text-contains
    // params are honored as a fallback so any pre-v0.56 saved/shared links
    // keep working.
    const {
      vendor, product, vendorIn, productIn,
      dateFrom, dateTo, daysMin, daysMax,
    } = req.query;

    const vendorList = parseList(vendorIn);
    if (vendorList.length > 0) {
      const wantsBlank = vendorList.includes(BLANK_SENTINEL);
      const realList   = new Set(vendorList.filter(v => v !== BLANK_SENTINEL));
      filtered = filtered.filter(r => {
        const v = r.contract?.vendor?.name;
        if (v == null || v === '') return wantsBlank;
        return realList.has(v);
      });
    } else if (vendor) {
      const needle = String(vendor).toLowerCase();
      filtered = filtered.filter(r => {
        const v = r.contract && r.contract.vendor && r.contract.vendor.name;
        return String(v != null ? v : '').toLowerCase().includes(needle);
      });
    }

    const productList = parseList(productIn);
    if (productList.length > 0) {
      const wantsBlank = productList.includes(BLANK_SENTINEL);
      const realList   = new Set(productList.filter(v => v !== BLANK_SENTINEL));
      filtered = filtered.filter(r => {
        const v = r.contract?.product;
        if (v == null || v === '') return wantsBlank;
        return realList.has(v);
      });
    } else if (product) {
      const needle = String(product).toLowerCase();
      filtered = filtered.filter(r => {
        const v = r.contract && r.contract.product;
        return String(v != null ? v : '').toLowerCase().includes(needle);
      });
    }

    if (dateFrom || dateTo) {
      const fromT = dateFrom ? new Date(dateFrom).getTime() : null;
      const toT   = dateTo   ? new Date(dateTo).getTime() + 86399999 : null;
      filtered = filtered.filter(r => {
        if (!r.relevantDate) return false;
        const t = new Date(r.relevantDate).getTime();
        if (Number.isNaN(t)) return false;
        if (fromT != null && t < fromT) return false;
        if (toT   != null && t > toT)   return false;
        return true;
      });
    }
    if (daysMin != null || daysMax != null) {
      const minV = daysMin != null && daysMin !== '' ? Number(daysMin) : null;
      const maxV = daysMax != null && daysMax !== '' ? Number(daysMax) : null;
      filtered = filtered.filter(r => {
        if (r.daysUntil == null) return false;
        if (minV != null && r.daysUntil < minV) return false;
        if (maxV != null && r.daysUntil > maxV) return false;
        return true;
      });
    }

    filtered.sort((a, b) => {
      const av = a.daysUntil == null ? Number.MAX_SAFE_INTEGER : a.daysUntil;
      const bv = b.daysUntil == null ? Number.MAX_SAFE_INTEGER : b.daysUntil;
      return av - bv;
    });

    const columnDefs = filterToRequestedColumns(ALERTS_COLUMN_REGISTRY, req.query.columns);
    return sendXlsx(res, {
      sheetName: 'Alerts',
      columnDefs,
      rows: filtered,
      filename: `Alerts-${dateStamp()}.xlsx`,
    });
  } catch (err) {
    console.error('Export alerts error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});


// ── VENDORS export ──────────────────────────────────────────────────────────
//
// v0.71.0: closes the toolbar Export gap on /vendors. Mirrors the alerts
// shape: accepts canonical multi-value column filter params + a `columns=`
// projection, returns an XLSX with the visible columns only.
//
// Filter params (all optional, all combinable):
//   nameIn            CSV vendor names
//   typeIn            CSV vendor types
//   complexityIn      CSV co-term complexity tier (none|moderate|complex)
//   contractsMin/Max  number range on contractCount
//   spendMin/Max      number range on activeSpend (USD)
//   lastContactFrom/To  date range (YYYY-MM-DD, inclusive)
//   columns           CSV column-id projection
//
// The dataset is bounded (<100 vendors per account in practice) so we fetch
// all rows, compute spend/contactedAt in JS, and filter client-side -- same
// shape as VendorsList.jsx does in the browser, so the export matches what
// the user sees on screen.

const VENDORS_COLUMN_REGISTRY = [
  { id: 'name',             header: 'Vendor',         type: 'string',   get: v => v.name,             width: 28 },
  { id: 'vendorType',       header: 'Type',           type: 'string',   get: v => v.vendorType,       width: 18 },
  { id: 'cotermComplexity', header: 'Co-term',        type: 'string',   get: v => {
      const labels: any = { none: 'Simple', moderate: 'Moderate', complex: 'Complex' };
      return v.cotermComplexity ? (labels[v.cotermComplexity] || v.cotermComplexity) : '';
    }, width: 14 },
  { id: 'contractCount',    header: 'Contracts',      type: 'number',   get: v => v.contractCount,    width: 12 },
  { id: 'activeSpend',      header: 'Active Spend',   type: 'currency', get: v => v.activeSpend,      width: 16 },
  { id: 'lastContactedAt',  header: 'Last Contacted', type: 'date',     get: v => v.lastContactedAt,  width: 14 },
  { id: 'cotermNotes',      header: 'Co-term Notes',  type: 'string',   get: v => v.cotermNotes,      width: 40 },
];

router.get('/vendors', async (req, res) => {
  try {
    // CR-9 (audit-2 2026-05-22): unbounded vendor export capped at 5000.
    // X-Truncated:1 header signals when the cap was hit.
    req.setTimeout(120_000);
    const vendorsRaw = await prisma.vendor.findMany({
      where: { accountId: req.user.accountId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { contracts: true } },
        contracts: {
          where: { status: { in: ['active', 'under_review'] } },
          select: { costPerLicense: true, quantity: true, status: true },
        },
        communications: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
        contacts: {
          where: { lastContactedAt: { not: null } },
          orderBy: { lastContactedAt: 'desc' },
          take: 1,
          select: { lastContactedAt: true },
        },
      },
      take: 5001, // CR-9: cap +1 for truncation detection
    });
    const truncatedVendors = vendorsRaw.length > 5000;
    const vendors = truncatedVendors ? vendorsRaw.slice(0, 5000) : vendorsRaw;
    if (truncatedVendors) res.setHeader('X-Truncated', '1');

    // Normalize into the same row shape vendorsColumns.jsx expects so the
    // column-registry getters can pull values directly.
    let rows = vendors.map(v => ({
      id:               v.id,
      name:             v.name,
      vendorType:       v.vendorType,
      cotermComplexity: v.cotermComplexity,
      cotermNotes:      v.cotermNotes,
      contractCount:    v._count?.contracts ?? 0,
      activeSpend:      vendorSpend(v),
      lastContactedAt:  vendorLastContact(v),
    }));

    // ── Apply column-filter params (mirrors VendorsList.jsx client behavior) ─
    const nameList       = parseList(req.query.nameIn);
    const typeList       = parseList(req.query.typeIn);
    const complexityList = parseList(req.query.complexityIn);

    const matchMulti = (rawVal, list) => {
      if (list.length === 0) return true;
      const wantsBlank = list.includes(BLANK_SENTINEL);
      const real       = new Set(list.filter(v => v !== BLANK_SENTINEL));
      if (rawVal == null || rawVal === '') return wantsBlank;
      return real.has(String(rawVal));
    };

    rows = rows.filter(r => matchMulti(r.name,             nameList));
    rows = rows.filter(r => matchMulti(r.vendorType,       typeList));
    rows = rows.filter(r => matchMulti(r.cotermComplexity, complexityList));

    const { contractsMin, contractsMax, spendMin, spendMax, lastContactFrom, lastContactTo } = req.query;
    const numFilter = (val, minQ, maxQ) => {
      const min = (minQ != null && minQ !== '') ? Number(minQ) : null;
      const max = (maxQ != null && maxQ !== '') ? Number(maxQ) : null;
      if (min == null && max == null) return true;
      if (typeof val !== 'number' || Number.isNaN(val)) return false;
      if (min != null && val < min) return false;
      if (max != null && val > max) return false;
      return true;
    };
    rows = rows.filter(r => numFilter(r.contractCount, contractsMin, contractsMax));
    rows = rows.filter(r => numFilter(r.activeSpend,   spendMin,     spendMax));

    if (lastContactFrom || lastContactTo) {
      const fromT = lastContactFrom ? new Date(lastContactFrom).getTime() : null;
      const toT   = lastContactTo   ? new Date(lastContactTo).getTime() + 86399999 : null;
      rows = rows.filter(r => {
        if (!r.lastContactedAt) return false;
        const t = new Date(r.lastContactedAt).getTime();
        if (Number.isNaN(t)) return false;
        if (fromT != null && t < fromT) return false;
        if (toT   != null && t > toT)   return false;
        return true;
      });
    }

    const columnDefs = filterToRequestedColumns(VENDORS_COLUMN_REGISTRY, req.query.columns);
    return sendXlsx(res, {
      sheetName: 'Vendors',
      columnDefs,
      rows,
      filename: `Vendors-${dateStamp()}.xlsx`,
    });
  } catch (err) {
    console.error('Export vendors error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});

// ── ACTIVITY-LOG export ──────────────────────────────────────────────────────
//
// v0.71.0: closes the toolbar Export gap on /activity-log. Mirrors the
// /api/activity filter param shape (actionIn/userIdIn/dateFrom/dateTo/
// contractId) so the URL params built by ActivityLogPage.jsx round-trip
// straight into the export. Manager/admin only -- matches the access tier
// of /api/activity and the page itself.
//
// User ids resolve to display names in the User column so the XLSX is
// human-readable. Deleted-user rows show "(System / deleted user)" to
// mirror the BLANK_SENTINEL convention in ActivityLogPage.

const { requireManager } = require('../middleware/roles');

const ACTION_LABELS_EXPORT: any = {
  contract_created:    'Contract added',
  status_changed:      'Status changed',
  owner_assigned:      'Owner assigned',
  fields_updated:      'Fields updated',
  checklist_updated:   'Checklist updated',
  contract_renewed:    'Contract renewed',
  contract_cancelled:  'Contract cancelled',
  brief_generated:     'Renewal brief generated',
  document_uploaded:   'Document uploaded',
  user_created:        'User added',
  login_failed:        'Failed login attempt',
  permission_denied:   'Permission denied',
  document_accessed:   'Document accessed',
  admin_password_reset:'Admin password reset (target user)',
  account_created:     'Account created',
  login_success:       'Signed in',
  category_created:    'Category created',
  category_updated:    'Category updated',
  category_archived:   'Category archived',
  category_restored:   'Category restored',
  custom_field_created:  'Custom field created',
  custom_field_updated:  'Custom field updated',
  custom_field_archived: 'Custom field archived',
  custom_field_restored: 'Custom field restored',
};

const ACTIVITY_COLUMN_REGISTRY = [
  { id: 'date',     header: 'Date',     type: 'date',   get: r => r.createdAt, width: 14 },
  { id: 'action',   header: 'Action',   type: 'string', get: r => ACTION_LABELS_EXPORT[r.action] || r.action, width: 22 },
  { id: 'user',     header: 'User',     type: 'string', get: r => r._userLabel || '(System / deleted user)', width: 24 },
  { id: 'contract', header: 'Contract', type: 'string', get: r => {
      if (!r.contract) return '';
      const vendor = r.contract.vendor?.name || '';
      const product = r.contract.product || '';
      return vendor && product ? `${vendor} · ${product}` : (vendor || product);
    }, width: 36 },
  { id: 'details',  header: 'Details',  type: 'string', get: r => {
      if (!r.details || typeof r.details !== 'object') return '';
      try { return JSON.stringify(r.details); } catch { return ''; }
    }, width: 60 },
];

router.get('/activity', requireManager, async (req, res) => {
  try {
    // Verify contractId scope if provided (mirrors /api/activity).
    if (req.query.contractId) {
      const ok = await prisma.contract.findFirst({
        where: { id: String(req.query.contractId), accountId: req.user.accountId },
        select: { id: true },
      });
      if (!ok) return res.status(404).json({ success: false, error: 'Contract not found' });
    }

    const where = buildActivityWhere(req);
    // CR-9 (audit-2 2026-05-22): fetch take+1 to detect truncation.
    req.setTimeout(120_000);
    const logsRaw = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 5001, // hard cap +1 so we can detect truncation; matches reports
      include: {
        user:     { select: { id: true, name: true, email: true } },
        contract: {
          select: {
            id: true, product: true,
            vendor: { select: { name: true } },
          },
        },
      },
    });

    const truncatedActivity = logsRaw.length > 5000;
    const logs = truncatedActivity ? logsRaw.slice(0, 5000) : logsRaw;
    if (truncatedActivity) res.setHeader('X-Truncated', '1');

    // Resolve user ids -> labels. Use the user join when present, fall back
    // to a per-id lookup for orphaned ids (GDPR-erased rows).
    const orphanedIds = new Set();
    for (const l of logs) {
      if (l.userId && !l.user) orphanedIds.add(l.userId);
    }
    let orphanLabels: any = {};
    if (orphanedIds.size > 0) {
      // The user record was erased -- nothing to look up. Render as blank-ish.
      // Kept structurally in case a future schema adds tombstone names.
      orphanLabels = {};
    }
    const rows = logs.map(l => ({
      ...l,
      _userLabel: l.user
        ? (l.user.name || l.user.email || l.user.id)
        : (orphanLabels[l.userId] || (l.userId ? '(Deleted user)' : '(System)')),
    }));

    const columnDefs = filterToRequestedColumns(ACTIVITY_COLUMN_REGISTRY, req.query.columns);
    return sendXlsx(res, {
      sheetName: 'Activity Log',
      columnDefs,
      rows,
      filename: `Activity-${dateStamp()}.xlsx`,
      truncated: truncatedActivity,
    });
  } catch (err) {
    console.error('Export activity error:', err);
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
});

module.exports = router;

export {};
