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

// ── Asset helpers ─────────────────────────────────────────────────────────────

/**
 * Return the earliest nextDueDate across an asset's (included) maintenance
 * schedules, or null when no schedule carries a due date. The asset list
 * export includes only active schedules, so this is the same "Next Due"
 * value the list page renders.
 */
function earliestNextDue(a) {
  const times = (a?.schedules || [])
    .map(s => s?.nextDueDate)
    .filter(Boolean)
    .map(d => new Date(d).getTime())
    .filter(t => !Number.isNaN(t));
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

// ── CSV writer ────────────────────────────────────────────────────────────────

/** Escape a single CSV cell, with the H6 formula-injection guard. */
function csvCell(v) {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString().split('T')[0] : String(v);
  if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s; // H6: formula injection guard
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Send rows as a CSV attachment using the same column-registry shape
 * sendXlsx consumes ({ id, header, type, get }). Counterpart to
 * lib/xlsxExport.js#sendXlsx for clients that want plain CSV.
 */
function sendCsv(res, { columnDefs, rows, filename }) {
  const header = columnDefs.map(c => csvCell(c.header)).join(',');
  const lines = rows.map(r => columnDefs.map(c => csvCell(c.get(r))).join(','));
  const body = [header, ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(body);
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
  earliestNextDue,
  csvCell,
  sendCsv,
};

export {};
