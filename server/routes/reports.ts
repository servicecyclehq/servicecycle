const { aiIpLimiter } = require('../middleware/aiIpLimit'); // v0.69.1: per-IP AI stack
/**
 * Executive spend reports — backward-looking actuals to complement the
 * forward-looking Budget Forecast.
 *
 * Endpoints:
 *   GET  /api/reports/executive-spend       — JSON aggregation (vendor / dept / top-10 + YoY)
 *   GET  /api/reports/executive-spend/pdf   — PDF export (board / CFO format)
 *
 * Security & scoping:
 *   - Manager + admin only (`requireManager`). Aggregate spend is not
 *     something a viewer should see by default; if a customer ever needs
 *     viewers to access it, gate it behind a featureFlag instead of
 *     opening the route.
 *   - Scope-restricted viewers/managers (contractScopeRestricted=true)
 *     get internalOwnerId-filtered aggregates — same pattern as
 *     contractWhereForUser in routes/contracts.js. This is the same
 *     leak class the project_backlog flagged for dashboard / alerts /
 *     budget; applying the filter HERE up front so the report can never
 *     leak account-wide totals to a restricted user.
 *   - Demo mode: the report only READS, so the demoWriteGuard is a
 *     no-op for these endpoints.
 *
 * FY anchor:
 *   FISCAL_YEAR_START_MONTH (account_settings, default 1) drives the
 *   period boundaries. Reuses lib/fiscalYear.js so the same logic can
 *   be unit-tested without spinning up the route.
 *
 * Allocation rule:
 *   A contract counts toward FY X if its `startDate` falls inside FY X.
 *   This matches a renewal-management mental model — each annual
 *   contract is one spend event in the FY it begins. Multi-year
 *   contracts with payment installments would ideally allocate per
 *   installment year; left as a follow-up if customers ask. Contracts
 *   with no startDate are excluded (can't place them in time).
 *
 * Spend formula:
 *   prefer `finalNegotiatedPrice * quantity` when finalNegotiatedPrice
 *   is set (post-negotiation actual), else `costPerLicense * quantity`,
 *   else fall back to denormalized `totalValue`. Three layers because
 *   the negotiation tracker is opt-in (Sprint 3) and older contracts
 *   only have costPerLicense populated.
 *
 * Archived contracts ARE included (they represent past spend) — this
 * differs from the Contracts list which excludes archived by default.
 */

'use strict';

const router = require('express').Router();

// v0.37.2 W6 MT-133: defensive cap on every report's contract scan.
// 5000 sits well above any realistic single-account contract count (the
// demo seed is ~20; most early customers will be under 500) but bounds
// the worst-case OOM surface from "unbounded findMany" to a tight 5000
// rows. If a real account ever crosses this threshold the per-call
// console.warn surfaces it in droplet logs so we can plan proper
// pagination before the report silently truncates.
const REPORT_QUERY_CAP = 5000;
function _warnIfCapped(label, rows) {
  if (rows && rows.length >= REPORT_QUERY_CAP) {
    console.warn('[reports] ' + label + ' hit REPORT_QUERY_CAP=' + REPORT_QUERY_CAP +
                 ' -- report rows may be truncated; consider proper pagination.');
  }
  return rows;
}

// S2-FN-04 (v0.74.1): build a response meta envelope so the client can show
// "Showing X of Y results" (or "results capped at 5000") rather than silently
// omitting rows. totalCount is null when truncated (Phase 1: no extra count query).
function _mkMeta(rows) {
  const truncated    = rows.length >= REPORT_QUERY_CAP;
  const returnedCount = rows.length;
  return { truncated, returnedCount, totalCount: truncated ? null : returnedCount };
}
import prisma from '../lib/prisma';
const { getNegotiationAnalysisStatus } = require('../lib/negotiationAnalysis');
const { requireManager } = require('../middleware/roles');
const { fiscalYearRange } = require('../lib/fiscalYear');
const {
  streamExecutiveSpendPdf,
  streamRenewalHorizonPdf,
  streamRiskRadarPdf,
  streamSavingsLedgerPdf,
  streamLicenseWastagePdf,
  streamSpendLedgerPdf,
  streamAutoRenewalExposurePdf,
  streamVendorConcentrationPdf,
  streamNonSaaSCategoriesPdf,
  streamCoTermOpportunityPdf,
  streamRenewalCommitmentForecastPdf,
  streamVendorPortfolioHeatMapPdf,
  streamAuditEvidencePackPdf,
  streamApplicationOverlapPdf,
  streamWalkawayCalculatorPdf,
  streamPortfolioDecisionDashboardPdf,
  streamContractHealthScorePdf,
  streamPriceEscalationRadarPdf,
  streamDepartmentBudgetAllocationPdf,
  streamM365OverlapPdf,
} = require('../lib/pdfReport');
const { computeM365OverlapForAccount } = require('../lib/m365Overlap');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadFiscalYearStartMonth(accountId) {
  const row = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key: 'FISCAL_YEAR_START_MONTH' } },
  });
  return parseInt(row?.value || '1', 10);
}

function contractSpend(c) {
  const qty = c.quantity ? parseInt(c.quantity, 10) : null;
  const negotiated = c.finalNegotiatedPrice != null
    ? parseFloat(String(c.finalNegotiatedPrice)) : null;
  const list = c.costPerLicense != null
    ? parseFloat(c.costPerLicense) : null;

  if (qty != null && negotiated != null) return qty * negotiated;
  if (qty != null && list != null)       return qty * list;
  if (c.totalValue != null)              return parseFloat(String(c.totalValue));
  return 0;
}

function pctChange(current, prior) {
  if (prior == null || prior === 0) {
    if (current === 0) return 0;
    // Prior is 0 / null and current is non-zero — true % change is
    // undefined; emit null and let the renderer show "—". Avoids
    // misleading 100% / Infinity values in board-level reports.
    return null;
  }
  return ((current - prior) / prior) * 100;
}

function emptyBucket() {
  return { spend: 0, count: 0 };
}

/**
 * Pure aggregator — given an array of contract rows and the two FY ranges,
 * return the bucketed payload. Exported for unit tests so the math can be
 * verified without spinning up Prisma.
 *
 * Each contract row needs at minimum: { startDate, endDate, product,
 * department, quantity, costPerLicense, finalNegotiatedPrice, totalValue,
 * vendor: { name } }
 */
function aggregateContracts(contracts, currentFY, priorFY) {
  const fyTotals: any = {
    current: { spend: 0, count: 0 },
    prior:   { spend: 0, count: 0 },
  };
  const byVendor = new Map();
  const byDept   = new Map();
  const byCategory = new Map(); // (Phase 3) — keyed by category id (or 'uncategorized')
  const currentFYContracts = [];

  for (const c of contracts) {
    if (!c.startDate) continue;
    const startDate = c.startDate instanceof Date ? c.startDate : new Date(c.startDate);
    const spend = contractSpend(c);
    const inCurrent = startDate >= currentFY.start && startDate < currentFY.end;
    const inPrior   = startDate >= priorFY.start   && startDate < priorFY.end;
    const bucket = inCurrent ? 'current' : inPrior ? 'prior' : null;
    if (!bucket) continue;

    fyTotals[bucket].spend += spend;
    fyTotals[bucket].count += 1;

    const vendorKey = c.vendor?.name || 'Unknown vendor';
    if (!byVendor.has(vendorKey)) {
      byVendor.set(vendorKey, { current: emptyBucket(), prior: emptyBucket() });
    }
    byVendor.get(vendorKey)[bucket].spend += spend;
    byVendor.get(vendorKey)[bucket].count += 1;

    const deptKey = c.department || 'Unassigned';
    if (!byDept.has(deptKey)) {
      byDept.set(deptKey, { current: emptyBucket(), prior: emptyBucket() });
    }
    byDept.get(deptKey)[bucket].spend += spend;
    byDept.get(deptKey)[bucket].count += 1;

    // (Phase 3) Category rollup. Uses categoryId as key so renames don't
    // split a category into two rows; carries the display metadata on the
    // bucket so the response can render icon + color without a join.
    const catKey = c.categoryId || 'uncategorized';
    if (!byCategory.has(catKey)) {
      byCategory.set(catKey, {
        categoryId:    c.categoryId || null,
        categoryName:  c.category?.name  || 'Uncategorized',
        categoryIcon:  c.category?.icon  || null,
        categoryColor: c.category?.color || null,
        current: emptyBucket(),
        prior:   emptyBucket(),
      });
    }
    byCategory.get(catKey)[bucket].spend += spend;
    byCategory.get(catKey)[bucket].count += 1;

    if (inCurrent) {
      currentFYContracts.push({
        product:    c.product,
        vendorName: c.vendor?.name || null,
        department: c.department,
        categoryName: c.category?.name || null,
        categoryIcon: c.category?.icon || null,
        endDate:    c.endDate,
        totalValue: spend,
      });
    }
  }

  const shapeRows = (map, nameKey) =>
    [...map.entries()]
      .map(([name, v]) => ({
        [nameKey]:      name,
        current:        v.current.spend,
        prior:          v.prior.spend,
        delta:          v.current.spend - v.prior.spend,
        percent:        pctChange(v.current.spend, v.prior.spend),
        // Current FY count for the rank-by-now perspective; prior count is
        // implied by the prior spend column.
        contractCount:  v.current.count,
      }))
      // Defensive: drop rows with neither current nor prior spend.
      .filter(r => r.current !== 0 || r.prior !== 0)
      .sort((a, b) => b.current - a.current);

  // (Phase 3) Category rollup uses a richer shape — keep the icon + color
  // for the SPA to render the badge in the table without joining back to
  // /api/categories.
  const shapeCategoryRows = (map) =>
    [...map.values()]
      .map(v => ({
        categoryId:    v.categoryId,
        categoryName:  v.categoryName,
        categoryIcon:  v.categoryIcon,
        categoryColor: v.categoryColor,
        current:       v.current.spend,
        prior:         v.prior.spend,
        delta:         v.current.spend - v.prior.spend,
        percent:       pctChange(v.current.spend, v.prior.spend),
        contractCount: v.current.count,
      }))
      .filter(r => r.current !== 0 || r.prior !== 0)
      .sort((a, b) => b.current - a.current);

  return {
    fyTotals,
    byVendor:     shapeRows(byVendor, 'vendorName'),
    byDepartment: shapeRows(byDept,   'department'),
    byCategory:   shapeCategoryRows(byCategory),
    topContracts: currentFYContracts
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, 10),
  };
}

/**
 * Build the aggregation payload. Pulled out so the PDF endpoint can
 * reuse it without re-implementing the query.
 */
async function buildExecutiveSpend(req) {
  const accountId = req.user.accountId;

  // ── Where clause (with scope-restriction) ────────────────────────────────
  // Same shape as contractWhereForUser in routes/contracts.js. Restricted
  // users only see contracts where they are internalOwner, so an aggregate
  // built from this filter cannot leak account-wide totals.
  const baseWhere: any = {
    accountId,
    startDate: { not: null },
  };
  if (req.user.contractScopeRestricted) {
    baseWhere.internalOwnerId = req.user.id;
  }

  // ── FY ranges ────────────────────────────────────────────────────────────
  const startMonth = await loadFiscalYearStartMonth(accountId);
  const now = new Date();
  const currentFY = fiscalYearRange(now, startMonth, 0);
  const priorFY   = fiscalYearRange(now, startMonth, -1);

  // ── Single fetch covering both FYs ───────────────────────────────────────
  // The two FY ranges are contiguous, so one query covers both. We
  // bucket per-row in JS rather than running two queries.
  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      ...baseWhere,
      startDate: { gte: priorFY.start, lt: currentFY.end },
    },
    select: {
      id: true,
      product: true,
      department: true,
      quantity: true,
      costPerLicense: true,
      finalNegotiatedPrice: true,
      totalValue: true,
      startDate: true,
      endDate: true,
      vendor: { select: { name: true } },
      categoryId: true,
      category: { select: { name: true, slug: true, icon: true, color: true } },
    },
  });

  const agg = aggregateContracts(contracts, currentFY, priorFY);

  // ── Account name for the header (single small lookup) ────────────────────
  // 2026-05-10 review B3 fix: previously selected `name: true` which doesn't
  // exist on the Account model — Prisma throws "Unknown arg `name`", which
  // surfaced as a 500 on every executive-spend request.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    currentFY: {
      label: currentFY.label,
      start: currentFY.start,
      end:   currentFY.end,
      totalSpend:    agg.fyTotals.current.spend,
      contractCount: agg.fyTotals.current.count,
    },
    priorFY: {
      label: priorFY.label,
      start: priorFY.start,
      end:   priorFY.end,
      totalSpend:    agg.fyTotals.prior.spend,
      contractCount: agg.fyTotals.prior.count,
    },
    yoy: {
      absolute: agg.fyTotals.current.spend - agg.fyTotals.prior.spend,
      percent:  pctChange(agg.fyTotals.current.spend, agg.fyTotals.prior.spend),
    },
    byVendor:     agg.byVendor,
    byDepartment: agg.byDepartment,
    byCategory:   agg.byCategory,        // (Phase 3)
    topContracts: agg.topContracts,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/executive-spend', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildExecutiveSpend(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/executive-spend:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/executive-spend/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildExecutiveSpend(req);
    const filename = `LapseIQ_Executive_Spend_${data.currentFY.label}_${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    streamExecutiveSpendPdf(res, data);
  } catch (err) {
    // Headers may already be sent if streaming started before throw — guard.
    console.error('GET /reports/executive-spend/pdf:', err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Failed to render PDF.' });
    } else {
      res.end();
    }
  }
});

// ── Shared CSV helper ─────────────────────────────────────────────────────────

function toCSV(rows, columns) {
  const header = columns.map(c => `"${c.header}"`).join(',');
  const body = rows.map(row =>
    columns.map(c => {
      const val = c.value(row);
      if (val == null) return '';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    }).join(',')
  ).join('\n');
  return `﻿${header}\n${body}`;
}

function sendCSV(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// ── Renewal Horizon ───────────────────────────────────────────────────────────

async function buildRenewalHorizon(req) {
  const accountId = req.user.accountId;
  const horizon = Math.min(parseInt(req.query.horizon || '90', 10), 365);
  const now = new Date();
  const cutoff = new Date(now.getTime() + horizon * 86400000);

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      status: { in: ['active', 'under_review'] },
      endDate: { gte: now, lte: cutoff },
      ...scopeWhere,
    },
    select: {
      id: true, product: true, status: true,
      endDate: true, cancelByDate: true,
      autoRenewal: true, autoRenewalNoticeDays: true,
      coTermGroup: true, totalValue: true,
      finalNegotiatedPrice: true, annualUpliftPercent: true,
      department: true, internalOwnerName: true,
      vendor: { select: { name: true } },
      category: { select: { name: true, icon: true, color: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  const classified = contracts.map(c => {
    const endDate = c.endDate ? new Date(c.endDate) : null;
    const cancelBy = c.cancelByDate ? new Date(c.cancelByDate) : null;
    const daysToEnd = endDate ? Math.ceil((endDate.getTime() - now.getTime()) / 86400000) : null;
    const daysToCancelBy = cancelBy ? Math.ceil((cancelBy.getTime() - now.getTime()) / 86400000) : null;

    let risk = 'ok';
    if (cancelBy && cancelBy < now) risk = 'trap';
    else if (cancelBy && daysToCancelBy <= 14) risk = 'urgent';
    else if (cancelBy && daysToCancelBy <= 30) risk = 'soon';

    const renewalValue = c.finalNegotiatedPrice
      ? parseFloat(String(c.finalNegotiatedPrice))
      : c.totalValue ? parseFloat(String(c.totalValue)) : 0;

    return {
      id: c.id, product: c.product, status: c.status,
      vendorName: c.vendor?.name || null,
      categoryName: c.category?.name || null,
      categoryIcon: c.category?.icon || null,
      categoryColor: c.category?.color || null,
      endDate: c.endDate, cancelByDate: c.cancelByDate,
      autoRenewal: c.autoRenewal,
      coTermGroup: c.coTermGroup, department: c.department,
      annualUpliftPercent: c.annualUpliftPercent ? parseFloat(String(c.annualUpliftPercent)) : null,
      ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
      renewalValue, daysToEnd, daysToCancelBy, risk,
    };
  });

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  const byRisk: any = {
    trap:   classified.filter(c => c.risk === 'trap'),
    urgent: classified.filter(c => c.risk === 'urgent'),
    soon:   classified.filter(c => c.risk === 'soon'),
    ok:     classified.filter(c => c.risk === 'ok'),
  };

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    horizon, cutoff,
    totalContracts: classified.length,
    totalValue: classified.reduce((s, c) => s + c.renewalValue, 0),
    byRisk, contracts: classified,
  };
}

router.get('/renewal-horizon', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildRenewalHorizon(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/renewal-horizon:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/renewal-horizon/csv', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalHorizon(req);
    const csv = toCSV((data as any).contracts, [
      { header: 'Vendor',        value: r => r.vendorName },
      { header: 'Product',       value: r => r.product },
      { header: 'Category',      value: r => r.categoryName },
      { header: 'End Date',      value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Cancel By',     value: r => r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : '' },
      { header: 'Days to End',   value: r => r.daysToEnd },
      { header: 'Risk',          value: r => r.risk },
      { header: 'Auto-Renewal',  value: r => r.autoRenewal ? 'Yes' : 'No' },
      { header: 'Annual Value',  value: r => r.renewalValue ? r.renewalValue.toFixed(2) : '' },
      { header: 'Uplift %',      value: r => r.annualUpliftPercent != null ? r.annualUpliftPercent.toFixed(1) : '' },
      { header: 'Department',    value: r => r.department },
      { header: 'Owner',         value: r => r.ownerDisplay },
      { header: 'Co-term Group', value: r => r.coTermGroup },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_Renewal_Horizon_${data.horizon}d_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/renewal-horizon/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

// ── Savings Ledger ────────────────────────────────────────────────────────────

async function buildSavingsLedger(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
  const dateTo   = req.query.dateTo   ? new Date(req.query.dateTo)   : null;
  const dateWhere: any = {};
  if (dateFrom || dateTo) {
    dateWhere.startDate = {};
    if (dateFrom) dateWhere.startDate.gte = dateFrom;
    if (dateTo)   dateWhere.startDate.lte = dateTo;
  }

  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null, ...scopeWhere, ...dateWhere,
      OR: [{ originalAsk: { not: null } }, { finalNegotiatedPrice: { not: null } }],
    },
    select: {
      id: true, product: true, startDate: true, endDate: true,
      originalAsk: true, finalNegotiatedPrice: true, totalValue: true,
      department: true, internalOwnerName: true,
      vendor: { select: { name: true } },
      category: { select: { name: true, icon: true, color: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { startDate: 'desc' },
  });

  const rows = contracts.map(c => {
    const ask        = c.originalAsk ? parseFloat(String(c.originalAsk)) : null;
    const negotiated = c.finalNegotiatedPrice ? parseFloat(String(c.finalNegotiatedPrice)) : null;
    const savings    = ask != null && negotiated != null ? ask - negotiated : null;
    const savingsPct = ask && savings != null ? (savings / ask) * 100 : null;
    return {
      id: c.id, product: c.product,
      vendorName: c.vendor?.name || null,
      categoryName: c.category?.name || null,
      categoryIcon: c.category?.icon || null,
      categoryColor: c.category?.color || null,
      department: c.department,
      ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
      startDate: c.startDate,
      originalAsk: ask, finalNegotiatedPrice: negotiated,
      savings, savingsPct,
    };
  });

  // Category rollup
  const byCategoryMap = new Map();
  for (const r of rows) {
    if (r.savings == null) continue;
    const key = r.categoryName || 'Uncategorized';
    if (!byCategoryMap.has(key)) {
      byCategoryMap.set(key, {
        categoryName: key, categoryIcon: r.categoryIcon,
        savings: 0, count: 0, totalAsk: 0,
      });
    }
    const b = byCategoryMap.get(key);
    b.savings += r.savings;
    b.count   += 1;
    if (r.originalAsk) b.totalAsk += r.originalAsk;
  }

  const totalAsk        = rows.reduce((s, r) => s + (r.originalAsk || 0), 0);
  const totalNegotiated = rows.reduce((s, r) => s + (r.finalNegotiatedPrice || 0), 0);
  const totalSavings    = rows.reduce((s, r) => s + (r.savings || 0), 0);
  const blendedSavingsPct = totalAsk > 0 ? (totalSavings / totalAsk) * 100 : null;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: new Date(),
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    dateFrom, dateTo,
    totalContracts: rows.length,
    totalAsk, totalNegotiated, totalSavings, blendedSavingsPct,
    byCategory: [...byCategoryMap.values()].sort((a, b) => b.savings - a.savings),
    rows,
  };
}

router.get('/savings-ledger', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildSavingsLedger(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/savings-ledger:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/savings-ledger/csv', requireManager, async (req, res) => {
  try {
    const data = await buildSavingsLedger(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Vendor',            value: r => r.vendorName },
      { header: 'Product',           value: r => r.product },
      { header: 'Category',          value: r => r.categoryName },
      { header: 'Department',        value: r => r.department },
      { header: 'Start Date',        value: r => r.startDate ? new Date(r.startDate).toISOString().split('T')[0] : '' },
      { header: 'Original Ask ($)',  value: r => r.originalAsk != null ? r.originalAsk.toFixed(2) : '' },
      { header: 'Final Price ($)',   value: r => r.finalNegotiatedPrice != null ? r.finalNegotiatedPrice.toFixed(2) : '' },
      { header: 'Savings ($)',       value: r => r.savings != null ? r.savings.toFixed(2) : '' },
      { header: 'Savings (%)',       value: r => r.savingsPct != null ? r.savingsPct.toFixed(1) : '' },
      { header: 'Owner',             value: r => r.ownerDisplay },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_Savings_Ledger_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/savings-ledger/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

// ── Savings Attribution ───────────────────────────────────────────────────────

const LEVER_LABELS: any = {
  usage_reduction:    'Usage Reduction',
  term_length:        'Term Length Change',
  benchmark_pressure: 'Benchmark Pressure',
  competitive_threat: 'Competitive Threat',
  seat_count_cut:     'Seat Count Cut',
  legal_language:     'Legal Language Change',
  other:              'Other',
};

async function buildSavingsAttribution(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
  const dateTo   = req.query.dateTo   ? new Date(req.query.dateTo)   : null;
  const dateWhere: any = {};
  if (dateFrom || dateTo) {
    dateWhere.startDate = {};
    if (dateFrom) dateWhere.startDate.gte = dateFrom;
    if (dateTo)   dateWhere.startDate.lte = dateTo;
  }

  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null, ...scopeWhere, ...dateWhere,
      originalAsk: { not: null },
      finalNegotiatedPrice: { not: null },
    },
    select: {
      id: true, product: true, startDate: true,
      originalAsk: true, finalNegotiatedPrice: true,
      savingsLever: true, department: true, internalOwnerName: true,
      vendor: { select: { name: true } },
      category: { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { startDate: 'desc' },
  });

  const rows = contracts.map(c => {
    const ask        = parseFloat(String(c.originalAsk));
    const negotiated = parseFloat(String(c.finalNegotiatedPrice));
    const savings    = ask - negotiated;
    const savingsPct = ask > 0 ? (savings / ask) * 100 : null;
    return {
      id: c.id, product: c.product,
      vendorName:   c.vendor?.name || null,
      categoryName: c.category?.name || null,
      department:   c.department,
      ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
      startDate:    c.startDate,
      originalAsk: ask, finalNegotiatedPrice: negotiated,
      savings, savingsPct,
      lever:      c.savingsLever || null,
      leverLabel: c.savingsLever ? (LEVER_LABELS[c.savingsLever] || c.savingsLever) : null,
    };
  });

  const byLeverMap = new Map();
  let untaggedCount = 0, untaggedSavings = 0, untaggedAsk = 0;
  for (const r of rows) {
    if (!r.lever) {
      untaggedCount++;
      untaggedSavings += r.savings;
      untaggedAsk     += r.originalAsk;
      continue;
    }
    if (!byLeverMap.has(r.lever)) {
      byLeverMap.set(r.lever, {
        lever: r.lever,
        leverLabel: r.leverLabel,
        count: 0, totalSavings: 0, totalAsk: 0,
      });
    }
    const b = byLeverMap.get(r.lever);
    b.count++;
    b.totalSavings += r.savings;
    b.totalAsk     += r.originalAsk;
  }

  const byLever = [...byLeverMap.values()]
    .map(b => ({
      ...b,
      avgSavingsPct: b.totalAsk > 0 ? (b.totalSavings / b.totalAsk) * 100 : null,
    }))
    .sort((a, b) => b.totalSavings - a.totalSavings);

  const totalSavings = rows.reduce((s, r) => s + r.savings, 0);
  const taggedCount  = rows.filter(r => r.lever).length;

  return {
    generatedAt: new Date(),
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    totalContracts: rows.length,
    taggedCount,
    untaggedCount,
    totalSavings,
    byLever,
    untaggedSavings,
    untaggedAsk,
    rows,
  };
}

router.get('/savings-attribution', requireManager, async (req, res) => {
  try {
    const data = await buildSavingsAttribution(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /reports/savings-attribution:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

// ── Budget Shock Simulator ────────────────────────────────────────────────────

/**
 * buildBudgetShockSimulator — three-scenario P&L projection for upcoming renewals.
 *
 * Scenarios:
 *   list      — vendor original ask (or current × (1 + listUpliftPct/100))
 *   lastYear  — prior negotiated price (or current × (1 + lastYearUpliftPct/100))
 *   benchmark — current × (1 − benchmarkDiscountPct/100)
 *
 * Query params (all optional, validated + clamped server-side):
 *   listUpliftPct        — default 10  (vendor typically asks ~10% increase)
 *   lastYearUpliftPct    — default 3   (CPI-ish flat renewal)
 *   benchmarkDiscountPct — default 12  (category median achievable discount)
 */
async function buildBudgetShockSimulator(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const listUpliftPct      = Math.max(0,   Math.min(200, parseFloat(req.query.listUpliftPct      ?? 10)));
  const lastYearUpliftPct  = Math.max(-50, Math.min(200, parseFloat(req.query.lastYearUpliftPct  ?? 3)));
  const benchmarkDiscPct   = Math.max(0,   Math.min(99,  parseFloat(req.query.benchmarkDiscountPct ?? 12)));

  const now     = new Date();
  const horizon = new Date(now.getFullYear() + 2, now.getMonth(), 1); // 24-month window

  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: { in: ['active', 'under_review'] },
      endDate: { gte: now, lte: horizon },
      totalValue: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true, endDate: true, department: true,
      totalValue: true, originalAsk: true, finalNegotiatedPrice: true,
      internalOwnerName: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  const rows = contracts.map(c => {
    const current   = parseFloat(String(c.totalValue));
    const listPrice = c.originalAsk
      ? parseFloat(String(c.originalAsk))
      : Math.round(current * (1 + listUpliftPct / 100) * 100) / 100;
    const lastYear  = c.finalNegotiatedPrice
      ? parseFloat(String(c.finalNegotiatedPrice))
      : Math.round(current * (1 + lastYearUpliftPct / 100) * 100) / 100;
    const benchmark = Math.round(current * (1 - benchmarkDiscPct / 100) * 100) / 100;
    const renewalMonth = new Date(c.endDate).toISOString().slice(0, 7);
    return {
      id: c.id, product: c.product,
      vendorName:   c.vendor?.name || null,
      categoryName: c.category?.name || null,
      department:   c.department || 'Unassigned',
      endDate:      c.endDate,
      renewalMonth,
      current, listPrice, lastYear, benchmark,
      hasActualAsk:  !!c.originalAsk,
      hasActualLast: !!c.finalNegotiatedPrice,
    };
  });

  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const totalCurrent   = sum('current');
  const totalList      = sum('listPrice');
  const totalLastYear  = sum('lastYear');
  const totalBenchmark = sum('benchmark');

  const delta = (t) => ({
    total:    t,
    delta:    t - totalCurrent,
    deltaPct: totalCurrent > 0 ? ((t - totalCurrent) / totalCurrent) * 100 : null,
  });

  // Department rollup
  const deptMap = new Map();
  for (const r of rows) {
    if (!deptMap.has(r.department)) {
      deptMap.set(r.department, { department: r.department, current: 0, listPrice: 0, lastYear: 0, benchmark: 0, count: 0 });
    }
    const d = deptMap.get(r.department);
    d.current   += r.current;
    d.listPrice += r.listPrice;
    d.lastYear  += r.lastYear;
    d.benchmark += r.benchmark;
    d.count++;
  }

  // 24-month cash-flow timeline (renewals landing in each month)
  const cashFlow = [];
  for (let i = 0; i < 24; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = d.toISOString().slice(0, 7);
    const month: any = { month: key, current: 0, listPrice: 0, lastYear: 0, benchmark: 0 };
    for (const r of rows) {
      if (r.renewalMonth === key) {
        month.current   += r.current;
        month.listPrice += r.listPrice;
        month.lastYear  += r.lastYear;
        month.benchmark += r.benchmark;
      }
    }
    cashFlow.push(month);
  }

  return {
    generatedAt: new Date(),
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    contractCount: rows.length,
    params: { listUpliftPct, lastYearUpliftPct, benchmarkDiscountPct: benchmarkDiscPct },
    totals: {
      current:   totalCurrent,
      list:      delta(totalList),
      lastYear:  delta(totalLastYear),
      benchmark: delta(totalBenchmark),
    },
    byDepartment: [...deptMap.values()].sort((a, b) => b.current - a.current),
    cashFlow,
    rows,
  };
}

router.get('/budget-shock-simulator', requireManager, async (req, res) => {
  try {
    const data = await buildBudgetShockSimulator(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /reports/budget-shock-simulator:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

// ── License Wastage ───────────────────────────────────────────────────────────

async function buildLicenseWastage(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const [contracts, totalActive] = await Promise.all([
    prisma.contract.findMany({ take: REPORT_QUERY_CAP,
      where: {
        accountId, archivedAt: null,
        status: { in: ['active', 'under_review'] },
        seatsLicensed: { not: null },
        seatsActivelyInUse: { not: null },
        ...scopeWhere,
      },
      select: {
        id: true, product: true,
        seatsLicensed: true, seatsActivelyInUse: true,
        totalValue: true, finalNegotiatedPrice: true,
        updatedAt: true, department: true, internalOwnerName: true,
        vendor: { select: { id: true, name: true } },
        category: { select: { id: true, name: true, icon: true, color: true } },
        internalOwner: { select: { name: true } },
      },
    }),
    prisma.contract.count({
      where: { accountId, archivedAt: null, status: { in: ['active', 'under_review'] }, ...scopeWhere },
    }),
  ]);

  const rows = contracts.map(c => {
    const licensed = c.seatsLicensed;
    const inUse    = c.seatsActivelyInUse;
    const utilizationPct = licensed > 0 ? (inUse / licensed) * 100 : 0;
    const wasteSeats     = Math.max(0, licensed - inUse);

    const annualValue = c.finalNegotiatedPrice
      ? parseFloat(String(c.finalNegotiatedPrice))
      : c.totalValue ? parseFloat(String(c.totalValue)) : null;

    const pricePerSeat        = annualValue && licensed > 0 ? annualValue / licensed : null;
    const estimatedWasteValue = pricePerSeat != null ? wasteSeats * pricePerSeat : null;

    return {
      id: c.id, product: c.product,
      vendorId: c.vendor?.id || null,
      vendorName: c.vendor?.name || null,
      categoryId: c.category?.id || null,
      categoryName: c.category?.name || null,
      categoryIcon: c.category?.icon || null,
      categoryColor: c.category?.color || null,
      department: c.department,
      ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
      seatsLicensed: licensed, seatsActivelyInUse: inUse,
      utilizationPct, wasteSeats, estimatedWasteValue, annualValue,
      dataAge: c.updatedAt,
    };
  }).sort((a, b) => (b.estimatedWasteValue || 0) - (a.estimatedWasteValue || 0));

  // v0.60 Dollarized: per-vendor + per-category waste rollups so the user
  // sees "Adobe wasted $45K across 3 contracts" without scanning a 50-row
  // table. Per-row rows[] is still the fact table; rollups are derived
  // server-side so the client (and PDF) render identical aggregates.
  const byVendorMap = new Map();
  for (const r of rows) {
    const key = r.vendorId || ('name:' + (r.vendorName || 'Unknown'));
    if (!byVendorMap.has(key)) byVendorMap.set(key, { vendorId: r.vendorId, vendorName: r.vendorName || 'Unknown', contractCount: 0, wasteValue: 0, annualValue: 0, wasteSeats: 0 });
    const b = byVendorMap.get(key);
    b.contractCount += 1;
    b.wasteValue    += (r.estimatedWasteValue || 0);
    b.annualValue   += (r.annualValue || 0);
    b.wasteSeats    += (r.wasteSeats || 0);
  }
  const byVendor = [...byVendorMap.values()].sort((a, b) => b.wasteValue - a.wasteValue);

  const byCategoryMap = new Map();
  for (const r of rows) {
    const key = r.categoryId || ('name:' + (r.categoryName || 'Uncategorized'));
    if (!byCategoryMap.has(key)) byCategoryMap.set(key, { categoryId: r.categoryId, categoryName: r.categoryName || 'Uncategorized', contractCount: 0, wasteValue: 0, annualValue: 0, vendorIds: new Set() });
    const b = byCategoryMap.get(key);
    b.contractCount += 1;
    b.wasteValue    += (r.estimatedWasteValue || 0);
    b.annualValue   += (r.annualValue || 0);
    if (r.vendorId) b.vendorIds.add(r.vendorId);
  }
  const byCategory = [...byCategoryMap.values()].map(b => ({
    categoryId: b.categoryId, categoryName: b.categoryName,
    contractCount: b.contractCount, vendorCount: b.vendorIds.size,
    wasteValue: b.wasteValue, annualValue: b.annualValue,
  })).sort((a, b) => b.wasteValue - a.wasteValue);

  const totalEstimatedWaste = rows.reduce((s, r) => s + (r.estimatedWasteValue || 0), 0);
  const totalAnnualValue    = rows.reduce((s, r) => s + (r.annualValue || 0), 0);
  const wastePctOfAnnual    = totalAnnualValue > 0 ? (totalEstimatedWaste / totalAnnualValue) * 100 : null;
  const biggestWasteVendor  = byVendor.length > 0 && byVendor[0].wasteValue > 0 ? byVendor[0] : null;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: new Date(),
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    coverageCount: contracts.length,
    totalActiveContracts: totalActive,
    totalEstimatedWaste,
    totalAnnualValue,
    wastePctOfAnnual,
    biggestWasteVendor,
    avgUtilization: rows.length > 0 ? rows.reduce((s, r) => s + r.utilizationPct, 0) / rows.length : null,
    byVendor,
    byCategory,
    rows,
  };
}

router.get('/license-wastage', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildLicenseWastage(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/license-wastage:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/license-wastage/csv', requireManager, async (req, res) => {
  try {
    const data = await buildLicenseWastage(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Vendor',              value: r => r.vendorName },
      { header: 'Product',             value: r => r.product },
      { header: 'Category',            value: r => r.categoryName },
      { header: 'Department',          value: r => r.department },
      { header: 'Seats Licensed',      value: r => r.seatsLicensed },
      { header: 'Seats In Use',        value: r => r.seatsActivelyInUse },
      { header: 'Utilization %',       value: r => r.utilizationPct.toFixed(1) },
      { header: 'Waste Seats',         value: r => r.wasteSeats },
      { header: 'Annual Value ($)',     value: r => r.annualValue != null ? r.annualValue.toFixed(2) : '' },
      { header: 'Est. Waste Value ($)', value: r => r.estimatedWasteValue != null ? r.estimatedWasteValue.toFixed(2) : '' },
      { header: 'Owner',               value: r => r.ownerDisplay },
      { header: 'Data Last Updated',   value: r => r.dataAge ? new Date(r.dataAge).toISOString().split('T')[0] : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_License_Wastage_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/license-wastage/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

// ── Risk Radar ────────────────────────────────────────────────────────────────

async function buildRiskRadar(req) {
  const accountId = req.user.accountId;
  const now = new Date();
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const baseSelect: any = {
    id: true, product: true, status: true,
    endDate: true, cancelByDate: true,
    autoRenewal: true, coTermGroup: true,
    totalValue: true, finalNegotiatedPrice: true,
    department: true, internalOwnerName: true,
    vendor: { select: { name: true } },
    category: { select: { name: true, icon: true, color: true } },
    internalOwner: { select: { name: true } },
  };

  const mapContract = c => ({
    id: c.id, product: c.product, status: c.status,
    vendorName: c.vendor?.name || null,
    categoryName: c.category?.name || null,
    categoryIcon: c.category?.icon || null,
    endDate: c.endDate, cancelByDate: c.cancelByDate,
    autoRenewal: c.autoRenewal, coTermGroup: c.coTermGroup,
    department: c.department,
    ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
    renewalValue: c.finalNegotiatedPrice
      ? parseFloat(String(c.finalNegotiatedPrice))
      : c.totalValue ? parseFloat(String(c.totalValue)) : 0,
  });

  const [traps, expiredActive, coTermContracts] = await Promise.all([
    // Auto-renewal traps: cancelByDate passed, still marked active
    prisma.contract.findMany({ take: REPORT_QUERY_CAP,
      where: {
        accountId, archivedAt: null,
        status: { in: ['active', 'under_review'] },
        cancelByDate: { lt: now },
        ...scopeWhere,
      },
      select: baseSelect,
      orderBy: { cancelByDate: 'asc' },
    }),
    // Expired but still active
    prisma.contract.findMany({ take: REPORT_QUERY_CAP,
      where: {
        accountId, archivedAt: null,
        status: { in: ['active', 'under_review'] },
        endDate: { lt: now },
        ...scopeWhere,
      },
      select: baseSelect,
      orderBy: { endDate: 'asc' },
    }),
    // Co-term misalignments
    prisma.contract.findMany({ take: REPORT_QUERY_CAP,
      where: {
        accountId, archivedAt: null,
        status: { in: ['active', 'under_review'] },
        coTermGroup: { not: null },
        ...scopeWhere,
      },
      select: { ...baseSelect, coTermGroup: true },
      orderBy: { coTermGroup: 'asc' },
    }),
  ]);

  // Group co-term contracts and find diverging groups
  const coTermGroups = new Map();
  for (const c of coTermContracts) {
    if (!coTermGroups.has(c.coTermGroup)) coTermGroups.set(c.coTermGroup, []);
    coTermGroups.get(c.coTermGroup).push(c);
  }

  const coTermMisaligned = [];
  for (const [groupName, members] of coTermGroups) {
    if (members.length < 2) continue;
    const dates = members.map(c => c.endDate ? new Date(c.endDate).getTime() : null).filter(Boolean);
    if (dates.length < 2) continue;
    const divergeDays = (Math.max(...dates) - Math.min(...dates)) / 86400000;
    if (divergeDays > 30) {
      coTermMisaligned.push({
        groupName,
        divergeDays: Math.round(divergeDays),
        members: members.map(mapContract),
      });
    }
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(traps || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    traps: traps.map(mapContract),
    expiredActive: expiredActive.map(mapContract),
    coTermMisaligned,
    totalIssues: traps.length + expiredActive.length + coTermMisaligned.length,
  };
}

router.get('/risk-radar', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildRiskRadar(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/risk-radar:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/risk-radar/csv', requireManager, async (req, res) => {
  try {
    const data = await buildRiskRadar(req);
    // Flatten all three buckets with a Type column
    const allRows = [
      ...data.traps.map(r => ({ ...r, issueType: 'Auto-Renewal Trap' })),
      ...data.expiredActive.map(r => ({ ...r, issueType: 'Expired (Still Active)' })),
      ...data.coTermMisaligned.flatMap(g =>
        g.members.map(r => ({ ...r, issueType: `Co-term Misaligned (${g.divergeDays}d divergence)` }))
      ),
    ];
    const csv = toCSV(allRows, [
      { header: 'Issue Type',   value: r => r.issueType },
      { header: 'Vendor',       value: r => r.vendorName },
      { header: 'Product',      value: r => r.product },
      { header: 'Category',     value: r => r.categoryName },
      { header: 'End Date',     value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Cancel By',    value: r => r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : '' },
      { header: 'Auto-Renewal', value: r => r.autoRenewal ? 'Yes' : 'No' },
      { header: 'Value ($)',    value: r => r.renewalValue ? r.renewalValue.toFixed(2) : '' },
      { header: 'Department',   value: r => r.department },
      { header: 'Owner',        value: r => r.ownerDisplay },
      { header: 'Co-term Group',value: r => r.coTermGroup },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_Risk_Radar_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/risk-radar/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

// ── Spend Ledger ──────────────────────────────────────────────────────────────

async function buildSpendLedger(req) {
  const accountId = req.user.accountId;
  const mode = req.query.mode === 'actuals' ? 'actuals' : 'commitments';
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const startMonth = await loadFiscalYearStartMonth(accountId);
  const now = new Date();
  const fyOffset = parseInt(req.query.fyOffset || '0', 10);
  const selectedFY = fiscalYearRange(now, startMonth, fyOffset);
  const priorFY    = fiscalYearRange(now, startMonth, fyOffset - 1);

  // Custom date range overrides FY selector
  const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : selectedFY.start;
  const dateTo   = req.query.dateTo   ? new Date(req.query.dateTo)   : selectedFY.end;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  if (mode === 'actuals') {
    const pos = await prisma.purchaseOrder.findMany({ take: REPORT_QUERY_CAP,
      where: {
        archivedAt: null,
        contract: { accountId, archivedAt: null, ...scopeWhere },
        OR: [
          { orderDate: { gte: dateFrom, lt: dateTo } },
          { coverageStartDate: { gte: dateFrom, lt: dateTo } },
        ],
      },
      select: {
        id: true, amount: true, orderDate: true, poNumber: true,
        coverageStartDate: true, coverageEndDate: true,
        contract: {
          select: {
            id: true, product: true, department: true,
            vendor: { select: { name: true } },
            category: { select: { name: true, icon: true, color: true } },
          },
        },
      },
    });

    const byVendor   = new Map();
    const byCategory = new Map();
    const byDept     = new Map();
    let totalSpend   = 0;

    for (const po of pos) {
      const amount = po.amount ? parseFloat(String(po.amount)) : 0;
      totalSpend += amount;

      const vKey = po.contract.vendor?.name || 'Unknown';
      if (!byVendor.has(vKey)) byVendor.set(vKey, { vendorName: vKey, spend: 0, poCount: 0 });
      byVendor.get(vKey).spend += amount;
      byVendor.get(vKey).poCount += 1;

      const cKey = po.contract.category?.name || 'Uncategorized';
      if (!byCategory.has(cKey)) {
        byCategory.set(cKey, {
          categoryName: cKey,
          categoryIcon:  po.contract.category?.icon  || null,
          categoryColor: po.contract.category?.color || null,
          spend: 0, poCount: 0,
        });
      }
      byCategory.get(cKey).spend += amount;
      byCategory.get(cKey).poCount += 1;

      const dKey = po.contract.department || 'Unassigned';
      if (!byDept.has(dKey)) byDept.set(dKey, { department: dKey, spend: 0, poCount: 0 });
      byDept.get(dKey).spend += amount;
      byDept.get(dKey).poCount += 1;
    }

    return {
      companyName: account?.companyName || 'Your Company',
      generatedAt: now,
      generatedBy: req.user.name || req.user.email || null,
      scopeRestricted: !!req.user.contractScopeRestricted,
      mode: 'actuals',
      dateFrom, dateTo, fyLabel: selectedFY.label,
      totalSpend, totalPOs: pos.length,
      byVendor:     [...byVendor.values()].sort((a, b) => b.spend - a.spend),
      byCategory:   [...byCategory.values()].sort((a, b) => b.spend - a.spend),
      byDepartment: [...byDept.values()].sort((a, b) => b.spend - a.spend),
    };
  }

  // Commitments mode — reuse aggregateContracts over selected FY pair
  const contracts = await prisma.contract.findMany({ take: REPORT_QUERY_CAP,
    where: {
      accountId,
      startDate: { gte: priorFY.start, lt: dateTo },
      ...scopeWhere,
    },
    select: {
      id: true, product: true, department: true,
      quantity: true, costPerLicense: true,
      finalNegotiatedPrice: true, totalValue: true,
      startDate: true, endDate: true,
      vendor: { select: { name: true } },
      categoryId: true,
      category: { select: { name: true, slug: true, icon: true, color: true } },
    },
  });

  const currentRange: any = { start: dateFrom, end: dateTo, label: selectedFY.label };
  const agg = aggregateContracts(contracts, currentRange, priorFY);

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    mode: 'commitments',
    dateFrom, dateTo, fyLabel: selectedFY.label, priorFYLabel: priorFY.label,
    totalSpend: agg.fyTotals.current.spend,
    priorSpend: agg.fyTotals.prior.spend,
    yoy: {
      absolute: agg.fyTotals.current.spend - agg.fyTotals.prior.spend,
      percent:  pctChange(agg.fyTotals.current.spend, agg.fyTotals.prior.spend),
    },
    contractCount: agg.fyTotals.current.count,
    byVendor:     agg.byVendor,
    byCategory:   agg.byCategory,
    byDepartment: agg.byDepartment,
    topContracts: agg.topContracts,
  };
}

router.get('/spend-ledger', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildSpendLedger(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/spend-ledger:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/spend-ledger/csv', requireManager, async (req, res) => {
  try {
    const data = await buildSpendLedger(req);
    let rows, columns;
    if (data.mode === 'actuals') {
      rows = data.byVendor;
      columns = [
        { header: 'Vendor',   value: r => r.vendorName },
        { header: 'POs',      value: r => r.poCount },
        { header: 'Spend ($)',value: r => r.spend.toFixed(2) },
      ];
    } else {
      rows = data.byVendor;
      columns = [
        { header: 'Vendor',            value: r => r.vendorName },
        { header: 'Contracts',         value: r => r.contractCount },
        { header: `${data.fyLabel} ($)`, value: r => r.current.toFixed(2) },
        { header: `${data.priorFYLabel} ($)`, value: r => r.prior.toFixed(2) },
        { header: 'Change ($)',        value: r => r.delta.toFixed(2) },
        { header: 'Change %',          value: r => r.percent != null ? r.percent.toFixed(1) : '' },
      ];
    }
    const date = new Date().toISOString().split('T')[0];
    const csv = toCSV(rows, columns);
    sendCSV(res, `LapseIQ_Spend_Ledger_${data.mode}_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/spend-ledger/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

// ── PDF routes ────────────────────────────────────────────────────────────────

router.get('/renewal-horizon/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalHorizon(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Renewal_Horizon_${data.horizon}d_${date}.pdf"`);
    streamRenewalHorizonPdf(res, data);
  } catch (err) {
    console.error('GET /reports/renewal-horizon/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/risk-radar/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildRiskRadar(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Risk_Radar_${date}.pdf"`);
    streamRiskRadarPdf(res, data);
  } catch (err) {
    console.error('GET /reports/risk-radar/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/savings-ledger/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildSavingsLedger(req);
    const date = new Date().toISOString().split('T')[0];
    // Reconstruct the period label from query params to include in filename
    const periodLabel = req.query.dateFrom
      ? `${req.query.dateFrom.slice(0, 4)}`
      : 'AllTime';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Savings_Ledger_${periodLabel}_${date}.pdf"`);
    streamSavingsLedgerPdf(res, data, periodLabel);
  } catch (err) {
    console.error('GET /reports/savings-ledger/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/license-wastage/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildLicenseWastage(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_License_Wastage_${date}.pdf"`);
    streamLicenseWastagePdf(res, data);
  } catch (err) {
    console.error('GET /reports/license-wastage/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/spend-ledger/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildSpendLedger(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Spend_Ledger_${data.mode}_${data.fyLabel}_${date}.pdf"`);
    streamSpendLedgerPdf(res, data);
  } catch (err) {
    console.error('GET /reports/spend-ledger/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// v0.58.0 NEW ROUTES — appended via PowerShell .Replace() at the
// `// Exported helpers for unit tests` marker. Each route is requireManager,
// scope-restriction-aware (mirroring buildExecutiveSpend pattern), and uses
// REPORT_QUERY_CAP from the top of the file.
// ═════════════════════════════════════════════════════════════════════════════

const { sendXlsx } = require('../lib/xlsxExport');

// ── Hub KPI bundle ──────────────────────────────────────────────────────────
// Single endpoint that returns the 4 KPI-strip tiles in one round-trip so the
// hub page doesn't fan out to 4 separate aggregation endpoints on mount.

async function buildHubKpis(req) {
  const accountId = req.user.accountId;
  const now = new Date();
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  // KPI 1 — Auto-renewal exposure in next 90 days
  const autoRenewCutoff = new Date(now.getTime() + 90 * 86400000);
  const autoRenewContracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      status: { in: ['active', 'under_review'] },
      autoRenewal: true,
      cancelByDate: { gte: now, lte: autoRenewCutoff },
      ...scopeWhere,
    },
    select: { totalValue: true, finalNegotiatedPrice: true, quantity: true, costPerLicense: true },
  });
  const autoRenewalExposure = autoRenewContracts.reduce((s, c) => s + contractSpend(c), 0);

  // KPI 2 — Top-5 vendor concentration (YTD)
  const startMonth = await loadFiscalYearStartMonth(accountId);
  const currentFY = fiscalYearRange(now, startMonth, 0);
  const ytdContracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      startDate: { gte: currentFY.start, lt: now },
      ...scopeWhere,
    },
    select: {
      totalValue: true, finalNegotiatedPrice: true, quantity: true, costPerLicense: true,
      vendor: { select: { id: true, name: true } },
    },
  });
  const vendorSpend = new Map();
  let totalYtdSpend = 0;
  for (const c of ytdContracts) {
    const s = contractSpend(c);
    totalYtdSpend += s;
    const key = c.vendor?.name || 'Unknown';
    vendorSpend.set(key, (vendorSpend.get(key) || 0) + s);
  }
  const top5Spend = [...vendorSpend.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  const vendorConcentrationPct = totalYtdSpend > 0 ? (top5Spend / totalYtdSpend) * 100 : null;

  // KPI 3 — Realized savings YTD
  const savingsContracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      startDate: { gte: currentFY.start, lt: now },
      originalAsk: { not: null },
      finalNegotiatedPrice: { not: null },
      ...scopeWhere,
    },
    select: { originalAsk: true, finalNegotiatedPrice: true },
  });
  const realizedSavingsYTD = savingsContracts.reduce((s, c) => {
    const ask = c.originalAsk ? parseFloat(String(c.originalAsk)) : 0;
    const fin = c.finalNegotiatedPrice ? parseFloat(String(c.finalNegotiatedPrice)) : 0;
    return s + (ask - fin);
  }, 0);

  // KPI 4 — Cloud commit burn (% of committed cloud spend consumed via POs)
  // Returns null when no cloud-synced contracts exist so the UI can show
  // "Connect cloud accounts" CTA instead of a misleading 0%.
  const cloudContracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      syncSource: { in: ['aws', 'azure', 'gcp'] },
      ...scopeWhere,
    },
    select: {
      id: true, totalValue: true, finalNegotiatedPrice: true, quantity: true, costPerLicense: true,
    },
  });
  let cloudCommitBurnPct = null;
  if (cloudContracts.length > 0) {
    const committed = cloudContracts.reduce((s, c) => s + contractSpend(c), 0);
    const ids = cloudContracts.map(c => c.id);
    // H10 (audit High, 2026-05-22): replace findMany+sum-in-JS with
    // a single SQL SUM. Pre-fix, a tenant with 10k+ POs (large enterprise
    // self-host) loaded every row into Node memory to compute one
    // aggregate -- memory cliff + slow response. aggregate is one query
    // + one number returned.
    const posAgg = await prisma.purchaseOrder.aggregate({
      where: { contractId: { in: ids }, archivedAt: null },
      _sum: { amount: true },
    });
    const actuals = posAgg._sum.amount != null ? parseFloat(String(posAgg._sum.amount)) : 0;
    cloudCommitBurnPct = committed > 0 ? (actuals / committed) * 100 : null;
  }

  // #19 part 2 - M365 overlap probe drives the conditional Reports-index card.
  // Cheap relative to the KPI scans; fails open so a probe error never breaks
  // the hub (the card simply stays hidden).
  let m365Overlap = { hasOverlap: false, overlapCount: 0, totalSpendAtStake: 0 };
  try {
    const _ov = await computeM365OverlapForAccount(prisma, { accountId, scopeWhere });
    if (_ov && _ov.hasAnchor && Array.isArray(_ov.overlaps) && _ov.overlaps.length > 0) {
      m365Overlap = { hasOverlap: true, overlapCount: _ov.overlaps.length, totalSpendAtStake: _ov.totalSpendAtStake };
    }
  } catch (_e) {
    console.warn('[reports] hub-kpis m365 overlap probe failed:', _e && _e.message ? _e.message : _e);
  }
  return {
    _meta: _mkMeta(cloudContracts || []),
    m365Overlap,
    generatedAt: now,
    fyLabel: currentFY.label,
    autoRenewalExposure: { value: autoRenewalExposure, sublabel: 'in next 90 days', count: autoRenewContracts.length },
    vendorConcentration: { value: vendorConcentrationPct, sublabel: 'Top 5 vendors (YTD)' },
    realizedSavingsYTD:  { value: realizedSavingsYTD,  sublabel: currentFY.label + ' YTD', count: savingsContracts.length },
    cloudCommitBurn:     { value: cloudCommitBurnPct,  sublabel: cloudContracts.length > 0 ? 'of committed cloud' : null, hasData: cloudContracts.length > 0 },
  };
}

router.get('/hub-kpis', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildHubKpis(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/hub-kpis:', err);
    res.status(500).json({ success: false, error: 'Failed to build KPIs.' });
  }
});

// ── Auto-Renewal Exposure ────────────────────────────────────────────────────
// White-space report (no competitor ships it as canned). Surfaces capital at
// risk from auto-renewing contracts whose cancel window is approaching.

async function buildAutoRenewalExposure(req) {
  const accountId = req.user.accountId;
  const horizon = Math.min(parseInt(req.query.horizon || '90', 10), 365);
  const now = new Date();
  const cutoff = new Date(now.getTime() + horizon * 86400000);

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      status: { in: ['active', 'under_review'] },
      autoRenewal: true,
      cancelByDate: { gte: now, lte: cutoff },
      ...scopeWhere,
    },
    select: {
      id: true, product: true, status: true,
      endDate: true, cancelByDate: true,
      autoRenewal: true, autoRenewalNoticeDays: true,
      totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
      poNumber: true, department: true, internalOwnerName: true,
      vendor: { select: { name: true } },
      category: { select: { name: true, icon: true, color: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { cancelByDate: 'asc' },
  });

  const rows = contracts.map(c => {
    const cancelBy = c.cancelByDate ? new Date(c.cancelByDate) : null;
    const daysToCancelBy = cancelBy ? Math.ceil((cancelBy.getTime() - now.getTime()) / 86400000) : null;
    let risk = 'ok';
    if (daysToCancelBy != null) {
      if (daysToCancelBy <= 7) risk = 'critical';
      else if (daysToCancelBy <= 30) risk = 'warning';
    }
    return {
      id: c.id, product: c.product, status: c.status,
      vendorName: c.vendor?.name || null,
      categoryName: c.category?.name || null,
      categoryIcon: c.category?.icon || null,
      categoryColor: c.category?.color || null,
      department: c.department,
      ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
      endDate: c.endDate, cancelByDate: c.cancelByDate,
      autoRenewalNoticeDays: c.autoRenewalNoticeDays,
      renewalValue: contractSpend(c),
      daysToCancelBy, risk,
      poNumber: c.poNumber,
    };
  });

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  const totalExposure = rows.reduce((s, r) => s + (r.renewalValue || 0), 0);
  const critical = rows.filter(r => r.risk === 'critical');
  const warning  = rows.filter(r => r.risk === 'warning');

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    horizon, cutoff,
    totalContracts: rows.length,
    totalExposure,
    criticalCount: critical.length,
    criticalExposure: critical.reduce((s, r) => s + (r.renewalValue || 0), 0),
    warningCount: warning.length,
    warningExposure: warning.reduce((s, r) => s + (r.renewalValue || 0), 0),
    rows,
  };
}

router.get('/auto-renewal-exposure', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildAutoRenewalExposure(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/auto-renewal-exposure:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/auto-renewal-exposure/csv', requireManager, async (req, res) => {
  try {
    const data = await buildAutoRenewalExposure(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Vendor',           value: r => r.vendorName },
      { header: 'Product',          value: r => r.product },
      { header: 'Category',         value: r => r.categoryName },
      { header: 'End Date',         value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Cancel By',        value: r => r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : '' },
      { header: 'Days to Cancel',   value: r => r.daysToCancelBy },
      { header: 'Risk',             value: r => r.risk },
      { header: 'Notice Days',      value: r => r.autoRenewalNoticeDays },
      { header: 'Renewal Value',    value: r => r.renewalValue != null ? r.renewalValue.toFixed(2) : '' },
      { header: 'Department',       value: r => r.department },
      { header: 'Owner',            value: r => r.ownerDisplay },
      { header: 'PO Number',        value: r => r.poNumber },
    ]);
    sendCSV(res, `LapseIQ_Auto_Renewal_Exposure_${data.horizon}d_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/auto-renewal-exposure/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/auto-renewal-exposure/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildAutoRenewalExposure(req);
    await sendXlsx(res, {
      sheetName: 'Auto-Renewal Exposure',
      filename: `LapseIQ_Auto_Renewal_Exposure_${data.horizon}d_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'vendor',        header: 'Vendor',         type: 'string',   get: r => r.vendorName, width: 22 },
        { id: 'product',       header: 'Product',        type: 'string',   get: r => r.product,    width: 28 },
        { id: 'category',      header: 'Category',       type: 'string',   get: r => r.categoryName, width: 16 },
        { id: 'endDate',       header: 'End Date',       type: 'date',     get: r => r.endDate,    width: 12 },
        { id: 'cancelBy',      header: 'Cancel By',      type: 'date',     get: r => r.cancelByDate, width: 12 },
        { id: 'daysToCancel',  header: 'Days to Cancel', type: 'number',   get: r => r.daysToCancelBy, width: 14 },
        { id: 'risk',          header: 'Risk',           type: 'string',   get: r => r.risk,       width: 10 },
        { id: 'noticeDays',    header: 'Notice Days',    type: 'number',   get: r => r.autoRenewalNoticeDays, width: 12 },
        { id: 'renewalValue',  header: 'Renewal Value',  type: 'currency', get: r => r.renewalValue, width: 14 },
        { id: 'department',    header: 'Department',     type: 'string',   get: r => r.department, width: 16 },
        { id: 'owner',         header: 'Owner',          type: 'string',   get: r => r.ownerDisplay, width: 18 },
        { id: 'poNumber',      header: 'PO Number',      type: 'string',   get: r => r.poNumber,   width: 14 },
      ],
      rows: data.rows,
    });
  } catch (err) {
    console.error('GET /reports/auto-renewal-exposure/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

// ── Vendor Concentration (Pareto) ────────────────────────────────────────────
// White-space report. Surfaces top-5 / 80% / tail-spend distribution.

async function buildVendorConcentration(req) {
  const accountId = req.user.accountId;
  const now = new Date();
  const period = ['fy', 'ytd', 'l12m'].includes(req.query.period) ? req.query.period : 'ytd';
  const startMonth = await loadFiscalYearStartMonth(accountId);

  let rangeStart, rangeEnd, rangeLabel;
  if (period === 'fy') {
    const fy = fiscalYearRange(now, startMonth, 0);
    rangeStart = fy.start; rangeEnd = fy.end; rangeLabel = fy.label + ' (full FY)';
  } else if (period === 'l12m') {
    rangeEnd = now;
    rangeStart = new Date(now.getTime() - 365 * 86400000);
    rangeLabel = 'Last 12 months';
  } else {
    // YTD — fiscal-year-aware
    const fy = fiscalYearRange(now, startMonth, 0);
    rangeStart = fy.start; rangeEnd = now;
    rangeLabel = fy.label + ' YTD';
  }

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      startDate: { gte: rangeStart, lt: rangeEnd },
      ...scopeWhere,
    },
    select: {
      totalValue: true, finalNegotiatedPrice: true, quantity: true, costPerLicense: true,
      vendor: { select: { id: true, name: true } },
    },
  });

  const byVendor = new Map();
  let totalSpend = 0;
  for (const c of contracts) {
    const s = contractSpend(c);
    totalSpend += s;
    const key = c.vendor?.id || '__unknown';
    if (!byVendor.has(key)) byVendor.set(key, { vendorName: c.vendor?.name || 'Unknown', spend: 0, contractCount: 0 });
    byVendor.get(key).spend += s;
    byVendor.get(key).contractCount += 1;
  }

  const sorted = [...byVendor.values()]
    .filter(v => v.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  // Cumulative + 80% cutoff
  let cumulative = 0;
  let cutoffIdx = null;
  const rows = sorted.map((v, idx) => {
    cumulative += v.spend;
    const cumulativePct = totalSpend > 0 ? (cumulative / totalSpend) * 100 : 0;
    const pct = totalSpend > 0 ? (v.spend / totalSpend) * 100 : 0;
    // Mark the first row where cumulative >= 80%
    if (cutoffIdx === null && cumulativePct >= 80) cutoffIdx = idx;
    return {
      rank: idx + 1,
      vendorName: v.vendorName,
      spend: v.spend,
      contractCount: v.contractCount,
      pct,
      cumulativePct,
      atCutoff: cutoffIdx === idx,
    };
  });

  const top5Spend = rows.slice(0, 5).reduce((s, r) => s + r.spend, 0);
  const top5Pct = totalSpend > 0 ? (top5Spend / totalSpend) * 100 : null;
  const top10Spend = rows.slice(0, 10).reduce((s, r) => s + r.spend, 0);
  const top10Pct = totalSpend > 0 ? (top10Spend / totalSpend) * 100 : null;
  // Vendors at or below the 80% line — the "head" of the distribution
  const headCount = cutoffIdx == null ? rows.length : (cutoffIdx + 1);
  const tailCount = rows.length - headCount;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    period, rangeLabel, rangeStart, rangeEnd,
    totalSpend, vendorCount: rows.length,
    top5Spend, top5Pct,
    top10Spend, top10Pct,
    headCount, tailCount, cutoffIdx,
    rows,
  };
}

router.get('/vendor-concentration', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildVendorConcentration(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/vendor-concentration:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/vendor-concentration/csv', requireManager, async (req, res) => {
  try {
    const data = await buildVendorConcentration(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Rank',           value: r => r.rank },
      { header: 'Vendor',         value: r => r.vendorName },
      { header: 'Spend',          value: r => r.spend.toFixed(2) },
      { header: 'Contracts',      value: r => r.contractCount },
      { header: 'Share %',        value: r => r.pct.toFixed(2) },
      { header: 'Cumulative %',   value: r => r.cumulativePct.toFixed(2) },
      { header: 'At 80% Cutoff',  value: r => r.atCutoff ? 'Yes' : '' },
    ]);
    sendCSV(res, `LapseIQ_Vendor_Concentration_${data.period}_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/vendor-concentration/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/vendor-concentration/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildVendorConcentration(req);
    await sendXlsx(res, {
      sheetName: 'Vendor Concentration',
      filename: `LapseIQ_Vendor_Concentration_${data.period}_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'rank',          header: 'Rank',          type: 'number',   get: r => r.rank, width: 8 },
        { id: 'vendor',        header: 'Vendor',        type: 'string',   get: r => r.vendorName, width: 28 },
        { id: 'spend',         header: 'Spend',         type: 'currency', get: r => r.spend, width: 16 },
        { id: 'contracts',     header: 'Contracts',     type: 'number',   get: r => r.contractCount, width: 12 },
        { id: 'pct',           header: 'Share %',       type: 'number',   get: r => Number(r.pct.toFixed(2)), width: 12 },
        { id: 'cumulativePct', header: 'Cumulative %',  type: 'number',   get: r => Number(r.cumulativePct.toFixed(2)), width: 14 },
        { id: 'atCutoff',      header: 'At 80% Cutoff', type: 'string',   get: r => r.atCutoff ? 'Yes' : '', width: 14 },
      ],
      rows: data.rows,
    });
  } catch (err) {
    console.error('GET /reports/vendor-concentration/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

// ── Non-SaaS Category Breakdown ──────────────────────────────────────────────
// White-space report. Buckets contracts by the account's non-SaaS categories
// (telecom, lease, insurance, hardware, services, utilities, supplies, other)
// with vendor count, contract count, total spend, and expiring-soon count.

async function buildNonSaaSCategories(req) {
  const accountId = req.user.accountId;
  const now = new Date();
  const expiringSoonCutoff = new Date(now.getTime() + 90 * 86400000);

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId,
      archivedAt: null,
      status: { in: ['active', 'under_review'] },
      categoryId: { not: null },
      category: { slug: { not: 'saas' } },
      ...scopeWhere,
    },
    select: {
      id: true, totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
      endDate: true,
      vendorId: true,
      categoryId: true,
      category: { select: { id: true, name: true, slug: true, icon: true, color: true } },
    },
  });

  const byCat = new Map();
  let totalSpend = 0;
  let totalContracts = 0;
  for (const c of contracts) {
    const key = c.categoryId;
    const spend = contractSpend(c);
    totalSpend += spend;
    totalContracts += 1;
    if (!byCat.has(key)) {
      byCat.set(key, {
        categoryId: c.categoryId,
        categoryName: c.category?.name || 'Uncategorized',
        categorySlug: c.category?.slug || null,
        categoryIcon: c.category?.icon || null,
        categoryColor: c.category?.color || null,
        spend: 0,
        contractCount: 0,
        vendors: new Set(),
        expiringSoon: 0,
      });
    }
    const bucket = byCat.get(key);
    bucket.spend += spend;
    bucket.contractCount += 1;
    if (c.vendorId) bucket.vendors.add(c.vendorId);
    if (c.endDate && new Date(c.endDate) >= now && new Date(c.endDate) <= expiringSoonCutoff) {
      bucket.expiringSoon += 1;
    }
  }

  const rows = [...byCat.values()]
    .map(b => ({
      categoryId: b.categoryId,
      categoryName: b.categoryName,
      categorySlug: b.categorySlug,
      categoryIcon: b.categoryIcon,
      categoryColor: b.categoryColor,
      spend: b.spend,
      contractCount: b.contractCount,
      vendorCount: b.vendors.size,
      expiringSoon: b.expiringSoon,
      sharePct: totalSpend > 0 ? (b.spend / totalSpend) * 100 : 0,
    }))
    .sort((a, b) => b.spend - a.spend);

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    totalSpend,
    totalContracts,
    categoryCount: rows.length,
    expiringSoonCount: rows.reduce((s, r) => s + r.expiringSoon, 0),
    rows,
  };
}

router.get('/non-saas-categories', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildNonSaaSCategories(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/non-saas-categories:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/non-saas-categories/csv', requireManager, async (req, res) => {
  try {
    const data = await buildNonSaaSCategories(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Category',       value: r => r.categoryName },
      { header: 'Vendor Count',   value: r => r.vendorCount },
      { header: 'Contract Count', value: r => r.contractCount },
      { header: 'Total Spend',    value: r => r.spend.toFixed(2) },
      { header: 'Share %',        value: r => r.sharePct.toFixed(2) },
      { header: 'Expiring 90d',   value: r => r.expiringSoon },
    ]);
    sendCSV(res, `LapseIQ_Non_SaaS_Categories_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/non-saas-categories/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/non-saas-categories/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildNonSaaSCategories(req);
    await sendXlsx(res, {
      sheetName: 'Non-SaaS Categories',
      filename: `LapseIQ_Non_SaaS_Categories_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'category',      header: 'Category',       type: 'string',   get: r => r.categoryName, width: 18 },
        { id: 'vendorCount',   header: 'Vendor Count',   type: 'number',   get: r => r.vendorCount, width: 14 },
        { id: 'contractCount', header: 'Contract Count', type: 'number',   get: r => r.contractCount, width: 16 },
        { id: 'spend',         header: 'Total Spend',    type: 'currency', get: r => r.spend, width: 16 },
        { id: 'sharePct',      header: 'Share %',        type: 'number',   get: r => Number(r.sharePct.toFixed(2)), width: 12 },
        { id: 'expiringSoon',  header: 'Expiring 90d',   type: 'number',   get: r => r.expiringSoon, width: 14 },
      ],
      rows: data.rows,
    });
  } catch (err) {
    console.error('GET /reports/non-saas-categories/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});


// Exported helpers for unit tests. The router is the default Express export
// via module.exports = router above; these named-style attachments keep the
// CommonJS contract simple.
// v0.58.1 - PDF endpoints for the three Tier-1 white-space reports added in
// v0.58.0. Same convention as /executive-spend/pdf, /renewal-horizon/pdf,
// /risk-radar/pdf, /savings-ledger/pdf, /license-wastage/pdf,
// /spend-ledger/pdf - parallel /pdf sub-routes off each report's base path
// (NOT a ?format=pdf query param, which would diverge from the established
// CSV/XLSX pattern in this file). Each is requireManager + scope-aware.

router.get('/auto-renewal-exposure/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildAutoRenewalExposure(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Auto_Renewal_Exposure_${data.horizon}d_${date}.pdf"`);
    streamAutoRenewalExposurePdf(res, data);
  } catch (err) {
    console.error('GET /reports/auto-renewal-exposure/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/vendor-concentration/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildVendorConcentration(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Vendor_Concentration_${data.period}_${date}.pdf"`);
    streamVendorConcentrationPdf(res, data);
  } catch (err) {
    console.error('GET /reports/vendor-concentration/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/non-saas-categories/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildNonSaaSCategories(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Non_SaaS_Categories_${date}.pdf"`);
    streamNonSaaSCategoriesPdf(res, data);
  } catch (err) {
    console.error('GET /reports/non-saas-categories/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});


// ── v0.59.0 reports — close the four stub placeholders ──────────────────────
// Co-Termination Opportunity, Renewal Commitment Forecast, Vendor Portfolio
// Heat Map, Audit Evidence Pack. All use the shared REPORT_QUERY_CAP +
// scopeRestricted patterns; mounted as base + /csv + /xlsx + /pdf parallel
// sub-routes to match the established convention.

// ── Co-Termination Opportunity ──────────────────────────────────────────────

async function buildCoTermOpportunity(req) {
  const accountId = req.user.accountId;
  const minSpread = Math.max(0, Math.min(parseInt(req.query.minSpread || '30', 10), 365));
  const now = new Date();

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: { in: ['active', 'under_review'] },
      coTermGroup: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      endDate: true,
      totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
      coTermGroup: true,
      internalOwnerName: true,
      vendor: { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { coTermGroup: 'asc' },
  });

  const grouped = new Map();
  for (const c of contracts) {
    if (!grouped.has(c.coTermGroup)) grouped.set(c.coTermGroup, []);
    grouped.get(c.coTermGroup).push(c);
  }

  const groups = [];
  let totalSpreadDays = 0;
  let totalAnnualValue = 0;
  let biggest: any = { groupName: null, value: 0 };
  let contractCount = 0;
  for (const [groupName, members] of grouped) {
    if (members.length < 2) continue;
    const dates = members.map(m => m.endDate ? new Date(m.endDate).getTime() : null).filter(Boolean);
    if (dates.length < 2) continue;
    const divergeDays = Math.round((Math.max(...dates) - Math.min(...dates)) / 86400000);
    if (divergeDays < minSpread) continue;
    const annualValue = members.reduce((s, m) => s + contractSpend(m), 0);
    // Savings heuristic: 3% of annual value (vendor leverage from a bundled
    // negotiation) + $500 per misaligned contract for admin overhead removed.
    // Conservative — Tier-2 candidates probably yield more; tunable later.
    const estimatedSavingsUsd = Math.round(annualValue * 0.03 + members.length * 500);
    const latestEnd = new Date(Math.max(...dates));
    const earliestEnd = new Date(Math.min(...dates));
    totalSpreadDays  += divergeDays;
    totalAnnualValue += annualValue;
    contractCount    += members.length;
    if (estimatedSavingsUsd > biggest.value) biggest = { groupName, value: estimatedSavingsUsd };

    groups.push({
      groupName,
      memberCount: members.length,
      divergeDays,
      currentEarliestEnd: earliestEnd,
      currentLatestEnd: latestEnd,
      proposedAlignedDate: latestEnd,
      annualValue,
      estimatedSavingsUsd,
      members: members.map(m => ({
        id: m.id,
        vendorName: m.vendor?.name || null,
        product: m.product,
        endDate: m.endDate,
        renewalValue: contractSpend(m),
        ownerDisplay: m.internalOwner?.name || m.internalOwnerName || null,
      })).sort((a, b) => (a.endDate ? new Date(a.endDate).getTime() : 0) - (b.endDate ? new Date(b.endDate).getTime() : 0)),
    });
  }
  // Largest opportunity (by est savings) first
  groups.sort((a, b) => b.estimatedSavingsUsd - a.estimatedSavingsUsd);

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    minSpread,
    groupCount: groups.length,
    contractCount,
    totalAnnualValue,
    totalSpreadDays,
    biggestOpportunityUsd: biggest.value,
    biggestOpportunityGroup: biggest.groupName,
    groups,
  };
}

router.get('/co-term-opportunity', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildCoTermOpportunity(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/co-term-opportunity:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/co-term-opportunity/csv', requireManager, async (req, res) => {
  try {
    const data = await buildCoTermOpportunity(req);
    // Flatten groups -> member rows so the CSV is a true fact table
    const flat = data.groups.flatMap(g => g.members.map(m => ({
      groupName: g.groupName, divergeDays: g.divergeDays,
      proposedAlignedDate: g.proposedAlignedDate,
      annualValue: g.annualValue, estimatedSavingsUsd: g.estimatedSavingsUsd,
      ...m,
    })));
    const csv = toCSV(flat, [
      { header: 'Group',                 value: r => r.groupName },
      { header: 'Group Spread (days)',   value: r => r.divergeDays },
      { header: 'Proposed Aligned Date', value: r => r.proposedAlignedDate ? new Date(r.proposedAlignedDate).toISOString().split('T')[0] : '' },
      { header: 'Group Annual Value',    value: r => r.annualValue != null ? r.annualValue.toFixed(2) : '' },
      { header: 'Group Est Savings',     value: r => r.estimatedSavingsUsd != null ? r.estimatedSavingsUsd.toFixed(2) : '' },
      { header: 'Vendor',                value: r => r.vendorName },
      { header: 'Product',               value: r => r.product },
      { header: 'End Date',              value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Renewal Value',         value: r => r.renewalValue != null ? r.renewalValue.toFixed(2) : '' },
      { header: 'Owner',                 value: r => r.ownerDisplay },
    ]);
    sendCSV(res, `LapseIQ_Co_Term_Opportunity_${data.minSpread}d_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/co-term-opportunity/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/co-term-opportunity/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildCoTermOpportunity(req);
    const flat = data.groups.flatMap(g => g.members.map(m => ({
      groupName: g.groupName, divergeDays: g.divergeDays,
      proposedAlignedDate: g.proposedAlignedDate,
      annualValue: g.annualValue, estimatedSavingsUsd: g.estimatedSavingsUsd,
      ...m,
    })));
    await sendXlsx(res, {
      sheetName: 'Co-Term Opportunity',
      filename: `LapseIQ_Co_Term_Opportunity_${data.minSpread}d_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'group',     header: 'Group',                 type: 'string',   get: r => r.groupName, width: 22 },
        { id: 'spread',    header: 'Group Spread (days)',   type: 'number',   get: r => r.divergeDays, width: 14 },
        { id: 'proposed',  header: 'Proposed Aligned Date', type: 'date',     get: r => r.proposedAlignedDate, width: 16 },
        { id: 'annual',    header: 'Group Annual Value',    type: 'currency', get: r => r.annualValue, width: 16 },
        { id: 'savings',   header: 'Group Est Savings',     type: 'currency', get: r => r.estimatedSavingsUsd, width: 16 },
        { id: 'vendor',    header: 'Vendor',                type: 'string',   get: r => r.vendorName, width: 22 },
        { id: 'product',   header: 'Product',               type: 'string',   get: r => r.product, width: 28 },
        { id: 'endDate',   header: 'End Date',              type: 'date',     get: r => r.endDate, width: 12 },
        { id: 'value',     header: 'Renewal Value',         type: 'currency', get: r => r.renewalValue, width: 14 },
        { id: 'owner',     header: 'Owner',                 type: 'string',   get: r => r.ownerDisplay, width: 18 },
      ],
      rows: flat,
    });
  } catch (err) {
    console.error('GET /reports/co-term-opportunity/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/co-term-opportunity/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildCoTermOpportunity(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Co_Term_Opportunity_${data.minSpread}d_${date}.pdf"`);
    streamCoTermOpportunityPdf(res, data);
  } catch (err) {
    console.error('GET /reports/co-term-opportunity/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

// ── Renewal Commitment Forecast ─────────────────────────────────────────────

async function buildRenewalCommitmentForecast(req) {
  const accountId = req.user.accountId;
  const horizon = Math.max(1, Math.min(parseInt(req.query.horizon || '12', 10), 24));
  const now = new Date();
  const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + horizon, 1));

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: { in: ['active', 'under_review'] },
      endDate: { gte: startUtc, lt: cutoff },
      ...scopeWhere,
    },
    select: {
      id: true, endDate: true, autoRenewal: true,
      totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
    },
    orderBy: { endDate: 'asc' },
  });

  // Pre-seed month buckets so empty months still appear in the timeline.
  const months = [];
  for (let i = 0; i < horizon; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push({ yyyy_mm: ym, contractCount: 0, renewalValue: 0, cumulativeValue: 0, autoRenewCount: 0, autoRenewValue: 0 });
  }
  const idxByYm = new Map(months.map((m, i) => [m.yyyy_mm, i]));

  let totalCommitment = 0;
  let autoRenewValue = 0;
  let autoRenewCount = 0;
  for (const c of contracts) {
    if (!c.endDate) continue;
    const d = new Date(c.endDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const idx = idxByYm.get(ym);
    if (idx == null) continue;
    const v = contractSpend(c);
    months[idx].contractCount += 1;
    months[idx].renewalValue  += v;
    totalCommitment += v;
    if (c.autoRenewal) {
      months[idx].autoRenewCount += 1;
      months[idx].autoRenewValue += v;
      autoRenewCount += 1;
      autoRenewValue += v;
    }
  }
  // cumulative running total
  let running = 0;
  let biggestMonth = null;
  for (const m of months) {
    running += m.renewalValue;
    m.cumulativeValue = running;
    if (!biggestMonth || m.renewalValue > biggestMonth.renewalValue) biggestMonth = m;
  }
  // Don't claim a biggest month if there are no renewals at all
  if (biggestMonth && biggestMonth.renewalValue === 0) biggestMonth = null;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    horizon,
    totalContracts: contracts.length,
    totalCommitment,
    autoRenewCount,
    autoRenewValue,
    autoRenewSharePct: totalCommitment > 0 ? (autoRenewValue / totalCommitment) * 100 : null,
    biggestMonth: biggestMonth ? { yyyy_mm: biggestMonth.yyyy_mm, renewalValue: biggestMonth.renewalValue } : null,
    months,
  };
}

router.get('/renewal-commitment-forecast', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildRenewalCommitmentForecast(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/renewal-commitment-forecast:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/renewal-commitment-forecast/csv', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalCommitmentForecast(req);
    const csv = toCSV(data.months, [
      { header: 'Month',           value: r => r.yyyy_mm },
      { header: 'Contracts',       value: r => r.contractCount },
      { header: 'Renewal Value',   value: r => r.renewalValue.toFixed(2) },
      { header: 'Cumulative',      value: r => r.cumulativeValue.toFixed(2) },
      { header: 'Auto-Renew Count',value: r => r.autoRenewCount },
      { header: 'Auto-Renew Value',value: r => r.autoRenewValue.toFixed(2) },
    ]);
    sendCSV(res, `LapseIQ_Renewal_Commitment_Forecast_${data.horizon}mo_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/renewal-commitment-forecast/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/renewal-commitment-forecast/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalCommitmentForecast(req);
    await sendXlsx(res, {
      sheetName: 'Renewal Commitment',
      filename: `LapseIQ_Renewal_Commitment_Forecast_${data.horizon}mo_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'month',    header: 'Month',            type: 'string',   get: r => r.yyyy_mm, width: 12 },
        { id: 'count',    header: 'Contracts',        type: 'number',   get: r => r.contractCount, width: 12 },
        { id: 'value',    header: 'Renewal Value',    type: 'currency', get: r => r.renewalValue, width: 16 },
        { id: 'cum',      header: 'Cumulative',       type: 'currency', get: r => r.cumulativeValue, width: 18 },
        { id: 'autocnt',  header: 'Auto-Renew Count', type: 'number',   get: r => r.autoRenewCount, width: 16 },
        { id: 'autoval',  header: 'Auto-Renew Value', type: 'currency', get: r => r.autoRenewValue, width: 16 },
      ],
      rows: data.months,
    });
  } catch (err) {
    console.error('GET /reports/renewal-commitment-forecast/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/renewal-commitment-forecast/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalCommitmentForecast(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Renewal_Commitment_Forecast_${data.horizon}mo_${date}.pdf"`);
    streamRenewalCommitmentForecastPdf(res, data);
  } catch (err) {
    console.error('GET /reports/renewal-commitment-forecast/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

// ── Vendor Portfolio Heat Map ───────────────────────────────────────────────

async function buildVendorHeatMap(req) {
  const accountId = req.user.accountId;
  const now = new Date();

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  // Pull all vendors for this account (active and inactive) so the "unset"
  // row reflects every vendor that hasn't been tiered, not just those with
  // current contracts. Filter contracts to active so spend reflects active
  // commitment only.
  const [vendors, contracts] = await Promise.all([
    prisma.vendor.findMany({
      where: { accountId },
      select: { id: true, name: true, criticalityTier: true },
    }),
    prisma.contract.findMany({
      take: REPORT_QUERY_CAP,
      where: {
        accountId, archivedAt: null,
        status: { in: ['active', 'under_review'] },
        ...scopeWhere,
      },
      select: {
        vendorId: true,
        totalValue: true, finalNegotiatedPrice: true,
        quantity: true, costPerLicense: true,
      },
    }),
  ]);

  const spendByVendor = new Map();
  for (const c of contracts) {
    if (!c.vendorId) continue;
    const s = contractSpend(c);
    spendByVendor.set(c.vendorId, (spendByVendor.get(c.vendorId) || 0) + s);
  }

  function bucketIdFor(spend) {
    if (spend > 1_000_000)         return 'gt_1m';
    if (spend >= 100_000)          return '100k_1m';
    if (spend >= 10_000)           return '10k_100k';
    return 'lt_10k';
  }
  function tierKey(t) {
    if (t === 'tier_1' || t === 'tier_2' || t === 'tier_3' || t === 'tier_4') return t;
    return 'unset';
  }

  // Initialise the 5-row x 4-col grid
  const TIERS = ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'unset'];
  const BUCKETS = ['gt_1m', '100k_1m', '10k_100k', 'lt_10k'];
  const grid: any = {};
  for (const t of TIERS) {
    grid[t] = {};
    for (const b of BUCKETS) grid[t][b] = { vendorCount: 0, spend: 0 };
  }

  let vendorCount = 0;
  let tier1Count = 0;
  let unsetCount = 0;
  let tier4Spend = 0;
  let totalSpend = 0;
  const tier1Vendors = [];
  const tier4Vendors = [];
  for (const v of vendors) {
    const spend = spendByVendor.get(v.id) || 0;
    // Skip vendors with zero active spend AND no tier set — they're noise.
    // Keep zero-spend vendors that ARE tiered so the strategic-gap surface fires.
    const tk = tierKey(v.criticalityTier);
    if (spend === 0 && tk === 'unset') continue;
    vendorCount += 1;
    totalSpend += spend;
    const bk = bucketIdFor(spend);
    grid[tk][bk].vendorCount += 1;
    grid[tk][bk].spend += spend;
    if (tk === 'tier_1') {
      tier1Count += 1;
      if (bk === 'lt_10k') tier1Vendors.push({ vendorId: v.id, vendorName: v.name, spend });
    }
    if (tk === 'tier_4') {
      tier4Spend += spend;
      if (bk === 'gt_1m' || bk === '100k_1m') tier4Vendors.push({ vendorId: v.id, vendorName: v.name, spend });
    }
    if (tk === 'unset') unsetCount += 1;
  }
  tier1Vendors.sort((a, b) => b.spend - a.spend);
  tier4Vendors.sort((a, b) => b.spend - a.spend);

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    vendorCount,
    tier1Count,
    tier1CoveragePct: vendorCount > 0 ? ((vendorCount - unsetCount) / vendorCount) * 100 : null,
    tier4Spend,
    tier4Pct: totalSpend > 0 ? (tier4Spend / totalSpend) * 100 : null,
    unsetCount,
    grid,
    rationalizationCandidates: tier4Vendors.slice(0, 8),
    strategicGaps: tier1Vendors.slice(0, 8),
  };
}

router.get('/vendor-heat-map', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildVendorHeatMap(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/vendor-heat-map:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/vendor-heat-map/csv', requireManager, async (req, res) => {
  try {
    const data = await buildVendorHeatMap(req);
    const BUCKET_LABELS: any = { gt_1m: '> $1M', '100k_1m': '$100K-$1M', '10k_100k': '$10K-$100K', lt_10k: '< $10K' };
    const flat = [];
    for (const tier of ['tier_1','tier_2','tier_3','tier_4','unset']) {
      for (const b of ['gt_1m','100k_1m','10k_100k','lt_10k']) {
        const cell = data.grid?.[tier]?.[b] || { vendorCount: 0, spend: 0 };
        flat.push({ tier, bucket: BUCKET_LABELS[b], vendorCount: cell.vendorCount, spend: cell.spend });
      }
    }
    const csv = toCSV(flat, [
      { header: 'Criticality Tier', value: r => r.tier },
      { header: 'Spend Bucket',     value: r => r.bucket },
      { header: 'Vendor Count',     value: r => r.vendorCount },
      { header: 'Spend',            value: r => r.spend.toFixed(2) },
    ]);
    sendCSV(res, `LapseIQ_Vendor_Heat_Map_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/vendor-heat-map/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/vendor-heat-map/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildVendorHeatMap(req);
    const BUCKET_LABELS: any = { gt_1m: '> $1M', '100k_1m': '$100K-$1M', '10k_100k': '$10K-$100K', lt_10k: '< $10K' };
    const flat = [];
    for (const tier of ['tier_1','tier_2','tier_3','tier_4','unset']) {
      for (const b of ['gt_1m','100k_1m','10k_100k','lt_10k']) {
        const cell = data.grid?.[tier]?.[b] || { vendorCount: 0, spend: 0 };
        flat.push({ tier, bucket: BUCKET_LABELS[b], vendorCount: cell.vendorCount, spend: cell.spend });
      }
    }
    await sendXlsx(res, {
      sheetName: 'Vendor Heat Map',
      filename: `LapseIQ_Vendor_Heat_Map_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'tier',   header: 'Criticality Tier', type: 'string',   get: r => r.tier, width: 16 },
        { id: 'bucket', header: 'Spend Bucket',     type: 'string',   get: r => r.bucket, width: 16 },
        { id: 'count',  header: 'Vendor Count',     type: 'number',   get: r => r.vendorCount, width: 14 },
        { id: 'spend',  header: 'Spend',            type: 'currency', get: r => r.spend, width: 16 },
      ],
      rows: flat,
    });
  } catch (err) {
    console.error('GET /reports/vendor-heat-map/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/vendor-heat-map/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildVendorHeatMap(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Vendor_Heat_Map_${date}.pdf"`);
    streamVendorPortfolioHeatMapPdf(res, data);
  } catch (err) {
    console.error('GET /reports/vendor-heat-map/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

// ── Audit Evidence Pack ─────────────────────────────────────────────────────

async function buildAuditEvidencePack(req) {
  const accountId = req.user.accountId;
  const now = new Date();

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  // Pull active contracts with the columns auditors typically ask for. Past-
  // cancel-by + missing-signer are derived from this set so we only hit the
  // DB once for the main fact table.
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: { in: ['active', 'under_review'] },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      endDate: true, cancelByDate: true, autoRenewal: true,
      signerName: true, signedAt: true,
      totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
      vendorId: true,
      vendor: { select: { id: true, name: true, supportEmail: true, supportPhone: true, supportPortalUrl: true } },
      category: { select: { slug: true, name: true } },
    },
    orderBy: { vendor: { name: 'asc' } },
  });

  const activeInventory = contracts.map(c => ({
    id: c.id,
    vendorName: c.vendor?.name || null,
    product: c.product,
    signerName: c.signerName || null,
    endDate: c.endDate,
    autoRenewal: !!c.autoRenewal,
    cancelByDate: c.cancelByDate,
    value: contractSpend(c),
  }));

  const pastCancelBy = contracts
    .filter(c => c.cancelByDate && new Date(c.cancelByDate) < now)
    .map(c => ({
      id: c.id,
      vendorName: c.vendor?.name || null,
      product: c.product,
      cancelByDate: c.cancelByDate,
      daysOverdue: Math.ceil((now.getTime() - new Date(c.cancelByDate).getTime()) / 86400000),
      value: contractSpend(c),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  // Sensitive-data heuristic: vendor's primary category slug = saas | services |
  // cloud. LapseIQ has no first-class dataClassification field yet (flagged in
  // missingEvidence). Aggregating at vendor level so the report shows a list
  // of relationships, not duplicates per contract.
  const SENSITIVE_SLUGS = new Set(['saas', 'services', 'cloud']);
  const sensitiveMap = new Map();
  for (const c of contracts) {
    const slug = c.category?.slug;
    if (!slug || !SENSITIVE_SLUGS.has(slug)) continue;
    const key = c.vendor?.id || c.vendorId;
    if (!key) continue;
    if (!sensitiveMap.has(key)) {
      sensitiveMap.set(key, {
        vendorId: key,
        vendorName: c.vendor?.name || 'Unknown',
        reason: `${c.category?.name || slug} category`,
        contractCount: 0,
      });
    }
    sensitiveMap.get(key).contractCount += 1;
  }
  const sensitiveDataVendors = [...sensitiveMap.values()].sort((a, b) => b.contractCount - a.contractCount);

  // Vendor support contacts on file — only vendors that have at least one
  // active contract (auditors don't care about churned vendors here).
  const activeVendorIds = new Set(contracts.map(c => c.vendor?.id).filter(Boolean));
  const supportContacts = [];
  const seenVendor = new Set();
  for (const c of contracts) {
    const v = c.vendor;
    if (!v || seenVendor.has(v.id)) continue;
    seenVendor.add(v.id);
    if (v.supportEmail || v.supportPhone || v.supportPortalUrl) {
      supportContacts.push({
        vendorId: v.id,
        vendorName: v.name,
        email: v.supportEmail || null,
        phone: v.supportPhone || null,
        portalUrl: v.supportPortalUrl || null,
      });
    }
  }
  // Also surface vendors with NO contact info on file (they need it for breach notif).
  for (const c of contracts) {
    const v = c.vendor;
    if (!v || seenVendor.has(v.id)) continue;
    seenVendor.add(v.id);
    supportContacts.push({ vendorId: v.id, vendorName: v.name, email: null, phone: null, portalUrl: null });
  }
  supportContacts.sort((a, b) => {
    const aHas = !!(a.email || a.phone || a.portalUrl);
    const bHas = !!(b.email || b.phone || b.portalUrl);
    if (aHas !== bHas) return Number(bHas) - Number(aHas); // contacts-on-file first
    return a.vendorName.localeCompare(b.vendorName);
  });

  // Missing evidence callouts — schema-honest list. v0.59 ships against the
  // existing schema; v0.60 candidates are listed here so customers see the gap
  // rather than the report silently omitting it.
  const missingSignerCount   = contracts.filter(c => !c.signerName).length;
  const missingEndDateCount  = contracts.filter(c => !c.endDate).length;
  const missingEvidence = [
    { field: 'DPA status (per-vendor Data Processing Agreement)', note: 'No first-class field today. Customers can add a custom field URL; v0.60 candidate to make this first-class.' },
    { field: 'Data classification (PII / PHI / financial / public)', note: 'No first-class field today. Sensitive-data flag in this report uses a category heuristic; v0.60 candidate.' },
    { field: 'SOC2 / ISO 27001 attestation expiry per vendor', note: 'Not tracked. Vendor risk reports require auditors verify currency.' },
    { field: 'Approval-chain audit trail per contract', note: 'Activity log captures contract create/update, but signature-approval workflow is not modelled.' },
  ];
  if (missingSignerCount > 0) missingEvidence.push({ field: 'Signer name', note: `${missingSignerCount} active contract${missingSignerCount === 1 ? '' : 's'} have no signer recorded.` });
  if (missingEndDateCount > 0) missingEvidence.push({ field: 'End date', note: `${missingEndDateCount} active contract${missingEndDateCount === 1 ? '' : 's'} have no end-date recorded.` });

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    activeCount: activeInventory.length,
    vendorCount: activeVendorIds.size,
    pastCancelByCount: pastCancelBy.length,
    missingSignerCount,
    missingEndDateCount,
    activeInventory,
    sensitiveDataVendors,
    pastCancelBy,
    supportContacts,
    missingEvidence,
  };
}

router.get('/audit-evidence-pack', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildAuditEvidencePack(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/audit-evidence-pack:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/audit-evidence-pack/csv', requireManager, async (req, res) => {
  try {
    const data = await buildAuditEvidencePack(req);
    // Export the active inventory (the primary fact table). The composition
    // sections (sensitive vendors / past cancel-by / contacts / missing-evidence)
    // live in the on-screen UI and the PDF export.
    const csv = toCSV(data.activeInventory, [
      { header: 'Vendor',       value: r => r.vendorName },
      { header: 'Product',      value: r => r.product },
      { header: 'Signer',       value: r => r.signerName || 'MISSING' },
      { header: 'End Date',     value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Auto-Renewal', value: r => r.autoRenewal ? 'Yes' : 'No' },
      { header: 'Cancel By',    value: r => r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : '' },
      { header: 'Value',        value: r => r.value != null ? r.value.toFixed(2) : '' },
    ]);
    sendCSV(res, `LapseIQ_Audit_Evidence_Pack_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/audit-evidence-pack/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/audit-evidence-pack/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildAuditEvidencePack(req);
    await sendXlsx(res, {
      sheetName: 'Audit Evidence',
      filename: `LapseIQ_Audit_Evidence_Pack_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'vendor',  header: 'Vendor',       type: 'string',   get: r => r.vendorName, width: 22 },
        { id: 'product', header: 'Product',      type: 'string',   get: r => r.product, width: 28 },
        { id: 'signer',  header: 'Signer',       type: 'string',   get: r => r.signerName || 'MISSING', width: 18 },
        { id: 'end',     header: 'End Date',     type: 'date',     get: r => r.endDate, width: 12 },
        { id: 'auto',    header: 'Auto-Renewal', type: 'string',   get: r => r.autoRenewal ? 'Yes' : 'No', width: 12 },
        { id: 'cancel',  header: 'Cancel By',    type: 'date',     get: r => r.cancelByDate, width: 12 },
        { id: 'value',   header: 'Value',        type: 'currency', get: r => r.value, width: 14 },
      ],
      rows: data.activeInventory,
    });
  } catch (err) {
    console.error('GET /reports/audit-evidence-pack/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/audit-evidence-pack/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildAuditEvidencePack(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Audit_Evidence_Pack_${date}.pdf"`);
    streamAuditEvidencePackPdf(res, data);
  } catch (err) {
    console.error('GET /reports/audit-evidence-pack/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});


// ── Application Portfolio Overlap (v0.60.0) ─────────────────────────────────
// Surfaces multi-vendor categories + (for SaaS) functional-bucket overlap.
// Read-only aggregation; no schema changes; uses existing Category + Vendor.

// Keyword-stem map for the SaaS sub-category heuristic. Order matters in case
// a product name matches multiple buckets — first match wins. Keep stems
// lowercase and substring-matchable against `product` (also lowercased).
const SAAS_FUNCTIONAL_BUCKETS = [
  { id: 'communication', label: 'Team communication / chat', stems: ['slack', 'teams', 'webex teams', 'mattermost', 'rocket.chat', 'chime'] },
  { id: 'meeting',       label: 'Video meeting',             stems: ['zoom', 'webex', 'gotomeeting', 'google meet', 'whereby', 'jitsi'] },
  { id: 'crm',           label: 'CRM',                       stems: ['salesforce', 'hubspot', 'pipedrive', 'dynamics 365', 'sugarcrm', 'copper', 'zoho crm', 'close.io'] },
  { id: 'helpdesk',      label: 'Customer support / helpdesk', stems: ['zendesk', 'freshdesk', 'intercom', 'helpscout', 'kayako', 'help scout', 'jira service'] },
  { id: 'storage',       label: 'File storage / sharing',    stems: ['dropbox', 'box.com', 'onedrive', 'sharepoint', 'google drive', 'gdrive', 'egnyte', 'sync.com'] },
  { id: 'security',      label: 'Identity / password mgmt',  stems: ['okta', 'auth0', '1password', 'lastpass', 'bitwarden', 'dashlane', 'duo', 'jumpcloud'] },
  { id: 'analytics',     label: 'Product analytics',         stems: ['tableau', 'looker', 'mixpanel', 'amplitude', 'heap', 'fullstory', 'hotjar', 'pendo'] },
  { id: 'project',       label: 'Project / task management', stems: ['jira', 'asana', 'monday.com', 'monday ', 'clickup', 'basecamp', 'trello', 'smartsheet', 'notion', 'linear'] },
  { id: 'design',        label: 'Design / whiteboard',       stems: ['figma', 'sketch', 'adobe creative', 'invision', 'canva', 'miro', 'mural'] },
  { id: 'email',         label: 'Email delivery',            stems: ['mailchimp', 'sendgrid', 'postmark', 'mailgun', 'mandrill', 'sparkpost', 'amazon ses'] },
  { id: 'video',         label: 'Video hosting',             stems: ['vimeo', 'wistia', 'loom', 'brightcove', 'mux.com'] },
  { id: 'esign',         label: 'E-signature',               stems: ['docusign', 'hellosign', 'adobe sign', 'pandadoc', 'signnow', 'eversign'] },
];

function bucketForProductName(productName) {
  if (!productName) return null;
  const p = productName.toLowerCase();
  for (const b of SAAS_FUNCTIONAL_BUCKETS) {
    for (const stem of b.stems) {
      if (p.includes(stem)) return b;
    }
  }
  return null;
}

async function buildApplicationOverlap(req) {
  const accountId = req.user.accountId;
  const now = new Date();

  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: { in: ['active', 'under_review'] },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      totalValue: true, finalNegotiatedPrice: true,
      quantity: true, costPerLicense: true,
      department: true, internalOwnerName: true,
      vendorId: true,
      vendor: { select: { id: true, name: true } },
      categoryId: true,
      category: { select: { id: true, name: true, slug: true } },
      internalOwner: { select: { name: true } },
    },
  });

  // Per-contract decorate
  const rows = contracts.map(c => ({
    id: c.id, product: c.product || '',
    vendorId: c.vendor?.id || c.vendorId || null,
    vendorName: c.vendor?.name || 'Unknown',
    categoryId: c.category?.id || c.categoryId || null,
    categoryName: c.category?.name || 'Uncategorized',
    categorySlug: c.category?.slug || null,
    department: c.department || null,
    ownerDisplay: c.internalOwner?.name || c.internalOwnerName || null,
    spend: contractSpend(c),
  }));

  // Layer 1: bucket by Category. A "category overlap" group emerges when 2+
  // distinct vendors share a category. SaaS-category contracts are routed
  // into Layer 2 instead of into the generic SaaS bucket (saas-as-a-whole
  // is too coarse to be actionable).
  const byCategory = new Map();
  for (const r of rows) {
    const isSaas = r.categorySlug === 'saas';
    if (isSaas) continue;  // routed to Layer 2
    const key = r.categoryId || ('name:' + r.categoryName);
    if (!byCategory.has(key)) byCategory.set(key, { id: 'cat:' + key, label: r.categoryName, heuristic: 'category', members: [], vendorIds: new Set(), totalSpend: 0 });
    const g = byCategory.get(key);
    g.members.push(r);
    if (r.vendorId) g.vendorIds.add(r.vendorId);
    g.totalSpend += r.spend;
  }

  // Layer 2: SaaS sub-bucket
  const bySaasBucket = new Map();
  let saasUnbucketedCount = 0;
  for (const r of rows) {
    if (r.categorySlug !== 'saas') continue;
    const b = bucketForProductName(r.product);
    if (!b) { saasUnbucketedCount += 1; continue; }
    const key = b.id;
    if (!bySaasBucket.has(key)) bySaasBucket.set(key, { id: 'saas:' + key, label: b.label, heuristic: 'saas-bucket', members: [], vendorIds: new Set(), totalSpend: 0 });
    const g = bySaasBucket.get(key);
    g.members.push(r);
    if (r.vendorId) g.vendorIds.add(r.vendorId);
    g.totalSpend += r.spend;
  }

  // Keep only groups with multi-vendor overlap (the entire point of the report)
  const allGroups = [...byCategory.values(), ...bySaasBucket.values()]
    .filter(g => g.vendorIds.size >= 2)
    .map(g => ({
      id: g.id, label: g.label, heuristic: g.heuristic,
      vendorCount: g.vendorIds.size,
      totalSpend: g.totalSpend,
      members: g.members.sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.totalSpend - a.totalSpend);

  const totalAddressableSpend = allGroups.reduce((s, g) => s + g.totalSpend, 0);
  const contractCount = allGroups.reduce((s, g) => s + g.members.length, 0);
  const biggestOverlap = allGroups.length > 0 ? { label: allGroups[0].label, spend: allGroups[0].totalSpend } : null;
  const saasBucketCount = bySaasBucket.size;

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  return {
    _meta: _mkMeta(contracts || []),
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    groupCount: allGroups.length,
    contractCount,
    totalAddressableSpend,
    biggestOverlap,
    saasBucketCount,
    saasUnbucketedCount,
    groups: allGroups,
  };
}

router.get('/application-overlap', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildApplicationOverlap(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/application-overlap:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

router.get('/application-overlap/csv', requireManager, async (req, res) => {
  try {
    const data = await buildApplicationOverlap(req);
    const flat = data.groups.flatMap(g => g.members.map(m => ({
      groupLabel: g.label, heuristic: g.heuristic,
      groupVendorCount: g.vendorCount, groupTotalSpend: g.totalSpend,
      ...m,
    })));
    const csv = toCSV(flat, [
      { header: 'Group',             value: r => r.groupLabel },
      { header: 'Heuristic',         value: r => r.heuristic },
      { header: 'Group Vendor Count',value: r => r.groupVendorCount },
      { header: 'Group Total Spend', value: r => r.groupTotalSpend != null ? r.groupTotalSpend.toFixed(2) : '' },
      { header: 'Vendor',            value: r => r.vendorName },
      { header: 'Product',           value: r => r.product },
      { header: 'Category',          value: r => r.categoryName },
      { header: 'Department',        value: r => r.department },
      { header: 'Owner',             value: r => r.ownerDisplay },
      { header: 'Spend',             value: r => r.spend != null ? r.spend.toFixed(2) : '' },
    ]);
    sendCSV(res, `LapseIQ_Application_Overlap_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/application-overlap/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/application-overlap/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildApplicationOverlap(req);
    const flat = data.groups.flatMap(g => g.members.map(m => ({
      groupLabel: g.label, heuristic: g.heuristic,
      groupVendorCount: g.vendorCount, groupTotalSpend: g.totalSpend,
      ...m,
    })));
    await sendXlsx(res, {
      sheetName: 'Application Overlap',
      filename: `LapseIQ_Application_Overlap_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'group',     header: 'Group',              type: 'string',   get: r => r.groupLabel, width: 28 },
        { id: 'heur',      header: 'Heuristic',          type: 'string',   get: r => r.heuristic, width: 14 },
        { id: 'gvc',       header: 'Group Vendor Count', type: 'number',   get: r => r.groupVendorCount, width: 16 },
        { id: 'gts',       header: 'Group Total Spend',  type: 'currency', get: r => r.groupTotalSpend, width: 18 },
        { id: 'vendor',    header: 'Vendor',             type: 'string',   get: r => r.vendorName, width: 22 },
        { id: 'product',   header: 'Product',            type: 'string',   get: r => r.product, width: 28 },
        { id: 'category',  header: 'Category',           type: 'string',   get: r => r.categoryName, width: 16 },
        { id: 'dept',      header: 'Department',         type: 'string',   get: r => r.department, width: 18 },
        { id: 'owner',     header: 'Owner',              type: 'string',   get: r => r.ownerDisplay, width: 18 },
        { id: 'spend',     header: 'Spend',              type: 'currency', get: r => r.spend, width: 14 },
      ],
      rows: flat,
    });
  } catch (err) {
    console.error('GET /reports/application-overlap/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/application-overlap/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildApplicationOverlap(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Application_Overlap_${date}.pdf"`);
    streamApplicationOverlapPdf(res, data);
  } catch (err) {
    console.error('GET /reports/application-overlap/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

// #19 part 2 - Microsoft 365 Overlap report. Consumes the shared detection
// module (computeM365OverlapForAccount) and shapes a single anchor group of
// displaceable contracts. When no qualifying M365 suite license exists the
// payload reads "no anchor" (hasAnchor=false, empty group).
async function buildM365Overlap(req) {
  const accountId = req.user.accountId;
  const now = new Date();
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;

  const overlap = await computeM365OverlapForAccount(prisma, { accountId, scopeWhere });

  const account = await prisma.account.findUnique({
    where: { id: accountId }, select: { companyName: true },
  });

  const members = (overlap.overlaps || []);
  const hasOverlap = !!(overlap.hasAnchor && members.length > 0);

  // One group = the M365 anchor + every displaceable contract it covers. The
  // client sub-groups members by capability for readability.
  const groups = hasOverlap ? [{
    id: 'm365:' + overlap.anchor.id,
    anchorVendor: overlap.anchor.vendorName,
    anchorProduct: overlap.anchor.product,
    anchorTier: overlap.anchor.tier,
    effectiveTier: overlap.anchorTier,
    contractId: overlap.anchor.id,
    totalSpend: overlap.totalSpendAtStake,
    members,
  }] : [];

  // The shared loader bounds its scan internally; surface a non-truncated meta
  // envelope shaped like the other reports so TruncationBanner stays inert.
  const _meta = { truncated: false, returnedCount: members.length, totalCount: members.length };

  return {
    _meta,
    companyName: account?.companyName || 'Your Company',
    generatedAt: now,
    generatedBy: req.user.name || req.user.email || null,
    scopeRestricted: !!req.user.contractScopeRestricted,
    hasAnchor: !!overlap.hasAnchor,
    anchor: overlap.hasAnchor ? overlap.anchor : null,
    anchorTier: overlap.anchorTier,
    overlapCount: members.length,
    totalSpendAtStake: overlap.totalSpendAtStake || 0,
    groups,
  };
}

router.get('/m365-overlap', requireManager, async (req, res) => {
  try {
    const { _meta: meta, ...data } = await buildM365Overlap(req);
    res.json({ success: true, data, meta });
  } catch (err) {
    console.error('GET /reports/m365-overlap:', err);
    res.status(500).json({ success: false, error: 'Failed to build report.' });
  }
});

function _m365Flat(data) {
  const anchorLabel = data.anchor ? (data.anchor.vendorName + ' ' + data.anchor.product).trim() : '';
  const members = (data.groups[0] && data.groups[0].members) || [];
  return members.map(m => ({ anchor: anchorLabel, anchorTier: data.anchorTier, ...m }));
}

router.get('/m365-overlap/csv', requireManager, async (req, res) => {
  try {
    const data = await buildM365Overlap(req);
    const flat = _m365Flat(data);
    const csv = toCSV(flat, [
      { header: 'M365 Anchor',         value: r => r.anchor },
      { header: 'Anchor Tier',         value: r => r.anchorTier },
      { header: 'Vendor',              value: r => r.vendorName },
      { header: 'Product',             value: r => r.product },
      { header: 'Capability Replaced', value: r => r.capability },
      { header: 'Requires Tier',       value: r => r.requiresTier },
      { header: 'Department',          value: r => r.department },
      { header: 'Spend At Stake',      value: r => r.spend != null ? r.spend.toFixed(2) : '' },
    ]);
    sendCSV(res, `LapseIQ_M365_Overlap_${new Date().toISOString().split('T')[0]}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/m365-overlap/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/m365-overlap/xlsx', requireManager, async (req, res) => {
  try {
    const data = await buildM365Overlap(req);
    const flat = _m365Flat(data);
    await sendXlsx(res, {
      sheetName: 'M365 Overlap',
      filename: `LapseIQ_M365_Overlap_${new Date().toISOString().split('T')[0]}.xlsx`,
      columnDefs: [
        { id: 'anchor',  header: 'M365 Anchor',         type: 'string',   get: r => r.anchor, width: 26 },
        { id: 'tier',    header: 'Anchor Tier',         type: 'string',   get: r => r.anchorTier, width: 12 },
        { id: 'vendor',  header: 'Vendor',              type: 'string',   get: r => r.vendorName, width: 22 },
        { id: 'product', header: 'Product',             type: 'string',   get: r => r.product, width: 28 },
        { id: 'cap',     header: 'Capability Replaced', type: 'string',   get: r => r.capability, width: 34 },
        { id: 'req',     header: 'Requires Tier',       type: 'string',   get: r => r.requiresTier, width: 14 },
        { id: 'dept',    header: 'Department',          type: 'string',   get: r => r.department, width: 18 },
        { id: 'spend',   header: 'Spend At Stake',      type: 'currency', get: r => r.spend, width: 16 },
      ],
      rows: flat,
    });
  } catch (err) {
    console.error('GET /reports/m365-overlap/xlsx:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to build XLSX.' });
  }
});

router.get('/m365-overlap/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildM365Overlap(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_M365_Overlap_${date}.pdf"`);
    streamM365OverlapPdf(res, data);
  } catch (err) {
    console.error('GET /reports/m365-overlap/pdf:', err);
    res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
  }
});

router.get('/walkaway-calculator/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildWalkawayCalculator(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Walkaway_Calculator_${date}.pdf"`);
    streamWalkawayCalculatorPdf(res, data);
  } catch (err) {
    console.error('GET /reports/walkaway-calculator/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    else res.end();
  }
});

router.get('/portfolio-decision-dashboard/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildPortfolioDecisionDashboard(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Portfolio_Decision_Dashboard_${date}.pdf"`);
    streamPortfolioDecisionDashboardPdf(res, data);
  } catch (err) {
    console.error('GET /reports/portfolio-decision-dashboard/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    else res.end();
  }
});

router.get('/contract-health-score/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildContractHealthScore(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Contract_Health_Score_${date}.pdf"`);
    streamContractHealthScorePdf(res, data);
  } catch (err) {
    console.error('GET /reports/contract-health-score/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    else res.end();
  }
});

router.get('/price-escalation-radar/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildPriceEscalationRadar(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Price_Escalation_Radar_${date}.pdf"`);
    streamPriceEscalationRadarPdf(res, data);
  } catch (err) {
    console.error('GET /reports/price-escalation-radar/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    else res.end();
  }
});

router.get('/department-budget-allocation/pdf', requireManager, async (req, res) => {
  try {
    const data = await buildDepartmentBudgetAllocation(req);
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="LapseIQ_Department_Budget_Allocation_${date}.pdf"`);
    streamDepartmentBudgetAllocationPdf(res, data);
  } catch (err) {
    console.error('GET /reports/department-budget-allocation/pdf:', err);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to generate PDF.' });
    else res.end();
  }
});


// ── v0.61.0 AI-narrated reports — POST /:reportId/narrate ─────────────────
// Pilot: 3 reports (auto-renewal-exposure, vendor-concentration,
// audit-evidence-pack). The endpoint is a generic dispatcher that re-runs
// the named report's builder for the current user (so the narrative reflects
// THIS user's data + scope), assembles a compact data summary, sends it to
// the AI cascade with a per-report prompt template, and returns the prose.

const { complete }        = require('../lib/ai');
const aiQuotaNarrate      = require('../lib/aiQuota');
const { ensureAiConsent } = require('../lib/aiConsent');
const { ensureAiBudget }  = require('../lib/aiBudgetGuard');

// Map of supported reportIds -> { builder, summarize, persona }
// summarize() compresses the full report into a compact JSON-shaped
// payload the LLM can actually reason about (a 200-row table would
// blow the token budget on every provider).
const NARRATE_REGISTRY: any = {
  'auto-renewal-exposure': {
    builder: (req) => buildAutoRenewalExposure(req),
    persona: 'renewals',
    summarize: (d) => ({
      reportName: 'Auto-Renewal Exposure',
      horizonDays: d.horizon,
      totalContracts: d.totalContracts,
      totalExposureUsd: Math.round(d.totalExposure || 0),
      critical: { count: d.criticalCount, exposureUsd: Math.round(d.criticalExposure || 0) },
      warning:  { count: d.warningCount,  exposureUsd: Math.round(d.warningExposure  || 0) },
      topRows: (d.rows || []).slice(0, 5).map(r => ({
        vendor: r.vendorName, product: r.product,
        cancelByDate: r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : null,
        daysLeft: r.daysToCancelBy, valueUsd: Math.round(r.renewalValue || 0), risk: r.risk,
      })),
    }),
  },
  'vendor-concentration': {
    builder: (req) => buildVendorConcentration(req),
    persona: 'risk',
    summarize: (d) => ({
      reportName: 'Vendor Concentration (Pareto)',
      period: d.rangeLabel,
      totalSpendUsd: Math.round(d.totalSpend || 0),
      vendorCount: d.vendorCount,
      top5SharePct: d.top5Pct != null ? +d.top5Pct.toFixed(1) : null,
      top10SharePct: d.top10Pct != null ? +d.top10Pct.toFixed(1) : null,
      paretoHeadCount: d.headCount,
      paretoTailCount: d.tailCount,
      topVendors: (d.rows || []).slice(0, 5).map(r => ({
        rank: r.rank, vendor: r.vendorName,
        spendUsd: Math.round(r.spend || 0), sharePct: +r.pct.toFixed(1),
      })),
    }),
  },
  'audit-evidence-pack': {
    builder: (req) => buildAuditEvidencePack(req),
    persona: 'risk',
    summarize: (d) => ({
      reportName: 'Audit Evidence Pack',
      activeContractCount: d.activeCount,
      vendorCount: d.vendorCount,
      pastCancelByCount: d.pastCancelByCount,
      missingSignerCount: d.missingSignerCount,
      missingEndDateCount: d.missingEndDateCount,
      sensitiveDataVendorCount: (d.sensitiveDataVendors || []).length,
      topSensitiveVendors: (d.sensitiveDataVendors || []).slice(0, 5).map(v => v.vendorName),
      pastCancelBySample: (d.pastCancelBy || []).slice(0, 3).map(r => ({
        vendor: r.vendorName, product: r.product, daysOverdue: r.daysOverdue, valueUsd: Math.round(r.value || 0),
      })),
      missingEvidenceFields: (d.missingEvidence || []).map(m => m.field),
    }),
  },

  // v0.62.0 — remaining 11 reports wired into the narrate dispatcher.
  // Each summarize fn compresses the full report shape into ~300-600 tokens.

  'renewal-horizon': {
    builder: (req) => buildRenewalHorizon(req),
    persona: 'renewals',
    summarize: (d) => ({
      reportName: 'Renewal Horizon',
      horizonDays: d.horizon,
      totals: { count: d.totalContracts, valueUsd: Math.round(d.totalValue || 0) },
      buckets: (d.buckets || []).map(b => ({
        label: b.label, count: b.contracts ? b.contracts.length : 0,
        valueUsd: Math.round(b.value || 0),
      })),
      topUpcoming: (d.buckets || []).flatMap(b => b.contracts || []).slice(0, 5).map(c => ({
        vendor: c.vendorName, product: c.product,
        endDate: c.endDate ? new Date(c.endDate).toISOString().split('T')[0] : null,
        daysOut: c.daysToEnd, riskClass: c.risk, valueUsd: Math.round(c.renewalValue || 0),
      })),
    }),
  },

  'co-term-opportunity': {
    builder: (req) => buildCoTermOpportunity(req),
    persona: 'renewals',
    summarize: (d) => ({
      reportName: 'Co-Termination Opportunity',
      minSpreadDays: d.minSpread,
      groupCount: d.groupCount,
      contractCount: d.contractCount,
      totalAnnualValueUsd: Math.round(d.totalAnnualValue || 0),
      totalSpreadDays: d.totalSpreadDays,
      biggestOpportunityUsd: Math.round(d.biggestOpportunityUsd || 0),
      biggestOpportunityGroup: d.biggestOpportunityGroup,
      topGroups: (d.groups || []).slice(0, 3).map(g => ({
        group: g.groupName, vendors: g.vendorCount, contracts: g.memberCount,
        spreadDays: g.divergeDays, annualUsd: Math.round(g.annualValue || 0),
        estSavingsUsd: Math.round(g.estimatedSavingsUsd || 0),
      })),
    }),
  },

  'risk-radar': {
    builder: (req) => buildRiskRadar(req),
    persona: 'risk',
    summarize: (d) => ({
      reportName: 'Risk Radar',
      totalIssues: d.totalIssues,
      autoRenewalTraps: (d.traps || []).length,
      expiredButActive: (d.expiredActive || []).length,
      coTermMisaligned: (d.coTermMisaligned || []).length,
      topTraps: (d.traps || []).slice(0, 3).map(t => ({
        vendor: t.vendorName, product: t.product,
        cancelByDate: t.cancelByDate ? new Date(t.cancelByDate).toISOString().split('T')[0] : null,
        valueUsd: Math.round(t.renewalValue || 0),
      })),
      topExpired: (d.expiredActive || []).slice(0, 3).map(t => ({
        vendor: t.vendorName, product: t.product,
        endDate: t.endDate ? new Date(t.endDate).toISOString().split('T')[0] : null,
        valueUsd: Math.round(t.renewalValue || 0),
      })),
    }),
  },

  'spend-ledger': {
    builder: (req) => buildSpendLedger(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'Spend Ledger',
      mode: d.mode, // 'commitments' or 'actuals'
      fyLabel: d.fyLabel,
      totalSpendUsd: Math.round(d.totalSpend || 0),
      contractCount: d.contractCount,
      topVendors: (d.byVendor || []).slice(0, 5).map(v => ({
        vendor: v.vendorName, spendUsd: Math.round(v.spend || 0),
      })),
      topDepartments: (d.byDepartment || []).slice(0, 5).map(x => ({
        department: x.department, spendUsd: Math.round(x.spend || 0),
      })),
      topCategories: (d.byCategory || []).slice(0, 5).map(c => ({
        category: c.categoryName, spendUsd: Math.round(c.spend || 0),
      })),
    }),
  },

  'savings-ledger': {
    builder: (req) => buildSavingsLedger(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'Savings Ledger',
      period: d.periodLabel,
      totalSavingsUsd: Math.round(d.totalSavings || 0),
      blendedRatePct: d.blendedRate != null ? +d.blendedRate.toFixed(1) : null,
      contractCount: (d.rows || []).length,
      topByCategory: (d.byCategory || []).slice(0, 5).map(c => ({
        category: c.categoryName, savingsUsd: Math.round(c.savings || 0),
      })),
      topSavings: (d.rows || []).slice(0, 5).map(r => ({
        vendor: r.vendorName, product: r.product,
        originalAskUsd: Math.round(r.originalAsk || 0),
        finalUsd: Math.round(r.finalNegotiated || 0),
        savedUsd: Math.round(r.savings || 0),
      })),
    }),
  },

  'license-wastage': {
    builder: (req) => buildLicenseWastage(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'License Wastage',
      coverageCount: d.coverageCount,
      totalActiveContracts: d.totalActiveContracts,
      totalEstimatedWasteUsd: Math.round(d.totalEstimatedWaste || 0),
      totalAnnualValueUsd: Math.round(d.totalAnnualValue || 0),
      wastePctOfAnnual: d.wastePctOfAnnual != null ? +d.wastePctOfAnnual.toFixed(1) : null,
      avgUtilizationPct: d.avgUtilization != null ? +d.avgUtilization.toFixed(0) : null,
      biggestWasteVendor: d.biggestWasteVendor ? {
        vendor: d.biggestWasteVendor.vendorName,
        wasteUsd: Math.round(d.biggestWasteVendor.wasteValue || 0),
      } : null,
      topWasteVendors: (d.byVendor || []).slice(0, 5).map(v => ({
        vendor: v.vendorName, contracts: v.contractCount,
        wasteSeats: v.wasteSeats, wasteUsd: Math.round(v.wasteValue || 0),
      })),
    }),
  },

  'application-overlap': {
    builder: (req) => buildApplicationOverlap(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'Application Portfolio Overlap',
      groupCount: d.groupCount,
      contractCount: d.contractCount,
      totalAddressableSpendUsd: Math.round(d.totalAddressableSpend || 0),
      biggestOverlap: d.biggestOverlap ? {
        label: d.biggestOverlap.label,
        spendUsd: Math.round(d.biggestOverlap.spend || 0),
      } : null,
      saasFunctionalBuckets: d.saasBucketCount,
      saasUnbucketedCount: d.saasUnbucketedCount,
      topGroups: (d.groups || []).slice(0, 5).map(g => ({
        group: g.label, heuristic: g.heuristic, vendors: g.vendorCount,
        contracts: g.members.length, addressableUsd: Math.round(g.totalSpend || 0),
      })),
    }),
  },

  'm365-overlap': {
    builder: (req) => buildM365Overlap(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'Microsoft 365 License Overlap',
      hasAnchor: d.hasAnchor,
      anchor: d.anchor ? { vendor: d.anchor.vendorName, product: d.anchor.product, tier: d.anchor.tier } : null,
      effectiveTier: d.anchorTier,
      overlapCount: d.overlapCount,
      totalSpendAtStakeUsd: Math.round(d.totalSpendAtStake || 0),
      displaceable: ((d.groups[0] && d.groups[0].members) || []).slice(0, 8).map(m => ({
        vendor: m.vendorName, product: m.product, capability: m.capability,
        requiresTier: m.requiresTier, spendUsd: Math.round(m.spend || 0),
      })),
    }),
  },
  'non-saas-categories': {
    builder: (req) => buildNonSaaSCategories(req),
    persona: 'spend',
    summarize: (d) => ({
      reportName: 'Non-SaaS Category Breakdown',
      totalSpendUsd: Math.round(d.totalSpend || 0),
      totalContracts: d.totalContracts,
      categoryCount: d.categoryCount,
      expiringSoonCount: d.expiringSoonCount,
      topCategories: (d.rows || []).slice(0, 6).map(c => ({
        category: c.categoryName, spendUsd: Math.round(c.spend || 0),
        sharePct: +c.sharePct.toFixed(1), vendors: c.vendorCount,
        contracts: c.contractCount, expiring90d: c.expiringSoon,
      })),
    }),
  },

  'executive-spend': {
    builder: (req) => buildExecutiveSpend(req),
    persona: 'executive',
    summarize: (d) => ({
      reportName: 'Executive Spend',
      currentFY: { label: d.currentFY?.label, totalSpendUsd: Math.round(d.currentFY?.totalSpend || 0), contracts: d.currentFY?.contractCount },
      priorFY:   { label: d.priorFY?.label,   totalSpendUsd: Math.round(d.priorFY?.totalSpend   || 0), contracts: d.priorFY?.contractCount },
      yoy: { absoluteUsd: Math.round(d.yoy?.absolute || 0), percent: d.yoy?.percent != null ? +d.yoy.percent.toFixed(1) : null },
      topVendors: (d.byVendor || []).slice(0, 5).map(v => ({
        vendor: v.vendorName, currentUsd: Math.round(v.current || 0),
        deltaUsd: Math.round(v.delta || 0), deltaPct: v.percent != null ? +v.percent.toFixed(1) : null,
      })),
      topDepartments: (d.byDepartment || []).slice(0, 3).map(x => ({
        department: x.department, currentUsd: Math.round(x.current || 0),
      })),
    }),
  },

  'vendor-heat-map': {
    builder: (req) => buildVendorHeatMap(req),
    persona: 'executive',
    summarize: (d) => ({
      reportName: 'Vendor Portfolio Heat Map',
      vendorCount: d.vendorCount,
      tier1CoveragePct: d.tier1CoveragePct != null ? +d.tier1CoveragePct.toFixed(1) : null,
      tier4SpendUsd: Math.round(d.tier4Spend || 0),
      tier4SpendPct: d.tier4Pct != null ? +d.tier4Pct.toFixed(1) : null,
      unsetVendorCount: d.unsetCount,
      rationalizationCandidates: (d.rationalizationCandidates || []).slice(0, 5).map(v => ({
        vendor: v.vendorName, spendUsd: Math.round(v.spend || 0),
      })),
      strategicGaps: (d.strategicGaps || []).slice(0, 5).map(v => ({
        vendor: v.vendorName, spendUsd: Math.round(v.spend || 0),
      })),
    }),
  },

  'renewal-commitment-forecast': {
    builder: (req) => buildRenewalCommitmentForecast(req),
    persona: 'executive',
    summarize: (d) => ({
      reportName: 'Renewal Commitment Forecast',
      horizonMonths: d.horizon,
      totalContracts: d.totalContracts,
      totalCommitmentUsd: Math.round(d.totalCommitment || 0),
      autoRenewSharePct: d.autoRenewSharePct != null ? +d.autoRenewSharePct.toFixed(1) : null,
      autoRenewValueUsd: Math.round(d.autoRenewValue || 0),
      biggestMonth: d.biggestMonth ? {
        month: d.biggestMonth.yyyy_mm,
        renewalValueUsd: Math.round(d.biggestMonth.renewalValue || 0),
      } : null,
      next6Months: (d.months || []).slice(0, 6).map(m => ({
        month: m.yyyy_mm,
        contracts: m.contractCount,
        renewalUsd: Math.round(m.renewalValue || 0),
        autoRenewUsd: Math.round(m.autoRenewValue || 0),
      })),
    }),
  },

  // v0.64.0 — portfolio-level summary. Runs 4 existing builders in parallel
  // and composes a single ~400-token payload describing the whole portfolio.
  // Surfaced on /dashboard via <ReportAiNarrative reportId="_portfolio" />.
  '_portfolio': {
    builder: async (req) => {
      // Build with conservative defaults: 90-day auto-renewal horizon,
      // YTD vendor concentration, no minSpread for co-term. The narrative
      // doesn't need precision tuning — it answers "what's interesting".
      const subReq = (qOverrides = {}) => Object.assign({}, req, {
        query: Object.assign({}, req.query, qOverrides),
      });
      const [autoRenew, vendorConc, wastage, horizon, auditPack] = await Promise.all([
        buildAutoRenewalExposure(subReq({ horizon: '90' })),
        buildVendorConcentration(subReq()),
        buildLicenseWastage(req),
        buildRenewalHorizon(subReq({ horizon: '30' })),
        buildAuditEvidencePack(req),
      ]);
      return { autoRenew, vendorConc, wastage, horizon, auditPack };
    },
    persona: 'executive',
    summarize: (d) => ({
      reportName: 'Portfolio Summary',
      activeContracts: d.auditPack?.activeCount || 0,
      activeVendors: d.auditPack?.vendorCount || 0,
      totalAnnualSpendUsd: Math.round(d.vendorConc?.totalSpend || 0),
      topVendor: d.vendorConc?.rows?.[0] ? {
        vendor: d.vendorConc.rows[0].vendorName,
        spendUsd: Math.round(d.vendorConc.rows[0].spend || 0),
        sharePct: +d.vendorConc.rows[0].pct.toFixed(1),
      } : null,
      vendorTop5SharePct: d.vendorConc?.top5Pct != null ? +d.vendorConc.top5Pct.toFixed(1) : null,
      autoRenewalExposure90d: {
        contractCount: d.autoRenew?.totalContracts || 0,
        totalUsd: Math.round(d.autoRenew?.totalExposure || 0),
        criticalCount: d.autoRenew?.criticalCount || 0,
        criticalUsd: Math.round(d.autoRenew?.criticalExposure || 0),
      },
      renewing30d: d.horizon?.totalContracts || 0,
      renewing30dValueUsd: Math.round(d.horizon?.totalValue || 0),
      licenseWasteUsd: Math.round(d.wastage?.totalEstimatedWaste || 0),
      biggestWasteVendor: d.wastage?.biggestWasteVendor ? {
        vendor: d.wastage.biggestWasteVendor.vendorName,
        wasteUsd: Math.round(d.wastage.biggestWasteVendor.wasteValue || 0),
      } : null,
      pastCancelByCount: d.auditPack?.pastCancelByCount || 0,
      missingSignerCount: d.auditPack?.missingSignerCount || 0,
    }),
  },
};

const NARRATE_SYSTEM_PROMPT = `You are a renewals and procurement analyst writing a brief executive summary of a LapseIQ report for a busy admin or manager.

You must output VALID JSON in EXACTLY this shape, with no markdown fences and no preamble:
{
  "narrative": "2 or 3 short sentences. Lead with the single most important finding using a concrete number from the data. End with one specific recommended next action. Plain English. No buzzwords.",
  "actions": [
    { "label": "Short verb phrase (2-5 words)", "reason": "One short clause explaining why", "route": "/path?optional=query" }
  ]
}

Hard rules for narrative:
- 2 or 3 short sentences total. NEVER more than 3.
- Concrete vendor names and dollar figures when the data has them.
- If the data shows zero risk, say that and recommend a maintenance cadence.
- Do NOT speculate or add facts that are not in the data.

Hard rules for actions:
- Between 0 and 3 actions. Quality over quantity. Skip if nothing useful applies.
- "route" MUST be one of these patterns (the host app will reject unknown routes):
    /reports/<reportId>             (renewal-horizon, auto-renewal-exposure, risk-radar,
                                      vendor-concentration, audit-evidence-pack, spend-ledger,
                                      savings-ledger, license-wastage, non-saas-categories,
                                      application-overlap, m365-overlap, executive-spend, vendor-heat-map,
                                      renewal-commitment-forecast, co-term-opportunity)
    /contracts                      (also: /contracts?q=<text>, /contracts/new)
    /vendors                        (also: /vendors?q=<text>)
    /alerts
    /budget
    /settings
- "label" is a short verb phrase the user will see on a button (e.g. "Review Adobe contracts", "Open Auto-Renewal Exposure", "Add a new contract").
- "reason" is a short clause shown as the button's tooltip — explain WHY this is the recommended next action ("auto-renews in 12 days, $45K at risk").
- Do NOT invent URLs. Do NOT link to external sites. Do NOT use IDs from the data unless the route pattern explicitly allows them.

Output only the JSON object. No markdown, no commentary, no code fences.`;

function _narrateUserPrompt(payload) {
  return 'Report data:\n```json\n' + JSON.stringify(payload, null, 2) + '\n```\n\nWrite the 2-3 sentence summary now.';
}

// v0.62.0 — in-memory cache for narrate. Skips the AI call entirely when a
// cached narrative exists for (accountId|reportId|paramHash) within TTL.
// Client can pass ?fresh=1 to bypass cache (= Regenerate button intent).
// Eviction: lazy on read (drop expired entries) + hard cap at NARRATE_CACHE_MAX
// to bound memory under a hostile burst.
const NARRATE_CACHE_TTL_MS = 5 * 60 * 1000;
const NARRATE_CACHE_MAX    = 500;
const _narrateCache = new Map();  // key -> { narrative, provider, generatedAt, expiresAt }

function _narrateCacheKey(accountId, reportId, params) {
  // Stable JSON sort for deterministic param hashing
  const keys = Object.keys(params || {}).sort();
  const norm: any = {};
  for (const k of keys) norm[k] = params[k];
  return accountId + '|' + reportId + '|' + JSON.stringify(norm);
}
function _narrateCacheGet(key) {
  const hit = _narrateCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _narrateCache.delete(key); return null; }
  return hit;
}
function _narrateCacheSet(key, value) {
  if (_narrateCache.size >= NARRATE_CACHE_MAX) {
    // Drop the oldest entry. Map preserves insertion order so the first
    // .keys() entry is the oldest.
    const oldest = _narrateCache.keys().next().value;
    if (oldest) _narrateCache.delete(oldest);
  }
  _narrateCache.set(key, Object.assign({}, value, { expiresAt: Date.now() + NARRATE_CACHE_TTL_MS }));
}

// v0.65.0 — action whitelist + JSON parser
//
// AI returns { narrative, actions } as JSON. Server validates each action.route
// against ALLOWED_ROUTE_PATTERNS. Any action whose route doesn't match is
// silently dropped (logged at debug level). Cap at 3 actions per response.
// Parsing failures fall back to { narrative: rawText, actions: [] } so the UX
// degrades to v0.64 behaviour.
const NARRATE_MAX_ACTIONS = 3;
const ALLOWED_ROUTE_PATTERNS = [
  /^\/reports\/(renewal-horizon|auto-renewal-exposure|risk-radar|vendor-concentration|audit-evidence-pack|spend-ledger|savings-ledger|license-wastage|non-saas-categories|application-overlap|m365-overlap|executive-spend|vendor-heat-map|renewal-commitment-forecast|co-term-opportunity)(\?.*)?$/,
  /^\/contracts(\?q=[^&]*)?$/,
  /^\/contracts\/new$/,
  /^\/vendors(\?q=[^&]*)?$/,
  /^\/alerts$/,
  /^\/budget$/,
  /^\/settings$/,
];

function _validateAction(a) {
  if (!a || typeof a !== 'object') return null;
  const label = typeof a.label === 'string' ? a.label.trim().slice(0, 80) : null;
  const route = typeof a.route === 'string' ? a.route.trim() : null;
  const reason = typeof a.reason === 'string' ? a.reason.trim().slice(0, 200) : null;
  if (!label || !route) return null;
  if (!ALLOWED_ROUTE_PATTERNS.some(re => re.test(route))) {
    console.warn('[narrate] dropping action with disallowed route: ' + JSON.stringify(route));
    return null;
  }
  return { label, route, reason: reason || null };
}

function _parseAiNarrateOutput(rawText) {
  // Strip code fences if the AI ignored instructions and added them
  const cleaned = (rawText || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    const narrative = typeof parsed.narrative === 'string' ? parsed.narrative.trim() : '';
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.slice(0, NARRATE_MAX_ACTIONS).map(_validateAction).filter(Boolean)
      : [];
    if (!narrative) throw new Error('empty narrative');
    return { narrative, actions };
  } catch (err) {
    // Fall back to treating the raw text as the narrative
    console.warn('[narrate] JSON parse failed (' + err.message + '), falling back to prose-only');
    return { narrative: cleaned || rawText || '', actions: [] };
  }
}

// H6 (audit High, 2026-05-22): per-user rate limit on AI narrate.
// Without this, a viewer can spend up to 200 narrate/min x CF cascade =
// real $$ per user. 10/hour matches briefLimiter's tighter throttle for
// the most expensive AI surfaces.
const narrateLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `narrate:${req.user?.id || 'anon'}`,
  message: { success: false, error: 'Too many AI narrate requests -- try again in an hour.' },
});

router.post('/:reportId/narrate', requireManager, aiIpLimiter, narrateLimiter, async (req, res) => { // v0.69.1: per-IP stack
  const reportId = req.params.reportId;
  const entry = NARRATE_REGISTRY[reportId];
  if (!entry) {
    return res.status(404).json({ success: false, error: `Narrative not supported for report '${reportId}' (yet).` });
  }
  if (!(await ensureAiConsent(req, res))) return;
  if (!ensureAiBudget(req, res)) return;

  const userId    = req.user.id;
  const accountId = req.user.accountId;
  // v0.62.0: cache lookup BEFORE quota debit so cache hits cost no quota.
  // Skip cache if client passes ?fresh=1 (Regenerate button) or POST body
  // includes { fresh: true }.
  const wantFresh = req.query.fresh === '1' || req.body?.fresh === true;
  const cacheParams = Object.assign({}, req.query || {}, req.body || {});
  delete cacheParams.fresh;
  const cacheKey = _narrateCacheKey(accountId, reportId, cacheParams);
  if (!wantFresh) {
    const cached = _narrateCacheGet(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: {
          reportId,
          narrative: cached.narrative,
          actions: cached.actions || [],
          provider: cached.provider,
          generatedAt: cached.generatedAt,
          generatedBy: req.user.name || req.user.email || null,
          cached: true,
        },
      });
    }
  }

  const quota = await aiQuotaNarrate.checkAndIncrement(userId, 'narrate', accountId, req.user.role);
  if (!quota.ok) {
    return res.status(429).json({
      success: false, error: 'Daily AI narrative quota reached.',
      cap: quota.cap, used: quota.used,
    });
  }

  let data;
  try {
    data = await entry.builder(req);
  } catch (err) {
    void aiQuotaNarrate.refundIncrement(userId, 'narrate');
    console.error(`POST /reports/${reportId}/narrate (builder):`, err);
    return res.status(500).json({ success: false, error: 'Failed to load report data for narrative.' });
  }

  const payload = entry.summarize(data);

  let aiResult;
  try {
    aiResult = await complete({
      system: NARRATE_SYSTEM_PROMPT,
      user: _narrateUserPrompt(payload),
      maxTokens: 320,
      task: 'brief',
    });
  } catch (err) {
    void aiQuotaNarrate.refundIncrement(userId, 'narrate');
    console.error(`POST /reports/${reportId}/narrate (ai):`, err);
    const status = (err && err.name === 'BudgetExceededError') ? 503 : 502;
    return res.status(status).json({
      success: false,
      error: 'AI narrative generation failed. Please try again in a moment.',
    });
  }

  const parsed = _parseAiNarrateOutput(aiResult.text || '');
  if (!parsed.narrative) {
    void aiQuotaNarrate.refundIncrement(userId, 'narrate');
    return res.status(502).json({ success: false, error: 'AI returned an empty narrative.' });
  }

  const generatedAt = new Date().toISOString();
  _narrateCacheSet(cacheKey, {
    narrative: parsed.narrative,
    actions: parsed.actions,
    provider: aiResult.provider || null,
    generatedAt,
  });

  res.json({
    success: true,
    data: {
      reportId,
      narrative: parsed.narrative,
      actions: parsed.actions,
      provider: aiResult.provider || null,
      generatedAt,
      generatedBy: req.user.name || req.user.email || null,
      payloadDigestKeys: Object.keys(payload),
      cached: false,
    },
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Tier A — 6 data-ready reports (v0.85.0)
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Total Addressable Waste ────────────────────────────────────────────────
async function buildTotalAddressableWaste(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: 'active',
      seatsLicensed: { gt: 0 },
      seatsActivelyInUse: { not: null },
      totalValue: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      department: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
      seatsLicensed: true, seatsActivelyInUse: true, totalValue: true,
    },
  });

  let totalWaste = 0;
  let totalValue = 0;
  const byCategory: any = {};
  const byDepartment: any = {};

  const rows = contracts.map(c => {
    const vendorName  = c.vendor?.name   || null;
    const productName = c.product        || null;
    const categoryName = c.category?.name || null;
    const wasted   = Math.max(0, (c.seatsLicensed || 0) - (c.seatsActivelyInUse || 0));
    const annualWaste = c.seatsLicensed > 0
      ? (wasted / c.seatsLicensed) * Number(c.totalValue)
      : 0;
    const utilizationPct = c.seatsLicensed > 0
      ? Math.round((c.seatsActivelyInUse / c.seatsLicensed) * 100)
      : 0;

    totalWaste += annualWaste;
    totalValue += Number(c.totalValue);

    const cat  = categoryName || 'Uncategorised';
    const dept = c.department || 'Unassigned';
    if (!byCategory[cat])   byCategory[cat]   = { category: cat,   totalWaste: 0, contractCount: 0 };
    if (!byDepartment[dept]) byDepartment[dept] = { department: dept, totalWaste: 0, contractCount: 0 };
    byCategory[cat].totalWaste   += annualWaste;
    byCategory[cat].contractCount++;
    byDepartment[dept].totalWaste   += annualWaste;
    byDepartment[dept].contractCount++;

    return {
      id: c.id, vendorName, productName,
      department: c.department, category: categoryName,
      seatsLicensed: c.seatsLicensed, seatsActivelyInUse: c.seatsActivelyInUse,
      wastedSeats: wasted, utilizationPct,
      totalValue: Number(c.totalValue), annualWaste,
    };
  }).sort((a, b) => b.annualWaste - a.annualWaste);

  return {
    totals: { totalWaste, totalValue, contractCount: contracts.length, wastePct: totalValue > 0 ? totalWaste / totalValue * 100 : 0 },
    byCategory:   Object.values<any>(byCategory).sort((a,b) => b.totalWaste - a.totalWaste),
    byDepartment: Object.values<any>(byDepartment).sort((a,b) => b.totalWaste - a.totalWaste),
    rows,
  };
}

router.get('/total-addressable-waste', requireManager, async (req, res) => {
  try {
    const data = await buildTotalAddressableWaste(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] total-addressable-waste error', err);
    res.status(500).json({ success: false, error: 'Failed to build Total Addressable Waste report' });
  }
});

// ── 2. Termination Window Violations ─────────────────────────────────────────
async function buildTerminationWindowViolations(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const now = new Date();
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: 'active',
      autoRenewal: true,
      cancelByDate: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true,
      cancelByDate: true, endDate: true, totalValue: true,
      autoRenewal: true,
      vendor:        { select: { name: true } },
      internalOwner: { select: { name: true, email: true } },
    },
    orderBy: { cancelByDate: 'asc' },
  });

  const missed   = [];
  const critical = [];   // deadline within 14 days
  const warning  = [];   // deadline within 30 days

  for (const c of contracts) {
    const vendorName  = c.vendor?.name   || null;
    const productName = c.product        || null;
    const contractOwner = c.internalOwner?.name || c.internalOwnerName || null;
    const deadline    = new Date(c.cancelByDate);
    const daysToDeadline = Math.ceil((deadline.getTime() - now.getTime()) / 86400000);
    const row: any = {
      id: c.id, vendorName, productName,
      department: c.department, contractOwner,
      cancellationDeadline: c.cancelByDate,
      endDate: c.endDate, totalValue: c.totalValue ? Number(c.totalValue) : null,
      daysToDeadline,
    };
    if (daysToDeadline < 0)   missed.push({ ...row, daysPastDeadline: -daysToDeadline });
    else if (daysToDeadline <= 14) critical.push(row);
    else if (daysToDeadline <= 30) warning.push(row);
  }

  const missedValue   = missed.reduce((s,r)   => s + (r.totalValue || 0), 0);
  const criticalValue = critical.reduce((s,r) => s + (r.totalValue || 0), 0);

  return {
    summary: {
      missedCount:   missed.length,   missedValue,
      criticalCount: critical.length, criticalValue,
      warningCount:  warning.length,
    },
    missed, critical, warning,
  };
}

router.get('/termination-window-violations', requireManager, async (req, res) => {
  try {
    const data = await buildTerminationWindowViolations(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] termination-window-violations error', err);
    res.status(500).json({ success: false, error: 'Failed to build Termination Window Violations report' });
  }
});

// ── 3. License Reclamation ROI ────────────────────────────────────────────────
async function buildLicenseReclamationRoi(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: 'active',
      seatsLicensed: { gt: 0 },
      seatsActivelyInUse: { not: null },
      totalValue: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      department: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
      seatsLicensed: true, seatsActivelyInUse: true, totalValue: true,
      endDate: true,
    },
  });

  const rows = contracts.map(c => {
    const vendorName   = c.vendor?.name   || null;
    const productName  = c.product        || null;
    const categoryName = c.category?.name || null;
    const wastedSeats = Math.max(0, (c.seatsLicensed || 0) - (c.seatsActivelyInUse || 0));
    const costPerSeat = c.seatsLicensed > 0 ? Number(c.totalValue) / c.seatsLicensed : 0;
    const reclaimableValue = wastedSeats * costPerSeat;
    const utilizationPct = c.seatsLicensed > 0
      ? Math.round((c.seatsActivelyInUse / c.seatsLicensed) * 100)
      : 0;
    // ROI tier: High (>$10k/yr), Medium ($2-10k), Low (<$2k)
    const roiTier = reclaimableValue >= 10000 ? 'high'
                  : reclaimableValue >= 2000  ? 'medium'
                  : 'low';
    return {
      id: c.id, vendorName, productName,
      department: c.department, category: categoryName,
      seatsLicensed: c.seatsLicensed, seatsActivelyInUse: c.seatsActivelyInUse,
      wastedSeats, costPerSeat, reclaimableValue, utilizationPct, roiTier,
      totalValue: Number(c.totalValue), endDate: c.endDate,
    };
  }).sort((a, b) => b.reclaimableValue - a.reclaimableValue);

  const totalReclaimable = rows.reduce((s, r) => s + r.reclaimableValue, 0);
  const highCount   = rows.filter(r => r.roiTier === 'high').length;
  const mediumCount = rows.filter(r => r.roiTier === 'medium').length;

  return {
    summary: { totalReclaimable, contractCount: rows.length, highCount, mediumCount },
    rows,
  };
}

router.get('/license-reclamation-roi', requireManager, async (req, res) => {
  try {
    const data = await buildLicenseReclamationRoi(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] license-reclamation-roi error', err);
    res.status(500).json({ success: false, error: 'Failed to build License Reclamation ROI report' });
  }
});

// ── 4. Cost-per-Active-User ───────────────────────────────────────────────────
async function buildCostPerActiveUser(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      status: 'active',
      seatsActivelyInUse: { gt: 0 },
      totalValue: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      department: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
      seatsLicensed: true, seatsActivelyInUse: true, totalValue: true,
    },
  });

  // Category benchmarks
  const catBenchmark: any = {};
  for (const c of contracts) {
    const cat = c.category?.name || 'Uncategorised';
    const cpu = Number(c.totalValue) / c.seatsActivelyInUse;
    if (!catBenchmark[cat]) catBenchmark[cat] = { sum: 0, count: 0 };
    catBenchmark[cat].sum   += cpu;
    catBenchmark[cat].count++;
  }
  const catAvg: any = {};
  for (const [cat, b] of Object.entries<any>(catBenchmark)) {
    catAvg[cat] = b.count > 0 ? b.sum / b.count : 0;
  }

  const rows = contracts.map(c => {
    const vendorName   = c.vendor?.name   || null;
    const productName  = c.product        || null;
    const categoryName = c.category?.name || null;
    const cpu      = Number(c.totalValue) / c.seatsActivelyInUse;
    const cat      = categoryName || 'Uncategorised';
    const benchmark = catAvg[cat] || 0;
    const vsBenchmarkPct = benchmark > 0 ? ((cpu - benchmark) / benchmark) * 100 : null;
    return {
      id: c.id, vendorName, productName,
      department: c.department, category: categoryName,
      seatsLicensed: c.seatsLicensed, seatsActivelyInUse: c.seatsActivelyInUse,
      totalValue: Number(c.totalValue), costPerActiveUser: cpu,
      categoryBenchmark: benchmark, vsBenchmarkPct,
    };
  }).sort((a, b) => b.costPerActiveUser - a.costPerActiveUser);

  const categoryBreakdown = Object.entries<any>(catAvg).map(([category, avgCpu]) => ({
    category,
    avgCostPerActiveUser: avgCpu,
    contractCount: catBenchmark[category].count,
  })).sort((a, b) => b.avgCostPerActiveUser - a.avgCostPerActiveUser);

  return { rows, categoryBreakdown };
}

router.get('/cost-per-active-user', requireManager, async (req, res) => {
  try {
    const data = await buildCostPerActiveUser(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] cost-per-active-user error', err);
    res.status(500).json({ success: false, error: 'Failed to build Cost-per-Active-User report' });
  }
});

// ── 5. Negotiation Effectiveness by Owner ────────────────────────────────────
async function buildNegotiationEffectivenessByOwner(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      originalAsk: { not: null },
      finalNegotiatedPrice: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true, product: true,
      internalOwnerName: true, department: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
      originalAsk: true, finalNegotiatedPrice: true,
      savingsLever: true, endDate: true,
    },
  });

  const byOwner: any = {};
  for (const c of contracts) {
    const ask      = Number(c.originalAsk);
    const final    = Number(c.finalNegotiatedPrice);
    if (ask <= 0) continue;
    const saved    = ask - final;
    const savingsPct = (saved / ask) * 100;
    const ownerName = c.internalOwner?.name || c.internalOwnerName || null;
    const owner    = ownerName || 'Unassigned';

    if (!byOwner[owner]) byOwner[owner] = {
      owner, dealCount: 0, totalAsk: 0, totalSaved: 0, savingsPcts: [],
    };
    byOwner[owner].dealCount++;
    byOwner[owner].totalAsk   += ask;
    byOwner[owner].totalSaved += saved;
    byOwner[owner].savingsPcts.push(savingsPct);
  }

  const rows = Object.values<any>(byOwner).map(o => ({
    owner:          o.owner,
    dealCount:      o.dealCount,
    totalAsk:       o.totalAsk,
    totalSaved:     o.totalSaved,
    avgSavingsPct:  o.savingsPcts.reduce((s,v) => s+v, 0) / o.savingsPcts.length,
    blendedSavingsPct: o.totalAsk > 0 ? (o.totalSaved / o.totalAsk) * 100 : 0,
  })).sort((a, b) => b.blendedSavingsPct - a.blendedSavingsPct);

  const portfolioAvgPct = rows.length > 0
    ? rows.reduce((s, r) => s + r.blendedSavingsPct, 0) / rows.length
    : 0;

  return {
    summary: {
      ownerCount: rows.length,
      totalDeals: contracts.length,
      portfolioAvgSavingsPct: portfolioAvgPct,
    },
    rows,
  };
}

router.get('/negotiation-effectiveness-by-owner', requireManager, async (req, res) => {
  try {
    const data = await buildNegotiationEffectivenessByOwner(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] negotiation-effectiveness-by-owner error', err);
    res.status(500).json({ success: false, error: 'Failed to build Negotiation Effectiveness by Owner report' });
  }
});

// ── 6. Vendor Negotiation Difficulty ─────────────────────────────────────────
async function buildVendorNegotiationDifficulty(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: {
      accountId, archivedAt: null,
      originalAsk: { not: null },
      finalNegotiatedPrice: { not: null },
      ...scopeWhere,
    },
    select: {
      id: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
      originalAsk: true, finalNegotiatedPrice: true,
      savingsLever: true,
    },
  });

  const byVendor: any = {};
  for (const c of contracts) {
    const ask   = Number(c.originalAsk);
    const final = Number(c.finalNegotiatedPrice);
    if (ask <= 0) continue;
    const saved = ask - final;
    const savingsPct = (saved / ask) * 100;
    const vendorName = c.vendor?.name || null;
    const categoryName = c.category?.name || null;
    const vendor = vendorName || 'Unknown';

    if (!byVendor[vendor]) byVendor[vendor] = {
      vendorName: vendor, category: categoryName,
      dealCount: 0, totalAsk: 0, totalSaved: 0, savingsPcts: [],
    };
    byVendor[vendor].dealCount++;
    byVendor[vendor].totalAsk   += ask;
    byVendor[vendor].totalSaved += saved;
    byVendor[vendor].savingsPcts.push(savingsPct);
  }

  const rows = Object.values<any>(byVendor).map(v => {
    const avgSavingsPct = v.savingsPcts.reduce((s,x) => s+x, 0) / v.savingsPcts.length;
    // Difficulty score: lower savings % = harder vendor. Invert and clamp 0-100.
    const difficultyScore = Math.round(Math.max(0, Math.min(100, 100 - avgSavingsPct)));
    const difficultyTier  = difficultyScore >= 80 ? 'hard'
                          : difficultyScore >= 50 ? 'moderate'
                          : 'easy';
    return {
      vendorName: v.vendorName, category: v.category,
      dealCount: v.dealCount,
      totalAsk: v.totalAsk, totalSaved: v.totalSaved,
      avgSavingsPct, difficultyScore, difficultyTier,
    };
  }).sort((a, b) => b.difficultyScore - a.difficultyScore);

  return { rows, contractCount: contracts.length };
}

router.get('/vendor-negotiation-difficulty', requireManager, async (req, res) => {
  try {
    const data = await buildVendorNegotiationDifficulty(req);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[reports] vendor-negotiation-difficulty error', err);
    res.status(500).json({ success: false, error: 'Failed to build Vendor Negotiation Difficulty report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stub → Real: 10 v0.80 placeholders converted (v0.86.0)
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. Price Escalation Radar ─────────────────────────────────────────────────
async function buildPriceEscalationRadar(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const threshold = Math.max(0, Math.min(200, parseFloat(req.query.thresholdPct ?? 10)));
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', originalAsk: { not: null }, totalValue: { not: null }, ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
      endDate: true,
      originalAsk: true, totalValue: true,
    },
  });
  const rows = contracts
    .map(c => {
      const ask     = Number(c.originalAsk);
      const current = Number(c.totalValue);
      if (current <= 0) return null;
      const escalationPct = ((ask - current) / current) * 100;
      const daysToRenewal = c.endDate
        ? Math.ceil((new Date(c.endDate).getTime() - Date.now()) / 86400000)
        : null;
      return {
        id: c.id,
        vendorName:    c.vendor?.name   || null,
        productName:   c.product        || null,
        category:      c.category?.name || null,
        department:    c.department,
        contractOwner: c.internalOwner?.name || c.internalOwnerName || null,
        endDate: c.endDate,
        originalAsk: ask, currentValue: current,
        escalationPct, escalationDelta: ask - current,
        daysToRenewal,
        tier: escalationPct >= 25 ? 'high' : escalationPct >= 10 ? 'medium' : 'low',
      };
    })
    .filter(r => r && r.escalationPct >= threshold)
    .sort((a, b) => b.escalationPct - a.escalationPct);

  const totalExposure = rows.reduce((s, r) => s + r.escalationDelta, 0);
  return {
    params: { thresholdPct: threshold },
    summary: {
      totalScanned:    rows.length,
      flaggedCount:    rows.length,
      totalExcessCost: totalExposure,
      totalExposure,
      contractCount:   rows.length,
      highCount:   rows.filter(r => r.tier === 'high').length,
      mediumCount: rows.filter(r => r.tier === 'medium').length,
    },
    rows: rows.map(r => ({ ...r, flagged: true })),
  };
}

router.get('/price-escalation-radar', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildPriceEscalationRadar(req) }); }
  catch (err) { console.error('[reports] price-escalation-radar', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 2. Multi-Year Commitment Risk ─────────────────────────────────────────────
async function buildMultiYearCommitmentRisk(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const now     = new Date();
  const cutoff  = new Date(now); cutoff.setMonth(cutoff.getMonth() + 24);
  const fyEnd   = new Date(now.getFullYear(), 11, 31); // Dec 31 current year
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', endDate: { gt: cutoff }, ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true, startDate: true, endDate: true,
      totalValue: true, autoRenewal: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  let totalLocked = 0, beyondFY = 0;
  const rows = contracts.map(c => {
    const val     = c.totalValue ? Number(c.totalValue) : null;
    const end     = new Date(c.endDate);
    const months  = Math.ceil((end.getTime() - now.getTime()) / (86400000 * 30.44));
    const tier    = months >= 60 ? 'critical' : months >= 36 ? 'high' : 'medium';
    const beyondFYValue = val && end > fyEnd
      ? (val * Math.min(1, (end.getTime() - fyEnd.getTime()) / (end.getTime() - now.getTime())))
      : 0;
    if (val) totalLocked += val;
    beyondFY += beyondFYValue;
    return { id: c.id,
      vendorName:    c.vendor?.name   || null,
      productName:   c.product        || null,
      category:      c.category?.name || null,
      department:    c.department,
      contractOwner: c.internalOwner?.name || c.internalOwnerName || null,
      startDate: c.startDate, endDate: c.endDate, totalValue: val,
      monthsRemaining: months, tier, autoRenews: !!c.autoRenewal, beyondFYValue };
  });

  return {
    summary: {
      totalContracts: rows.length,
      contractCount:  rows.length,
      totalCommitted: totalLocked,
      totalLocked,
      beyondFY,
      criticalCount: rows.filter(r => r.tier === 'critical').length,
      highCount:     rows.filter(r => r.tier === 'high').length,
      mediumCount:   rows.filter(r => r.tier === 'medium').length,
    },
    rows,
  };
}

router.get('/multi-year-commitment-risk', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildMultiYearCommitmentRisk(req) }); }
  catch (err) { console.error('[reports] multi-year-commitment-risk', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 3. Contract Health Score ──────────────────────────────────────────────────
async function buildContractHealthScore(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true, endDate: true, totalValue: true,
      autoRenewal: true, cancelByDate: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
      _count: { select: { documents: true } },
    },
  });

  const score = (vendorName, categoryName, ownerName, c) => {
    let s = 0;
    // Required fields complete (25pts)
    const reqFilled = [vendorName, c.endDate, c.totalValue, categoryName].every(Boolean);
    if (reqFilled) s += 25;
    else s += [vendorName, c.endDate, c.totalValue, categoryName].filter(Boolean).length * 6;
    // Owner assigned (25pts)
    if (ownerName) s += 25;
    // Auto-renewal stance recorded (25pts) - boolean field always set
    s += 25;
    // Cancellation deadline set when auto-renews (25pts)
    if (c.autoRenewal === true && c.cancelByDate) s += 25;
    if (c.autoRenewal === false) s += 25; // no deadline needed
    return Math.min(100, s);
  };

  const rows = contracts.map(c => {
    const vendorName   = c.vendor?.name   || null;
    const productName  = c.product        || null;
    const categoryName = c.category?.name || null;
    const ownerName    = c.internalOwner?.name || c.internalOwnerName || null;
    const healthScore = score(vendorName, categoryName, ownerName, c);
    const tier = healthScore >= 80 ? 'good' : healthScore >= 50 ? 'needs-work' : 'critical';
    const daysToRenewal = c.endDate
      ? Math.ceil((new Date(c.endDate).getTime() - Date.now()) / 86400000)
      : null;
    return { id: c.id, vendorName, productName,
      category: categoryName, department: c.department, contractOwner: ownerName,
      endDate: c.endDate, totalValue: c.totalValue ? Number(c.totalValue) : null,
      healthScore, tier, daysToRenewal,
      checks: {
        requiredFields: ![vendorName, c.endDate, c.totalValue, categoryName].some(v => !v),
        ownerAssigned:  !!ownerName,
        autoRenewalSet: true,
        deadlineSet:    c.autoRenewal !== true || !!c.cancelByDate,
      },
    };
  }).sort((a, b) => a.healthScore - b.healthScore);

  const avgScore = rows.length ? rows.reduce((s, r) => s + r.healthScore, 0) / rows.length : 0;
  const gradeRows = rows.map(r => ({
    ...r,
    score: r.healthScore,
    grade: r.healthScore >= 90 ? 'A' : r.healthScore >= 75 ? 'B' : r.healthScore >= 50 ? 'C' : r.healthScore >= 25 ? 'D' : 'F',
  }));
  return {
    summary: {
      totalContracts:    gradeRows.length,
      contractCount:     gradeRows.length,
      portfolioAvgScore: Math.round(avgScore),
      avgScore,
      perfectCount:      gradeRows.filter(r => r.grade === 'A').length,
      goodCount:         gradeRows.filter(r => r.tier === 'good').length,
      needsWorkCount:    gradeRows.filter(r => r.tier === 'needs-work').length,
      atRiskCount:       gradeRows.filter(r => ['D', 'F'].includes(r.grade)).length,
      criticalCount:     gradeRows.filter(r => r.tier === 'critical').length,
    },
    rows: gradeRows,
  };
}

router.get('/contract-health-score', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildContractHealthScore(req) }); }
  catch (err) { console.error('[reports] contract-health-score', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 4. Department Budget Allocation ──────────────────────────────────────────
async function buildDepartmentBudgetAllocation(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const now      = new Date();
  const in90days = new Date(now); in90days.setDate(in90days.getDate() + 90);
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', ...scopeWhere },
    select: {
      id: true, product: true, department: true,
      internalOwnerName: true, endDate: true, totalValue: true,
      vendor:        { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
  });

  const totalPortfolio = contracts.reduce((s, c) => s + (c.totalValue ? Number(c.totalValue) : 0), 0);
  const byDept: any = {};
  for (const c of contracts) {
    const dept = c.department || 'Unassigned';
    const vendorName = c.vendor?.name || null;
    const ownerName  = c.internalOwner?.name || c.internalOwnerName || null;
    if (!byDept[dept]) byDept[dept] = { department: dept, contractCount: 0, totalSpend: 0, renewalsIn90d: 0, contracts: [] };
    byDept[dept].contractCount++;
    byDept[dept].totalSpend += c.totalValue ? Number(c.totalValue) : 0;
    if (c.endDate && new Date(c.endDate) <= in90days && new Date(c.endDate) >= now)
      byDept[dept].renewalsIn90d++;
    byDept[dept].contracts.push({ id: c.id, vendorName,
      endDate: c.endDate, totalValue: c.totalValue ? Number(c.totalValue) : null,
      contractOwner: ownerName });
  }

  const rows = Object.values<any>(byDept).map(d => ({
    ...d,
    portfolioPct: totalPortfolio > 0 ? (d.totalSpend / totalPortfolio) * 100 : 0,
  })).sort((a, b) => b.totalSpend - a.totalSpend);

  const totalRenewalsIn90d = rows.reduce((s, r) => s + r.renewalsIn90d, 0);
  return {
    summary: {
      totalSpend:      totalPortfolio,
      totalPortfolio,
      deptCount:       rows.length,
      departmentCount: rows.length,
      totalContracts:  contracts.length,
      unassignedCount: contracts.filter(c => !c.department).length,
      renewalsIn90d:   totalRenewalsIn90d,
    },
    rows,
  };
}

router.get('/department-budget-allocation', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildDepartmentBudgetAllocation(req) }); }
  catch (err) { console.error('[reports] department-budget-allocation', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 5. Price Per Seat Benchmark ───────────────────────────────────────────────
async function buildPricePerSeatBenchmark(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', seatsLicensed: { gt: 0 }, totalValue: { not: null }, ...scopeWhere },
    select: {
      id: true, product: true, department: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
      seatsLicensed: true, totalValue: true,
    },
  });

  const catBench: any = {};
  for (const c of contracts) {
    const cat = c.category?.name || 'Uncategorised';
    const pps = Number(c.totalValue) / c.seatsLicensed;
    if (!catBench[cat]) catBench[cat] = { sum: 0, count: 0 };
    catBench[cat].sum += pps; catBench[cat].count++;
  }
  const catAvg = Object.fromEntries(Object.entries<any>(catBench).map(([k, v]) => [k, v.sum / v.count]));

  const rows = contracts.map(c => {
    const vendorName   = c.vendor?.name   || null;
    const productName  = c.product        || null;
    const categoryName = c.category?.name || null;
    const pps = Number(c.totalValue) / c.seatsLicensed;
    const cat = categoryName || 'Uncategorised';
    const benchmark = catAvg[cat] || 0;
    const vsBenchmarkPct = benchmark > 0 ? ((pps - benchmark) / benchmark) * 100 : null;
    return { id: c.id, vendorName, productName,
      category: categoryName, department: c.department,
      seatsLicensed: c.seatsLicensed, totalValue: Number(c.totalValue),
      pricePerSeat: pps, categoryBenchmark: benchmark, vsBenchmarkPct,
      outlier: vsBenchmarkPct != null && vsBenchmarkPct > 20 };
  }).sort((a, b) => b.pricePerSeat - a.pricePerSeat);

  const categoryBreakdown = Object.entries<any>(catAvg).map(([category, avgPricePerSeat]) => ({
    category, avgPricePerSeat, contractCount: catBench[category].count,
  })).sort((a, b) => b.avgPricePerSeat - a.avgPricePerSeat);

  const totalSeats = rows.reduce((s, r) => s + (r.seatsLicensed || 0), 0);
  return {
    rows, categoryBreakdown,
    summary: {
      totalContracts: rows.length,
      contractCount:  rows.length,
      outlierCount:   rows.filter(r => r.outlier).length,
      totalSeats,
    },
  };
}

router.get('/price-per-seat-benchmark', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildPricePerSeatBenchmark(req) }); }
  catch (err) { console.error('[reports] price-per-seat-benchmark', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 6. GL Code Spend Breakdown ────────────────────────────────────────────────
async function buildGlCodeSpend(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, glCode: true, totalValue: true, endDate: true,
      vendor:   { select: { name: true } },
      category: { select: { name: true } },
    },
  });

  const byCode: any = {};
  for (const c of contracts) {
    const code = c.glCode || '__untagged__';
    const vendorName = c.vendor?.name || null;
    if (!byCode[code]) byCode[code] = { glCode: c.glCode || null, vendors: new Set(), contractCount: 0, totalSpend: 0, contracts: [] };
    if (vendorName) byCode[code].vendors.add(vendorName);
    byCode[code].contractCount++;
    byCode[code].totalSpend += c.totalValue ? Number(c.totalValue) : 0;
    byCode[code].contracts.push({ id: c.id, vendorName,
      totalValue: c.totalValue ? Number(c.totalValue) : null, endDate: c.endDate });
  }

  const total = contracts.reduce((s, c) => s + (c.totalValue ? Number(c.totalValue) : 0), 0);
  const rows = Object.values<any>(byCode).map(d => ({
    glCode: d.glCode, vendorCount: d.vendors.size, contractCount: d.contractCount,
    totalSpend: d.totalSpend, portfolioPct: total > 0 ? (d.totalSpend / total) * 100 : 0,
    contracts: d.contracts,
  })).sort((a, b) => b.totalSpend - a.totalSpend);

  const taggedSpend   = rows.filter(r => r.glCode).reduce((s, r) => s + r.totalSpend, 0);
  const untaggedSpend = rows.filter(r => !r.glCode).reduce((s, r) => s + r.totalSpend, 0);
  const rowsWithShare = rows.map(r => ({ ...r, sharePct: r.portfolioPct }));
  return {
    summary: {
      glCodeCount:    rows.filter(r => r.glCode).length,
      codeCount:      rows.filter(r => r.glCode).length,
      taggedSpend,
      untaggedSpend,
      totalSpend:     total,
      totalContracts: contracts.length,
      untaggedCount:  contracts.filter(c => !c.glCode).length,
    },
    rows: rowsWithShare,
  };
}

router.get('/gl-code-spend', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildGlCodeSpend(req) }); }
  catch (err) { console.error('[reports] gl-code-spend', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 7. Walkaway Calculator ────────────────────────────────────────────────────
const SWITCH_COST_PCT: any = {
  saas: 15, telecom: 25, hardware: 20, services: 10,
  insurance: 5, lease_rent: 30, default: 15,
};

async function buildWalkawayCalculator(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const horizonMonths = Math.max(1, Math.min(24, parseInt(req.query.horizonMonths ?? 12)));
  const customOverride = Math.max(0, Math.min(100, parseFloat(req.query.switchCostPct)));
  const now    = new Date();
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() + horizonMonths);

  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', endDate: { gte: now, lte: cutoff }, totalValue: { not: null }, ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true, endDate: true,
      totalValue: true, originalAsk: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true, slug: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  const rows = contracts.map(c => {
    const renewalCost  = Number(c.totalValue);
    const categoryName = c.category?.name || null;
    const catKey       = (c.category?.slug || c.category?.name || 'default').toLowerCase().replace(/[^a-z_]/g, '_');
    const switchPct    = !isNaN(customOverride) ? customOverride : (SWITCH_COST_PCT[catKey] ?? SWITCH_COST_PCT.default);
    const switchCost   = renewalCost * (switchPct / 100);
    const daysToRenewal = Math.ceil((new Date(c.endDate).getTime() - now.getTime()) / 86400000);
    // Recommend switch if switching cost < 20% of annual contract value (switch pays back < 3 months)
    const netSavingsIfWalk = renewalCost - switchCost;
    const verdict = switchCost < renewalCost * 0.20 ? 'walkaway'
                  : switchCost < renewalCost * 0.35 ? 'borderline'
                  : 'renew';
    return { id: c.id,
      vendorName:    c.vendor?.name || null,
      productName:   c.product      || null,
      category:      categoryName,
      department:    c.department,
      contractOwner: c.internalOwner?.name || c.internalOwnerName || null,
      endDate: c.endDate,
      renewalCost, switchCostPct: switchPct, switchPct, switchCost,
      netSavingsIfWalk, daysToRenewal, verdict,
      recommendation: verdict === 'walkaway' ? 'investigate' : 'renew' };
  });

  return {
    params: { horizonMonths, switchCostPctOverride: !isNaN(customOverride) ? customOverride : null },
    summary: {
      totalContracts:  rows.length,
      contractCount:   rows.length,
      walkawayCount:   rows.filter(r => r.verdict === 'walkaway').length,
      borderlineCount: rows.filter(r => r.verdict === 'borderline').length,
      renewCount:      rows.filter(r => r.verdict === 'renew').length,
      investigateCount: rows.filter(r => r.verdict === 'walkaway').length,
      totalRenewalCost: rows.reduce((s, r) => s + r.renewalCost, 0),
    },
    switchCostDefaults: SWITCH_COST_PCT, rows,
  };
}

router.get('/walkaway-calculator', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildWalkawayCalculator(req) }); }
  catch (err) { console.error('[reports] walkaway-calculator', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 8. Portfolio Decision Dashboard ──────────────────────────────────────────
async function buildPortfolioDecisionDashboard(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true, endDate: true, totalValue: true,
      seatsLicensed: true, seatsActivelyInUse: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  const now = new Date();
  const rows = await Promise.all(contracts.map(async c => {
    const status    = await getNegotiationAnalysisStatus(c.id, c);
    const daysToRenewal = c.endDate
      ? Math.ceil((new Date(c.endDate).getTime() - now.getTime()) / 86400000)
      : null;
    const urgency   = daysToRenewal != null
      ? (daysToRenewal <= 30 ? 'critical' : daysToRenewal <= 90 ? 'high' : daysToRenewal <= 180 ? 'medium' : 'low')
      : 'unknown';
    return {
      id: c.id,
      vendorName:    c.vendor?.name   || null,
      productName:   c.product        || null,
      category:      c.category?.name || null,
      department:    c.department,
      contractOwner: c.internalOwner?.name || c.internalOwnerName || null,
      endDate: c.endDate, totalValue: c.totalValue ? Number(c.totalValue) : null,
      daysToRenewal, urgency,
      aiVerdict:     status.cached ? status.verdict      : null,
      aiTier:        status.cached ? status.tier         : null,
      aiScore:       status.cached ? status.score        : null,
      aiAnalyzed:    status.cached,
    };
  }));

  const verdictCounts: any = {};
  for (const r of rows) if (r.aiVerdict) verdictCounts[r.aiVerdict] = (verdictCounts[r.aiVerdict] || 0) + 1;

  return {
    summary: {
      totalContracts:  rows.length,
      contractCount:   rows.length,
      analysedCount:   rows.filter(r => r.aiAnalyzed).length,
      analyzedCount:   rows.filter(r => r.aiAnalyzed).length,
      criticalCount:   rows.filter(r => r.urgency === 'critical').length,
      escalateCount:   verdictCounts.escalate  || 0,
      negotiateCount:  verdictCounts.negotiate || 0,
      renewCount:      verdictCounts.renew     || 0,
      reviewCount:     verdictCounts.review    || 0,
      verdictCounts,
    },
    rows,
  };
}

router.get('/portfolio-decision-dashboard', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildPortfolioDecisionDashboard(req) }); }
  catch (err) { console.error('[reports] portfolio-decision-dashboard', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 9. Renewal Win Rate ───────────────────────────────────────────────────────
async function buildRenewalWinRate(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, originalAsk: { not: null }, finalNegotiatedPrice: { not: null }, ...scopeWhere },
    select: {
      id: true, department: true, internalOwnerName: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
      originalAsk: true, finalNegotiatedPrice: true,
      endDate: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const byQuarter: any = {};
  let totalAsk = 0, totalSaved = 0;
  for (const c of contracts) {
    const ask   = Number(c.originalAsk);
    const final = Number(c.finalNegotiatedPrice);
    const saved = ask - final;
    const savingsPct = ask > 0 ? (saved / ask) * 100 : 0;
    totalAsk += ask; totalSaved += saved;
    const d = new Date(c.createdAt);
    const q = `${d.getFullYear()} Q${Math.ceil((d.getMonth() + 1) / 3)}`;
    if (!byQuarter[q]) byQuarter[q] = { quarter: q, dealCount: 0, totalAsk: 0, totalSaved: 0, savingsPcts: [] };
    byQuarter[q].dealCount++;
    byQuarter[q].totalAsk   += ask;
    byQuarter[q].totalSaved += saved;
    byQuarter[q].savingsPcts.push(savingsPct);
  }

  const trend = Object.values<any>(byQuarter).map(q => ({
    quarter: q.quarter, dealCount: q.dealCount,
    totalAsk: q.totalAsk, totalSaved: q.totalSaved,
    avgSavingsPct: q.savingsPcts.reduce((s, v) => s + v, 0) / q.savingsPcts.length,
    blendedSavingsPct: q.totalAsk > 0 ? (q.totalSaved / q.totalAsk) * 100 : 0,
  }));

  const blendedSavingsPct = totalAsk > 0 ? (totalSaved / totalAsk) * 100 : 0;
  const dealsWithSavings = contracts
    .map(c => {
      const ask   = Number(c.originalAsk);
      const final = Number(c.finalNegotiatedPrice);
      const saved = ask - final;
      const savingsPct = ask > 0 ? (saved / ask) * 100 : 0;
      return { id: c.id,
        vendorName: c.vendor?.name || null,
        category:   c.category?.name || null,
        contractOwner: c.internalOwner?.name || c.internalOwnerName || null,
        originalAsk: ask, finalPrice: final,
        saved, savingsPct };
    })
    .filter(d => d.saved > 0)
    .sort((a, b) => b.savingsPct - a.savingsPct);
  const bestDealEntry = dealsWithSavings[0] ?? null;
  return {
    summary: {
      totalDeals: contracts.length,
      totalAsk, totalSaved,
      blendedSavingsPct,
      portfolioAvgSavingsPct: blendedSavingsPct,
      bestDealSavingsPct: bestDealEntry?.savingsPct ?? null,
      bestDeal: bestDealEntry,
    },
    trend,
    bestDeals: dealsWithSavings.slice(0, 20),
  };
}

router.get('/renewal-win-rate', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildRenewalWinRate(req) }); }
  catch (err) { console.error('[reports] renewal-win-rate', err); res.status(500).json({ success: false, error: 'Failed' }); }
});

// ── 10. Contract Ownership Report ─────────────────────────────────────────────
async function buildContractOwnership(req) {
  const accountId = req.user.accountId;
  const scopeWhere: any = {};
  if (req.user.contractScopeRestricted) scopeWhere.internalOwnerId = req.user.id;
  const now      = new Date();
  const in90days = new Date(now); in90days.setDate(in90days.getDate() + 90);
  const contracts = await prisma.contract.findMany({
    take: REPORT_QUERY_CAP,
    where: { accountId, archivedAt: null, status: 'active', ...scopeWhere },
    select: {
      id: true, product: true,
      department: true, internalOwnerName: true, endDate: true, totalValue: true,
      vendor:        { select: { name: true } },
      category:      { select: { name: true } },
      internalOwner: { select: { name: true } },
    },
  });

  const byOwner: any = {};
  for (const c of contracts) {
    const ownerName = c.internalOwner?.name || c.internalOwnerName || null;
    const vendorName = c.vendor?.name || null;
    const ownerKey = ownerName || '__unassigned__';
    if (!byOwner[ownerKey]) byOwner[ownerKey] = { owner: ownerName, contractCount: 0, totalValue: 0, renewalsIn90d: 0, contracts: [] };
    byOwner[ownerKey].contractCount++;
    byOwner[ownerKey].totalValue += c.totalValue ? Number(c.totalValue) : 0;
    if (c.endDate && new Date(c.endDate) <= in90days && new Date(c.endDate) >= now)
      byOwner[ownerKey].renewalsIn90d++;
    byOwner[ownerKey].contracts.push({ id: c.id, vendorName,
      endDate: c.endDate, totalValue: c.totalValue ? Number(c.totalValue) : null });
  }

  const rows = Object.values<any>(byOwner).map(o => ({
    ...o,
    overloaded: o.renewalsIn90d >= 5,
  })).sort((a, b) => b.renewalsIn90d - a.renewalsIn90d || b.contractCount - a.contractCount);

  const unassigned = rows.find(r => r.owner === null);
  return {
    summary: {
      ownerCount:        rows.filter(r => r.owner).length,
      unassignedCount:   unassigned?.contractCount ?? 0,
      overloadedCount:   rows.filter(r => r.overloaded && r.owner).length,
      totalContracts:    contracts.length,
    },
    rows,
    unassignedContracts: unassigned?.contracts ?? [],
  };
}

router.get('/contract-ownership', requireManager, async (req, res) => {
  try { res.json({ success: true, data: await buildContractOwnership(req) }); }
  catch (err) { console.error('[reports] contract-ownership', err); res.status(500).json({ success: false, error: 'Failed' }); }
});


// ─── CSV Export Routes ────────────────────────────────────────────────────────

router.get('/total-addressable-waste/csv', requireManager, async (req, res) => {
  try {
    const data = await buildTotalAddressableWaste(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',               value: r => r.id },
      { header: 'Vendor',           value: r => r.vendorName },
      { header: 'Product',          value: r => r.productName },
      { header: 'Category',         value: r => r.category },
      { header: 'Department',       value: r => r.department },
      { header: 'Seats Licensed',   value: r => r.seatsLicensed },
      { header: 'Seats In Use',     value: r => r.seatsInUse },
      { header: 'Unused Seats',     value: r => r.unusedSeats },
      { header: 'Utilization %',    value: r => r.utilizationPct != null ? Number(r.utilizationPct).toFixed(1) : '' },
      { header: 'Wasted Cost',      value: r => r.wastedCost != null ? Number(r.wastedCost).toFixed(2) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_TotalAddressableWaste_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/total-addressable-waste/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/termination-window-violations/csv', requireManager, async (req, res) => {
  try {
    const data = await buildTerminationWindowViolations(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',                  value: r => r.id },
      { header: 'Vendor',              value: r => r.vendorName },
      { header: 'End Date',            value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Cancel By Date',      value: r => r.cancelByDate ? new Date(r.cancelByDate).toISOString().split('T')[0] : '' },
      { header: 'Days Until Deadline', value: r => r.daysUntilDeadline },
      { header: 'Severity',            value: r => r.severity },
      { header: 'Auto-Renews',         value: r => r.autoRenews ? 'Yes' : 'No' },
      { header: 'Annual Value',        value: r => r.annualValue != null ? Number(r.annualValue).toFixed(2) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_TerminationWindowViolations_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/termination-window-violations/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/license-reclamation-roi/csv', requireManager, async (req, res) => {
  try {
    const data = await buildLicenseReclamationRoi(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',             value: r => r.id },
      { header: 'Vendor',         value: r => r.vendorName },
      { header: 'Product',        value: r => r.productName },
      { header: 'Category',       value: r => r.category },
      { header: 'Seats Licensed', value: r => r.seatsLicensed },
      { header: 'Seats In Use',   value: r => r.seatsInUse },
      { header: 'Unused Seats',   value: r => r.unusedSeats },
      { header: 'Annual Savings', value: r => r.annualSavings != null ? Number(r.annualSavings).toFixed(2) : '' },
      { header: 'ROI Tier',       value: r => r.roiTier },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_LicenseReclamationROI_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/license-reclamation-roi/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/cost-per-active-user/csv', requireManager, async (req, res) => {
  try {
    const data = await buildCostPerActiveUser(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',                   value: r => r.id },
      { header: 'Vendor',               value: r => r.vendorName },
      { header: 'Product',              value: r => r.productName },
      { header: 'Category',             value: r => r.category },
      { header: 'Department',           value: r => r.department },
      { header: 'Active Users',         value: r => r.seatsActivelyInUse },
      { header: 'Total Value',          value: r => r.totalValue != null ? Number(r.totalValue).toFixed(2) : '' },
      { header: 'Cost Per Active User', value: r => r.costPerActiveUser != null ? Number(r.costPerActiveUser).toFixed(2) : '' },
      { header: 'Category Benchmark',   value: r => r.categoryBenchmark != null ? Number(r.categoryBenchmark).toFixed(2) : '' },
      { header: 'vs Benchmark %',       value: r => r.vsBenchmarkPct != null ? Number(r.vsBenchmarkPct).toFixed(1) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_CostPerActiveUser_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/cost-per-active-user/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/negotiation-effectiveness-by-owner/csv', requireManager, async (req, res) => {
  try {
    const data = await buildNegotiationEffectivenessByOwner(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Owner',               value: r => r.owner },
      { header: 'Deal Count',          value: r => r.dealCount },
      { header: 'Total Ask',           value: r => r.totalAsk != null ? Number(r.totalAsk).toFixed(2) : '' },
      { header: 'Total Saved',         value: r => r.totalSaved != null ? Number(r.totalSaved).toFixed(2) : '' },
      { header: 'Avg Savings %',       value: r => r.avgSavingsPct != null ? Number(r.avgSavingsPct).toFixed(1) : '' },
      { header: 'Blended Savings %',   value: r => r.blendedSavingsPct != null ? Number(r.blendedSavingsPct).toFixed(1) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_NegotiationEffectivenessByOwner_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/negotiation-effectiveness-by-owner/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/vendor-negotiation-difficulty/csv', requireManager, async (req, res) => {
  try {
    const data = await buildVendorNegotiationDifficulty(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Vendor',            value: r => r.vendorName },
      { header: 'Category',          value: r => r.category },
      { header: 'Deal Count',        value: r => r.dealCount },
      { header: 'Total Ask',         value: r => r.totalAsk != null ? Number(r.totalAsk).toFixed(2) : '' },
      { header: 'Total Saved',       value: r => r.totalSaved != null ? Number(r.totalSaved).toFixed(2) : '' },
      { header: 'Avg Savings %',     value: r => r.avgSavingsPct != null ? Number(r.avgSavingsPct).toFixed(1) : '' },
      { header: 'Difficulty Score',  value: r => r.difficultyScore != null ? Number(r.difficultyScore).toFixed(2) : '' },
      { header: 'Difficulty Tier',   value: r => r.difficultyTier },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_VendorNegotiationDifficulty_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/vendor-negotiation-difficulty/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/price-escalation-radar/csv', requireManager, async (req, res) => {
  try {
    const data = await buildPriceEscalationRadar(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',              value: r => r.id },
      { header: 'Vendor',          value: r => r.vendorName },
      { header: 'Product',         value: r => r.productName },
      { header: 'Category',        value: r => r.category },
      { header: 'Original Ask',    value: r => r.originalAsk != null ? Number(r.originalAsk).toFixed(2) : '' },
      { header: 'Current Value',   value: r => r.currentValue != null ? Number(r.currentValue).toFixed(2) : '' },
      { header: 'Excess Cost',     value: r => r.excessCost != null ? Number(r.excessCost).toFixed(2) : '' },
      { header: 'Escalation %',    value: r => r.escalationPct != null ? Number(r.escalationPct).toFixed(1) : '' },
      { header: 'Flagged',         value: r => r.flagged ? 'Yes' : 'No' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_PriceEscalationRadar_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/price-escalation-radar/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/multi-year-commitment-risk/csv', requireManager, async (req, res) => {
  try {
    const data = await buildMultiYearCommitmentRisk(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',                   value: r => r.id },
      { header: 'Vendor',               value: r => r.vendorName },
      { header: 'Product',              value: r => r.productName },
      { header: 'Category',             value: r => r.category },
      { header: 'Department',           value: r => r.department },
      { header: 'End Date',             value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Months Remaining',     value: r => r.monthsRemaining },
      { header: 'Annual Value',         value: r => r.annualValue != null ? Number(r.annualValue).toFixed(2) : '' },
      { header: 'Remaining Commitment', value: r => r.remainingCommitment != null ? Number(r.remainingCommitment).toFixed(2) : '' },
      { header: 'Lock-In Tier',         value: r => r.lockInTier },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_MultiYearCommitmentRisk_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/multi-year-commitment-risk/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/contract-health-score/csv', requireManager, async (req, res) => {
  try {
    const data = await buildContractHealthScore(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',              value: r => r.id },
      { header: 'Vendor',          value: r => r.vendorName },
      { header: 'Category',        value: r => r.category },
      { header: 'Owner',           value: r => r.contractOwner },
      { header: 'Score',           value: r => r.score },
      { header: 'Grade',           value: r => r.grade },
      { header: 'Required Fields', value: r => r.checks && r.checks.requiredFields ? 'Yes' : 'No' },
      { header: 'Owner Assigned',  value: r => r.checks && r.checks.ownerAssigned ? 'Yes' : 'No' },
      { header: 'Auto-Renew Set',  value: r => r.checks && r.checks.autoRenewSet ? 'Yes' : 'No' },
      { header: 'Deadline Set',    value: r => r.checks && r.checks.deadlineSet ? 'Yes' : 'No' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_ContractHealthScore_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/contract-health-score/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/department-budget-allocation/csv', requireManager, async (req, res) => {
  try {
    const data = await buildDepartmentBudgetAllocation(req);
    const csv = toCSV((data as any).contracts, [
      { header: 'ID',          value: r => r.id },
      { header: 'Vendor',      value: r => r.vendorName },
      { header: 'Product',     value: r => r.productName },
      { header: 'Department',  value: r => r.department },
      { header: 'Category',    value: r => r.category },
      { header: 'End Date',    value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Total Value', value: r => r.totalValue != null ? Number(r.totalValue).toFixed(2) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_DepartmentBudgetAllocation_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/department-budget-allocation/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/price-per-seat-benchmark/csv', requireManager, async (req, res) => {
  try {
    const data = await buildPricePerSeatBenchmark(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',               value: r => r.id },
      { header: 'Vendor',           value: r => r.vendorName },
      { header: 'Product',          value: r => r.productName },
      { header: 'Category',         value: r => r.category },
      { header: 'Seats Licensed',   value: r => r.seatsLicensed },
      { header: 'Annual Value',     value: r => r.annualValue != null ? Number(r.annualValue).toFixed(2) : '' },
      { header: 'Cost Per Seat',    value: r => r.costPerSeat != null ? Number(r.costPerSeat).toFixed(2) : '' },
      { header: 'Category Avg',     value: r => r.categoryAvg != null ? Number(r.categoryAvg).toFixed(2) : '' },
      { header: 'vs Avg %',         value: r => r.vsAvgPct != null ? Number(r.vsAvgPct).toFixed(1) : '' },
      { header: 'Outlier',          value: r => r.outlier ? 'Yes' : 'No' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_PricePerSeatBenchmark_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/price-per-seat-benchmark/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/gl-code-spend/csv', requireManager, async (req, res) => {
  try {
    const data = await buildGlCodeSpend(req);
    const csv = toCSV((data as any).rows, [
      { header: 'GL Code',         value: r => r.glCode },
      { header: 'Contract Count',  value: r => r.contractCount },
      { header: 'Total Spend',     value: r => r.totalSpend != null ? Number(r.totalSpend).toFixed(2) : '' },
      { header: 'Share %',         value: r => r.sharePct != null ? Number(r.sharePct).toFixed(1) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_GLCodeSpend_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/gl-code-spend/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/walkaway-calculator/csv', requireManager, async (req, res) => {
  try {
    const data = await buildWalkawayCalculator(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',                   value: r => r.id },
      { header: 'Vendor',               value: r => r.vendorName },
      { header: 'Category',             value: r => r.category },
      { header: 'Renewal Cost',         value: r => r.renewalCost != null ? Number(r.renewalCost).toFixed(2) : '' },
      { header: 'Switch Cost',          value: r => r.switchCost != null ? Number(r.switchCost).toFixed(2) : '' },
      { header: 'Switch Cost %',        value: r => r.switchCostPct != null ? Number(r.switchCostPct).toFixed(1) : '' },
      { header: 'Net Savings If Walk',  value: r => r.netSavingsIfWalk != null ? Number(r.netSavingsIfWalk).toFixed(2) : '' },
      { header: 'Verdict',              value: r => r.verdict },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_WalkawayCalculator_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/walkaway-calculator/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/portfolio-decision-dashboard/csv', requireManager, async (req, res) => {
  try {
    const data = await buildPortfolioDecisionDashboard(req);
    const csv = toCSV((data as any).rows, [
      { header: 'ID',             value: r => r.id },
      { header: 'Vendor',         value: r => r.vendorName },
      { header: 'Category',       value: r => r.category },
      { header: 'Owner',          value: r => r.contractOwner },
      { header: 'End Date',       value: r => r.endDate ? new Date(r.endDate).toISOString().split('T')[0] : '' },
      { header: 'Total Value',    value: r => r.totalValue != null ? Number(r.totalValue).toFixed(2) : '' },
      { header: 'AI Score',       value: r => r.aiScore },
      { header: 'AI Verdict',     value: r => r.aiVerdict },
      { header: 'AI Analyzed',    value: r => r.aiAnalyzed ? 'Yes' : 'No' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_PortfolioDecisionDashboard_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/portfolio-decision-dashboard/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/renewal-win-rate/csv', requireManager, async (req, res) => {
  try {
    const data = await buildRenewalWinRate(req);
    const csv = toCSV(data.bestDeals, [
      { header: 'ID',           value: r => r.id },
      { header: 'Vendor',       value: r => r.vendorName },
      { header: 'Category',     value: r => r.category },
      { header: 'Owner',        value: r => r.contractOwner },
      { header: 'Original Ask', value: r => r.originalAsk != null ? Number(r.originalAsk).toFixed(2) : '' },
      { header: 'Final Price',  value: r => r.finalPrice != null ? Number(r.finalPrice).toFixed(2) : '' },
      { header: 'Saved',        value: r => r.saved != null ? Number(r.saved).toFixed(2) : '' },
      { header: 'Savings %',    value: r => r.savingsPct != null ? Number(r.savingsPct).toFixed(1) : '' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_RenewalWinRate_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/renewal-win-rate/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

router.get('/contract-ownership/csv', requireManager, async (req, res) => {
  try {
    const data = await buildContractOwnership(req);
    const csv = toCSV((data as any).rows, [
      { header: 'Owner',             value: r => r.owner },
      { header: 'Contract Count',    value: r => r.contractCount },
      { header: 'Total Value',       value: r => r.totalValue != null ? Number(r.totalValue).toFixed(2) : '' },
      { header: 'Renewals in 90d',   value: r => r.renewalsIn90d },
      { header: 'Overloaded',        value: r => r.overloaded ? 'Yes' : 'No' },
    ]);
    const date = new Date().toISOString().split('T')[0];
    sendCSV(res, `LapseIQ_ContractOwnership_${date}.csv`, csv);
  } catch (err) {
    console.error('GET /reports/contract-ownership/csv:', err);
    res.status(500).json({ success: false, error: 'Failed to build CSV.' });
  }
});

module.exports = router;
module.exports.aggregateContracts = aggregateContracts;
module.exports.contractSpend      = contractSpend;
module.exports.p

export {};
