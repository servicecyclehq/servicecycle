'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/exportHelpers.js — pure helper functions shared by routes/export.js.
//
// Extracted so they can be unit-tested without pulling in Prisma or Express.
// All functions here are deterministic and have zero side-effects.
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel value for "no value / blank" rows in multi-select column filters.
// Matches BLANK_SENTINEL in routes/alerts.js + the ColumnFilterDropdown client.
const BLANK_SENTINEL = '__BLANK__';

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Return a Date for d, or null if d is falsy/invalid. */
function dateOrNull(d) {
  if (!d) return null;
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Return ceiling-days from now to d, or null. */
function daysUntil(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.ceil((dt.getTime() - Date.now()) / 86_400_000);
}

/** Return today as YYYY-MM-DD (UTC). */
function dateStamp() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Parse a YYYY-MM-DD string into a Date at T00:00:00.000Z.
 * Returns null for non-matching or invalid input.
 */
function parseDateStartUtc(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00.000Z');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parse a YYYY-MM-DD string into a Date at T23:59:59.999Z.
 * Returns null for non-matching or invalid input.
 */
function parseDateEndUtc(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T23:59:59.999Z');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Build a Prisma date-range clause for `field` from raw YYYY-MM-DD strings.
 * Returns null if neither bound resolves to a valid date.
 */
function dateRangeClause(field, fromRaw, toRaw) {
  const from = parseDateStartUtc(fromRaw);
  const to   = parseDateEndUtc(toRaw);
  if (!from && !to) return null;
  const clause: any = {};
  if (from) clause.gte = from;
  if (to)   clause.lte = to;
  return { [field]: clause };
}

// ── Number helper ─────────────────────────────────────────────────────────────

/** Parse a query-string number or return null. */
function parseNum(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = typeof s === 'number' ? s : parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── List parser ───────────────────────────────────────────────────────────────

/**
 * Parse a comma-separated multi-value param (?vendorIn=Adobe,Microsoft) or
 * repeated query keys (?vendorIn=Adobe&vendorIn=Microsoft). Trims, drops
 * empties or values >200 chars, caps at 200 entries.
 */
function parseList(raw) {
  if (raw == null) return [];
  let arr;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = raw.split(',');
  else return [];
  return arr
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(s => s.length > 0 && s.length <= 200)
    .slice(0, 200);
}

// ── Column registry filter ────────────────────────────────────────────────────

/**
 * Return only the registry entries whose `id` appears in the `columnsQuery`
 * CSV string. If columnsQuery is absent or empty, return the full registry.
 */
function filterToRequestedColumns(registry, columnsQuery) {
  if (!columnsQuery) return registry;
  const wanted = new Set(
    String(columnsQuery).split(',').map(s => s.trim()).filter(Boolean)
  );
  if (wanted.size === 0) return registry;
  return registry.filter(c => wanted.has(c.id));
}

// ── Vendor helpers ────────────────────────────────────────────────────────────

/** Sum active-contract spend for a vendor row (from Prisma include). */
function vendorSpend(v) {
  return (v.contracts || []).reduce(
    (s, c) => s + (c.costPerLicense && c.quantity
      ? parseFloat(c.costPerLicense) * parseInt(c.quantity, 10)
      : 0),
    0,
  );
}

/** Return the most-recent contact timestamp as a Date, or null. */
function vendorLastContact(v) {
  const commTs    = v.communications?.[0]?.createdAt
    ? new Date(v.communications[0].createdAt).getTime() : 0;
  const contactTs = v.contacts?.[0]?.lastContactedAt
    ? new Date(v.contacts[0].lastContactedAt).getTime() : 0;
  const t = Math.max(commTs, contactTs);
  return t > 0 ? new Date(t) : null;
}

// ── Activity-log where-clause builder ────────────────────────────────────────

/**
 * Build a Prisma `where` object for activityLog.findMany from an Express
 * request object. Mirrors activity.js#buildWhere — kept here so export.js
 * stays standalone. Keep in sync with activity.js if it evolves.
 *
 * @param {{ user: { accountId: string }, query: Record<string,string> }} req
 */
function buildActivityWhere(req) {
  const q = req.query || {};
  const where: any = { accountId: req.user.accountId };

  const actionList = parseList(q.actionIn);
  if (actionList.length > 0) where.action = { in: actionList };
  else if (q.action) where.action = q.action;

  const userList = parseList(q.userIdIn);
  if (userList.length > 0) {
    const wantsBlank = userList.includes(BLANK_SENTINEL);
    const real = userList.filter(v => v !== BLANK_SENTINEL);
    if (real.length > 0 && wantsBlank) {
      where.OR = [...(where.OR || []), { userId: { in: real } }, { userId: null }];
    } else if (real.length > 0) {
      where.userId = { in: real };
    } else if (wantsBlank) {
      where.userId = null;
    }
  } else if (q.userId) {
    where.userId = q.userId;
  }

  if (q.contractId) where.contractId = q.contractId;

  if (q.dateFrom || q.dateTo) {
    where.createdAt = {};
    if (q.dateFrom) {
      const t = new Date(q.dateFrom);
      if (!Number.isNaN(t.getTime())) where.createdAt.gte = t;
    }
    if (q.dateTo) {
      const t = new Date(q.dateTo);
      if (!Number.isNaN(t.getTime())) {
        t.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = t;
      }
    }
  }
  return where;
}

module.exports = {
  BLANK_SENTINEL,
  dateOrNull,
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
};

export {};
