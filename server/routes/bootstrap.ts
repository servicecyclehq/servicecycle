// ─────────────────────────────────────────────────────────────────────────────
// routes/bootstrap.js — v0.47 perf
//
// Single round-trip endpoint that hydrates everything ContractsList needs on
// first mount: contracts page + pagination, members list, vendor lookup,
// category lookup, public account settings, and the user's column-visibility
// preference. Pre-v0.47, ContractsList fired 6 sequential-discoverable mount
// fetches (each gated by the previous one's parse-and-effect-schedule cycle);
// at ~250 ms CF-edge RTT each, that was the slowest-of-six tax on every page
// refresh. Bundling them server-side cuts the wall-clock to one RTT + the
// time of the slowest server-side query in the bundle.
//
// API contract:
//   GET /api/bootstrap?<same query params as /api/contracts>
//   → 200 {
//       success: true,
//       data: {
//         contracts:      Contract[],
//         pagination:     { page, limit, total, pages },
//         scopeRestricted: boolean,
//         members:        { id, name }[],
//         vendors:        { id, name }[],
//         categories:     (Category & { contractCount })[],
//         settings:       { fiscalYearStartMonth, onboardingComplete, passwordMinLength },
//         preferences:    { 'contracts.columnVisibility': any | null },
//       }
//     }
//
// Auth: mounted with authenticateToken upstream in server/index.js. No role
// gate — every authenticated user (admin/manager/viewer/consultant) has the
// same read access to their own account's contracts that /api/contracts grants
// them. Scope-restricted viewers are honored by the same internalOwnerId
// clause /api/contracts uses.
//
// ⚠ Keep the contracts-query logic in SYNC with `server/routes/contracts.js`
// `GET /` (lines ~831-1047). The where + orderBy + include shapes are
// intentionally duplicated rather than refactored so the existing list
// endpoint's behavior cannot regress from a shared-helper rewrite. If you
// change the filter accepted query params there, mirror them here.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
import prisma from '../lib/prisma';

// ─── Local copies of the v0.44 column-filter helpers ───────────────────────
// Mirrors server/routes/contracts.js. Kept local so this route never has a
// load-time dependency on the contracts module (avoids accidental circular
// require if contracts.js is later split).
function parseList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((v) => parseList(v));
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 200);
}
function parseNum(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}
function dateRangeClause(field, from, to) {
  if (!from && !to) return null;
  const clause: any = {};
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) clause.gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) {
      // End-of-day for `to` so a YYYY-MM-DD bound is inclusive.
      d.setHours(23, 59, 59, 999);
      clause.lte = d;
    }
  }
  return Object.keys(clause).length === 0 ? null : { [field]: clause };
}

function applyColumnFilters(where, params) {
  // Vendor name multi-select
  {
    const list = parseList(params.vendorIn);
    if (list.length > 0) {
      where.vendor = { ...(where.vendor || {}), name: { in: list } };
    }
  }
  // Product multi-select
  {
    const list = parseList(params.productIn);
    if (list.length > 0) {
      where.AND = [...(where.AND || []), { product: { in: list } }];
    }
  }
  // PO multi-select with __BLANK__ sentinel
  {
    const list = parseList(params.poIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) {
        ors.push({ poNumber: { in: realList } });
        ors.push({ purchaseOrders: { some: { archivedAt: null, poNumber: { in: realList } } } });
      }
      if (wantsBlank) {
        ors.push({
          AND: [{ poNumber: null }, { purchaseOrders: { none: { archivedAt: null } } }],
        });
      }
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Owner multi-select with __BLANK__ sentinel
  {
    const list = parseList(params.ownerIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) {
        ors.push({ internalOwner: { name: { in: realList } } });
        ors.push({ internalOwnerName: { in: realList } });
      }
      if (wantsBlank) {
        ors.push({ AND: [{ internalOwnerId: null }, { internalOwnerName: null }] });
      }
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Status multi-select
  {
    const list = parseList(params.statusIn);
    if (list.length > 0) where.status = { in: list };
  }
  // Category multi-select with __BLANK__ sentinel
  {
    const list = parseList(params.categoryIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ category: { name: { in: realList } } });
      if (wantsBlank)          ors.push({ categoryId: null });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // ── v0.57: 5 new multi-select column filters (mirrors contracts.js) ──
  // Auto-Renewal: Yes / No. Both selected = no narrowing.
  {
    const list = parseList(params.autoRenewalIn);
    if (list.length > 0) {
      const wantsYes = list.includes('Yes');
      const wantsNo  = list.includes('No');
      if (wantsYes && !wantsNo)      where.autoRenewal = true;
      else if (wantsNo && !wantsYes) where.autoRenewal = false;
    }
  }
  // Department free-text with __BLANK__ sentinel
  {
    const list = parseList(params.departmentIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ department: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ department: null }, { department: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Contract #
  {
    const list = parseList(params.contractNumberIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ contractNumber: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ contractNumber: null }, { contractNumber: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Customer #
  {
    const list = parseList(params.customerNumberIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ customerNumber: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ customerNumber: null }, { customerNumber: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Reseller (Contract.resellerName)
  {
    const list = parseList(params.resellerIn);
    if (list.length > 0) {
      const wantsBlank = list.includes('__BLANK__');
      const realList   = list.filter((v) => v !== '__BLANK__');
      const ors = [];
      if (realList.length > 0) ors.push({ resellerName: { in: realList } });
      if (wantsBlank)          ors.push({ OR: [{ resellerName: null }, { resellerName: '' }] });
      if (ors.length > 0) where.AND = [...(where.AND || []), { OR: ors }];
    }
  }
  // Date-range columns
  const endDateClause   = dateRangeClause('endDate', params.endDateFrom, params.endDateTo);
  const evalStartClause = dateRangeClause('evaluationStartByDate', params.evalStartFrom, params.evalStartTo);
  const cancelByClause  = dateRangeClause('cancelByDate', params.cancelByFrom, params.cancelByTo);
  if (endDateClause)   where.AND = [...(where.AND || []), endDateClause];
  if (evalStartClause) where.AND = [...(where.AND || []), evalStartClause];
  if (cancelByClause)  where.AND = [...(where.AND || []), cancelByClause];
  // v0.57: start-date range filter (mirrors contracts.js).
  const startDateClause = dateRangeClause('startDate', params.startDateFrom, params.startDateTo);
  if (startDateClause) where.AND = [...(where.AND || []), startDateClause];
  // Value range
  const valueMinNum = parseNum(params.valueMin);
  const valueMaxNum = parseNum(params.valueMax);
  if (valueMinNum !== null || valueMaxNum !== null) {
    const clause: any = {};
    if (valueMinNum !== null) clause.gte = valueMinNum;
    if (valueMaxNum !== null) clause.lte = valueMaxNum;
    where.AND = [...(where.AND || []), { totalValue: clause }];
  }
  return where;
}

// ── Local copy of autoExpireContracts (matches routes/contracts.js) ────────
async function autoExpireContracts(accountId) {
  try {
    await prisma.contract.updateMany({
      where: {
        accountId,
        status: { in: ['active', 'under_review'] },
        endDate: { lt: new Date() },
      },
      data: { status: 'expired' },
    });
  } catch (err) {
    console.error('[bootstrap] autoExpireContracts error:', err.message);
  }
}

// ─── GET /api/bootstrap ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // Background-fire auto-expire (same rationale as /api/contracts in v0.46).
    autoExpireContracts(req.user.accountId).catch((err) =>
      console.error('[bootstrap] background autoExpire failed:', err?.message || err)
    );

    // ── Parse query params (mirrors /api/contracts GET /) ─────────────────
    const {
      page = 1, limit = 25,
      status, vendorId, search,
      sort = 'endDate', sortDir = 'asc',
      renewal,
      endMonth,
      ownerId,
      payment,
      excludeExpired,
      categoryId,
      hasPO,
      evaluateBy,
      // (v0.44 column filters consumed by applyColumnFilters via req.query)
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // ── where: toolbar filters ────────────────────────────────────────────
    const where: any = { accountId: req.user.accountId, archivedAt: null };
    if (req.user.contractScopeRestricted) {
      where.internalOwnerId = req.user.id;
    } else {
      if (ownerId === 'unassigned') where.internalOwnerId = null;
      else if (ownerId)             where.internalOwnerId = ownerId;
    }
    if (status)                              where.status = status;
    else if (excludeExpired === 'true')      where.status = { not: 'expired' };
    if (vendorId)   where.vendorId   = vendorId;
    if (categoryId) where.categoryId = categoryId;

    if (search) {
      where.OR = [
        { product:        { contains: search, mode: 'insensitive' } },
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { poNumber:       { contains: search, mode: 'insensitive' } },
        { department:     { contains: search, mode: 'insensitive' } },
        { vendor: { name: { contains: search, mode: 'insensitive' } } },
        {
          purchaseOrders: {
            some: { archivedAt: null, poNumber: { contains: search, mode: 'insensitive' } },
          },
        },
      ];
    }

    const now = new Date();
    if (endMonth && /^\d{4}-\d{2}$/.test(endMonth)) {
      const [yr, mo] = endMonth.split('-').map(Number);
      where.endDate = { gte: new Date(yr, mo - 1, 1), lt: new Date(yr, mo, 1) };
    }
    if (renewal) {
      if (renewal === 'cancel30') {
        where.status = { in: ['active', 'under_review'] };
        where.autoRenewal = true;
        where.cancelByDate = { gte: now, lte: new Date(now.getTime() + 30 * 86_400_000) };
      } else if (renewal === 'overdue') {
        where.endDate = { lt: now };
        where.status  = { in: ['active', 'under_review'] };
      } else if (renewal === 'expiringMonth') {
        const som = new Date(now.getFullYear(), now.getMonth(), 1);
        const eom = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        where.endDate = { gte: som, lt: eom };
      } else {
        const days = parseInt(renewal.replace('renewing', ''));
        if (!isNaN(days)) {
          where.endDate = { gte: now, lte: new Date(now.getTime() + days * 86_400_000) };
        }
      }
    }
    if (hasPO === 'true')       where.purchaseOrders = { some: { archivedAt: null } };
    else if (hasPO === 'false') where.purchaseOrders = { none: {} };
    if (payment) {
      const days = parseInt(payment.replace('payment', ''));
      if (!isNaN(days)) {
        where.paymentSchedule = {
          installments: {
            some: { dueDate: { gte: now, lte: new Date(now.getTime() + days * 86_400_000) } },
          },
        };
      }
    }
    if (evaluateBy) {
      const days = parseInt(evaluateBy);
      if (!isNaN(days)) {
        where.evaluationStartByDate = {
          gte: now, lte: new Date(now.getTime() + days * 86_400_000),
        };
      }
    }
    applyColumnFilters(where, req.query);

    // ── orderBy (mirrors /api/contracts GET / sortMap) ────────────────────
    const dir = sortDir === 'desc' ? 'desc' : 'asc';
    const sortMap: any = {
      endDate:               { endDate: dir },
      evaluationStartByDate: { evaluationStartByDate: dir },
      cancelByDate:          { cancelByDate: dir },
      vendor:                { vendor: { name: dir } },
      product:               { product: dir },
      owner:                 { internalOwner: { name: { sort: dir, nulls: 'last' } } },
      value:                 { totalValue: { sort: dir, nulls: 'last' } },
    };
    const orderBy = sortMap[sort] || { endDate: 'asc' };

    // ── Parallel queries: contracts, count, lookups, settings, preference ─
    // v0.50 perf: dropped two queries from this batch -
    //   * categoryCounts (groupBy on contracts) - ContractsList never reads
    //     category.contractCount; the Settings page does, but pulls from
    //     /api/categories on its own mount, not from bootstrap. Removing
    //     this saves a full-table GROUP BY on every /contracts cold load.
    //   * columnVisibilityPref - useUserPreference("contracts.columnVisibility")
    //     does its own /api/preferences/... round-trip on mount; the value
    //     here was being fetched but never consumed.
    const [
      contracts,
      total,
      members,
      vendors,
      categories,
      settingsRows,
    ] = await Promise.all([
      // 1. Contracts page — same include shape as /api/contracts GET /
      prisma.contract.findMany({
        where, skip, take, orderBy,
        include: {
          // v0.50: trimmed include fields vs /api/contracts. Dropped
          // internalOwner.email, category.slug, purchaseOrders[0].id, and
          // _count.flags - none are read by contractsColumns.jsx. The full
          // shape is still served by ContractDetail's /api/contracts/:id.
          vendor:        { select: { id: true, name: true } },
          internalOwner: { select: { id: true, name: true } },
          category:      { select: { id: true, name: true, icon: true, color: true } },
          purchaseOrders: {
            where:   { archivedAt: null },
            select:  { poNumber: true, orderDate: true },
            orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
            take:    1,
          },
          _count: { select: { purchaseOrders: { where: { archivedAt: null } } } },
        },
      }),

      // 2. Total count for pagination
      prisma.contract.count({ where }),

      // 3. Members (id+name) — for owner-filter dropdown + bulk-action assign
      prisma.user.findMany({
        where:   { accountId: req.user.accountId, isActive: true },
        select:  { id: true, name: true },
        orderBy: { name: 'asc' },
      }),

      // 4. Vendors — slim shape (only id+name needed by ContractsList toolbar
      //    + columnFilter dropdown labels). Full vendor objects aren't needed
      //    here; the Vendors page calls /api/vendors directly.
      prisma.vendor.findMany({
        where:   { accountId: req.user.accountId },
        select:  { id: true, name: true },
        orderBy: { name: 'asc' },
      }),

      // 5. Categories — exclude archived; match /api/categories order
      prisma.category.findMany({
        where:   { accountId: req.user.accountId, archivedAt: null },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      // 6. Public settings (fiscalYearStartMonth + 2 others ContractsList
      //    doesn't read but /api/settings/public always returns)
      prisma.accountSetting.findMany({
        where: {
          accountId: req.user.accountId,
          key:       { in: ['FISCAL_YEAR_START_MONTH', 'ONBOARDING_COMPLETE', 'PASSWORD_MIN_LENGTH'] },
        },
      }),

    ]);
    // v0.50: contractCount enrichment dropped (consumer doesn't read it).

    // Reshape settings (matches /api/settings/public shape)
    const settingsKV: any = {};
    for (const r of settingsRows) settingsKV[r.key] = r.value;
    const settings: any = {
      fiscalYearStartMonth: parseInt(settingsKV['FISCAL_YEAR_START_MONTH'] || '1', 10),
      onboardingComplete:   settingsKV['ONBOARDING_COMPLETE'] === 'true',
      passwordMinLength:    parseInt(settingsKV['PASSWORD_MIN_LENGTH'] || '12', 10),
    };

    // v0.90.9: validate /api/bootstrap shape -- single highest-blast-radius
    // endpoint in the app (hits on /dashboard, /contracts, every navigation
    // between them; drives the contracts table, vendor dropdowns, owner
    // picker, settings-driven fiscal year start).
    const { validateResponse } = require('../lib/responseValidator');
    const { bootstrapSchema }  = require('../schemas/api');
    const payload: any = {
      success: true,
      data: {
        contracts,
        pagination: {
          page:  parseInt(page),
          limit: take,
          total,
          pages: Math.ceil(total / take),
        },
        scopeRestricted: req.user.contractScopeRestricted || false,
        members,
        vendors,
        categories,
        settings,
      },
    };
    res.json(validateResponse('/api/bootstrap', bootstrapSchema, payload, req));
  } catch (err) {
    console.error('[bootstrap] failed:', err);
    res.status(500).json({ success: false, error: 'Failed to load bootstrap data' });
  }
});

module.exports = router;

export {};
