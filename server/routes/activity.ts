/**
 * GET /api/activity
 * GET /api/activity/distinct/:column
 *
 * Account-wide activity log — returns paginated activity records for all
 * assets and users that belong to the requesting user's account.
 * Accessible to admin and manager roles only.
 *
 * v0.70.1 (2026-05-22): canonical list-page pattern propagation.
 *   • Added multi-value filter params: actionIn, userIdIn (comma-separated
 *     CSV, mirrors /api/alerts and /api/assets shape).
 *   • Added date-range filter params: dateFrom, dateTo (YYYY-MM-DD, both
 *     inclusive — `dateTo` extends to 23:59:59.999 of the chosen day).
 *   • Legacy `action` / `userId` single-value params kept for backwards
 *     compatibility with pre-v0.70 saved links + the OnboardingWizard
 *     "View activity" CTA.
 *   • New `/api/activity/distinct/:column` endpoint mirrors the alerts
 *     distinct route — supports `action` + `user` columns with Excel
 *     narrowing (the requested column's own filter is intentionally excluded).
 *
 * Query params (read):
 *   page        (int, default 1)
 *   limit       (int, default 50, max 200)
 *   action      (string — single-value, legacy)
 *   actionIn    (CSV string — multi-value, v0.70.1+)
 *   userId      (string — single-value, legacy)
 *   userIdIn    (CSV string — multi-value, v0.70.1+)
 *   assetId     (string — filter to one asset)
 *   dateFrom    (YYYY-MM-DD, v0.70.1+)
 *   dateTo      (YYYY-MM-DD, v0.70.1+)
 */

const express           = require('express');
const { requireManager, requireAdmin } = require('../middleware/roles');
import prisma from '../lib/prisma';

// #35 SIEM export cap — a single pull returns at most this many rows (oldest
// first). A SIEM ingests on a schedule with dateFrom/dateTo windows, so this
// caps memory without losing coverage.
const SIEM_EXPORT_MAX = 50000;

function cefEscapeHeader(s: any): string {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
function cefEscapeExt(s: any): string {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, ' ');
}
// Higher CEF severity for security-relevant events; default 3 (informational).
const CEF_SEVERITY: any = {
  login_failed: 6, login_lockout_triggered: 7, permission_denied: 6, admin_password_reset: 7,
  compliance_snapshot_integrity_failure: 9,
};

const router = express.Router();

// v0.70.1: shared sentinel between ColumnFilterDropdown + this distinct route.
const BLANK_SENTINEL = '__BLANK__';

// ── Human-readable labels for action types ────────────────────────────────────
const ACTION_LABELS: any = {
  asset_created:        'Asset added',
  condition_changed:    'Condition changed',
  fields_updated:       'Fields updated',
  work_order_completed: 'Work order completed',
  brief_generated:      'Maintenance brief generated',
  document_uploaded:    'Document uploaded',
  user_created:         'User added',
  // Sprint 5 (C1) — audit visibility additions
  login_failed:             'Failed login attempt',
  login_lockout_triggered:  'Account locked out (too many failures)',
  permission_denied:        'Permission denied',
  document_accessed:  'Document accessed',
  // 2026-05-03 audit (F010) — admin-initiated user-impersonation primitive
  admin_password_reset: 'Admin password reset (target user)',
  // 2026-05-10 review H5 — surface registration + successful login in the
  // Activity Log so freshly-onboarded users don't see "No activity found".
  account_created:    'Account created',
  login_success:      'Signed in',
  // 2026-05-11 v0.3.3 (F-005 parity) — custom field management is audited.
  custom_field_created:  'Custom field created',
  custom_field_updated:  'Custom field updated',
  custom_field_archived: 'Custom field archived',
  custom_field_restored: 'Custom field restored',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Parse a comma-separated CSV query param into an array of trimmed non-empty
// strings. Returns null when the param is missing/empty (so the caller knows
// to skip the filter clause entirely).
function parseCsv(v) {
  if (typeof v !== 'string' || !v) return null;
  const out = v.split(',').map(s => s.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

// Build the Prisma `where` clause from the request query. `excludeColumnId`
// is used by the distinct route to drop the requested column's own filter
// (Excel narrowing).
function buildWhere(req, excludeColumnId?) {
  const q          = req.query || {};
  const action     = excludeColumnId === 'action' ? null : (q.action     || null);
  const actionIn   = excludeColumnId === 'action' ? null : parseCsv(q.actionIn);
  const userId     = excludeColumnId === 'user'   ? null : (q.userId     || null);
  const userIdIn   = excludeColumnId === 'user'   ? null : parseCsv(q.userIdIn);
  const assetId    = q.assetId || null;
  const dateFrom   = excludeColumnId === 'date'   ? null : (q.dateFrom   || null);
  const dateTo     = excludeColumnId === 'date'   ? null : (q.dateTo     || null);

  // Support both denormalized rows (accountId set — new writes via fixed writeLog)
  // and legacy rows written before accountId was added to writeLog (accountId IS NULL,
  // matched via the user relation). Without this OR the activity log appears empty
  // on any installation where rows pre-date the writeLog accountId fix.
  const where: any = {
    AND: [
      {
        OR: [
          { accountId: req.user.accountId },
          { accountId: null, user: { accountId: req.user.accountId } },
        ],
      },
    ],
  };

  // Action: prefer multi-value if present, fall back to legacy single-value.
  if (actionIn && actionIn.length > 0) where.action = { in: actionIn };
  else if (action)                     where.action = action;

  // User: prefer multi-value. Treat BLANK_SENTINEL as "userId is null"
  // (covers GDPR-erased rows where userId was nulled but accountId stayed).
  if (userIdIn && userIdIn.length > 0) {
    const real = userIdIn.filter(v => v !== BLANK_SENTINEL);
    const wantsBlank = userIdIn.includes(BLANK_SENTINEL);
    if (real.length > 0 && wantsBlank) {
      where.OR = [...(where.OR || []), { userId: { in: real } }, { userId: null }];
    } else if (real.length > 0) {
      where.userId = { in: real };
    } else if (wantsBlank) {
      where.userId = null;
    }
  } else if (userId) {
    where.userId = userId;
  }

  if (assetId) where.assetId = assetId;

  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) {
      const t = new Date(dateFrom);
      if (!Number.isNaN(t.getTime())) where.createdAt.gte = t;
    }
    if (dateTo) {
      const t = new Date(dateTo);
      if (!Number.isNaN(t.getTime())) {
        // Inclusive end-of-day so a single-day range (from == to) catches
        // every row created that day.
        t.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = t;
      }
    }
  }

  return where;
}

// ── GET /api/activity ─────────────────────────────────────────────────────────
router.get('/', requireManager, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const skip  = (page - 1) * limit;
    const assetId = req.query.assetId || null;

    // Verify the asset belongs to this account before letting the filter
    // through; without this check the account-scope predicate below would
    // still match user-authored rows on assets in other accounts.
    if (assetId) {
      const ok = await prisma.asset.findFirst({
        where: { id: assetId, accountId: req.user.accountId },
        select: { id: true },
      });
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Asset not found' });
      }
    }

    // H8 (audit High, 2026-05-22): filter on ActivityLog.accountId directly
    // (denormalized since Pass-6 W4 MT-127) instead of joining through user.
    // Pre-fix, GDPR-erased users whose user row was deleted caused their
    // historical audit-log rows to disappear from admin views -- the join
    // failed and the rows got hidden. ActivityLog.userId is nullable so
    // erased rows still exist with userId=null + accountId=<tenant>;
    // they're now visible to the tenant's admin.
    const where = buildWhere(req);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user:  { select: { id: true, name: true, email: true, role: true } },
          asset: {
            select: {
              id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
              site: { select: { name: true } },
            },
          },
        },
      }),
      prisma.activityLog.count({ where }),
    ]);

    // Also return the list of users who have any activity on this account
    // (for the filter dropdown) — only fetched on first page to keep it cheap.
    let users = [];
    if (page === 1) {
      const userRows = await prisma.user.findMany({
        where:   { accountId: req.user.accountId, isActive: true },
        select:  { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      });
      users = userRows;
    }

    return res.json({
      success: true,
      data: {
        logs,
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
        actionLabels: ACTION_LABELS,
      },
    });
  } catch (err) {
    console.error('Activity log error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch activity log' });
  }
});

// ── GET /api/activity/distinct/:column ───────────────────────────────────────
//
// v0.70.1: powers the column-filter dropdowns on /activity-log. Supported
// columns: 'action', 'user'. Mirrors /api/alerts/distinct semantics:
//   • applies every sibling filter from req.query (Excel narrowing)
//   • returns up to 500 values
//   • returns { id, label } objects for 'user' (so the dropdown can show
//     names while sending the id back via userIdIn)
//   • returns plain strings for 'action'
//   • prepends __BLANK__ when null/empty rows exist in the narrowed set
router.get('/distinct/:column', requireManager, async (req, res) => {
  const VALID_COLUMNS = ['action', 'user'];
  const { column } = req.params;
  if (!VALID_COLUMNS.includes(column)) {
    return res.status(400).json({ error: 'invalid_column' });
  }

  try {
    const where = buildWhere(req, column);

    if (column === 'action') {
      const rows = await prisma.activityLog.groupBy({
        by: ['action'],
        where,
        _count: { _all: true },
      });
      const values = rows
        .map(r => r.action)
        .filter(a => a != null && a !== '')
        .sort()
        .slice(0, 500);
      return res.json({ values, labels: ACTION_LABELS });
    }

    if (column === 'user') {
      const rows = await prisma.activityLog.groupBy({
        by: ['userId'],
        where,
        _count: { _all: true },
      });
      const userIds = rows.map(r => r.userId).filter(Boolean);
      const blank = rows.some(r => !r.userId);
      const users = await prisma.user.findMany({
        where:  { id: { in: userIds }, accountId: req.user.accountId },
        select: { id: true, name: true, email: true },
        orderBy: { name: 'asc' },
      });
      // Build { id, label } pairs in the same order the dropdown will render.
      const items = users.map(u => ({ id: u.id, label: u.name || u.email || u.id }));
      const ids   = items.map(i => i.id).slice(0, 500);
      if (blank) ids.unshift(BLANK_SENTINEL);
      // Return values=[id...] + labels={[id]: name} so the client can render
      // names while filtering by id.
      const labels = Object.fromEntries(items.map(i => [i.id, i.label]));
      labels[BLANK_SENTINEL] = '(System / deleted user)';
      return res.json({ values: ids, labels });
    }

    return res.json({ values: [] });
  } catch (err) {
    console.error('[activity\\distinct] failed for column', column, ':', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /api/activity/export ─────────────────────────────────────────────────
// #35 Enterprise trust pack — SIEM-exportable audit log. The per-account
// hash chain (prevHash/rowHash) already exists; this packages it for ingestion
// by Splunk/ArcSight/etc. Admin-only (it's the security feed). Supports
// ?format=ndjson (default) | cef and the same dateFrom/dateTo/action filters as
// the list view. Rows are oldest-first so a SIEM appends in chain order; each
// row carries rowHash + prevHash so the SIEM stores tamper-evident events.
router.get('/export', requireAdmin, async (req, res) => {
  try {
    const format = String(req.query.format || 'ndjson').toLowerCase();
    if (!['ndjson', 'cef'].includes(format)) {
      return res.status(400).json({ success: false, error: "format must be 'ndjson' or 'cef'" });
    }
    const limit = Math.min(SIEM_EXPORT_MAX, Math.max(1, parseInt(req.query.limit || String(SIEM_EXPORT_MAX), 10) || SIEM_EXPORT_MAX));
    const where = buildWhere(req);

    const rows = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { user: { select: { id: true, email: true, role: true } } },
    });

    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'cef') {
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="servicecycle-audit-${stamp}.cef"`);
      res.set('X-Content-Type-Options', 'nosniff');
      const lines = rows.map((r: any) => {
        const sev  = CEF_SEVERITY[r.action] ?? 3;
        const name = ACTION_LABELS[r.action] || r.action;
        const ext  = [
          `rt=${new Date(r.createdAt).getTime()}`,
          r.user?.email ? `suser=${cefEscapeExt(r.user.email)}` : '',
          r.userId ? `suid=${cefEscapeExt(r.userId)}` : '',
          r.assetId ? `cs1Label=assetId cs1=${cefEscapeExt(r.assetId)}` : '',
          `cs2Label=rowHash cs2=${cefEscapeExt(r.rowHash || '')}`,
          `cs3Label=prevHash cs3=${cefEscapeExt(r.prevHash || '')}`,
          `externalId=${cefEscapeExt(r.id)}`,
        ].filter(Boolean).join(' ');
        return `CEF:0|ServiceCycle|ServiceCycle|1.0|${cefEscapeHeader(r.action)}|${cefEscapeHeader(name)}|${sev}|${ext}`;
      });
      return res.send(lines.join('\n') + (lines.length ? '\n' : ''));
    }

    // NDJSON (default) — one JSON event per line.
    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="servicecycle-audit-${stamp}.ndjson"`);
    res.set('X-Content-Type-Options', 'nosniff');
    const lines = rows.map((r: any) => JSON.stringify({
      id:          r.id,
      ts:          r.createdAt,
      action:      r.action,
      actorUserId: r.userId,
      actorEmail:  r.user?.email || null,
      actorRole:   r.user?.role || null,
      accountId:   r.accountId,
      assetId:     r.assetId,
      details:     r.details ?? null,
      prevHash:    r.prevHash || null,
      rowHash:     r.rowHash || null,
    }));
    return res.send(lines.join('\n') + (lines.length ? '\n' : ''));
  } catch (err) {
    console.error('Activity export error:', err);
    return res.status(500).json({ success: false, error: 'Failed to export activity log' });
  }
});

module.exports = router;

export {};
