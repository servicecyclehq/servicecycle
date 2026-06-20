'use strict';

/**
 * routes/admin.js
 * ---------------
 * Sprint 5 (A4): operator-only utility endpoints. Mounted at /api/admin.
 *
 * POST /api/admin/reset-demo
 *   Wipes the demo account and re-runs scripts/seed-demo.js. Requires:
 *     - authenticated user with role === 'admin'
 *     - DEMO_MODE === 'true' (returns 403 otherwise — this endpoint is a
 *       demo-only convenience, not a destructive trapdoor on a real instance)
 *
 *   The seed script is idempotent (pinned DEMO_ACCOUNT_ID) and the cron at
 *   03:30 calls the same code path. This endpoint is just a way to skip the
 *   wait when a demo session has been polluted (e.g. someone deleted half
 *   the assets before we shipped the demoWriteGuard).
 *
 *   The path is whitelisted in middleware/demoGuard.js — without that, the
 *   demoWriteGuard would 403 every POST under /api/admin/reset-demo's same
 *   destructive-action umbrella. The whitelist is path-based and cannot be
 *   spoofed by clients (the path comes from req.baseUrl + req.path, both
 *   server-side trusted values).
 */

const express = require('express');
import prisma from '../lib/prisma';
const { requireAdmin, requireSuperAdmin } = require('../middleware/roles');
const earlyAccessRouter = require('./earlyAccess');  // (L7)
const { getDailyCap, getAccountCapOverride, UNLIMITED } = require('../lib/aiQuota');

const router = express.Router();

// ── POST /api/admin/reset-demo ───────────────────────────────────────────────
router.post('/reset-demo', requireAdmin, async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({
      success: false,
      error:   'Demo reset is only available on instances with DEMO_MODE=true.',
    });
  }

  try {
    // Imported lazily so a non-demo deployment can drop the seed script
    // without breaking module load. The script is otherwise CLI-only on
    // production builds.
    const { resetAndSeedDemo } = require('../scripts/seed-demo');

    const summary = await resetAndSeedDemo({ trigger: 'manual' });

    // Update the singleton's demoLastResetAt so the SPA can show
    // "Last reset: 2 minutes ago" without parsing logs.
    try {
      await prisma.instanceConfig.update({
        where: { id: 'singleton' },
        data:  { demoLastResetAt: new Date() },
      });
    } catch (writeErr) {
      // Non-fatal — the reset itself succeeded. Operator visibility shows
      // up next on the cron's write of the same field.
      console.error('[admin/reset-demo] InstanceConfig write failed:', writeErr.message);
    }

    return res.json({
      success: true,
      data: {
        ...summary,
        triggeredBy: req.user.email,
        triggeredAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[admin/reset-demo] failed:', err);
    return res.status(500).json({ success: false, error: 'Demo reset failed.' });
  }
});

// ── #32 KPI instrumentation — the data-room dashboard ────────────────────────
// GET /api/admin/kpis  → the metrics an acquirer underwrites, scoped to the
// requesting admin's account. The underlying events (ExtractionEvent,
// TestMeasurement, ActivityLog, Deficiency) are now written continuously, so
// this endpoint just rolls them up — "capture them before they're gone."
//
//   assetsUnderManagement   active (non-archived) assets
//   readingsIngested        TestMeasurement rows
//   pdfsParsed              test-report extractions logged
//   pdfsCommitted           extractions that became program-of-record
//   fieldAccuracy           1 − (fields the human corrected ÷ fields committed)
//   wauByRole               distinct users active in the last 7 days, by role
//   timeToFirstFixListMs    account.createdAt → first Deficiency (onboarding speed)
//   scanExtractions         nameplate + photo-inspect scans logged
//
// Each metric is computed independently and failures degrade to null rather
// than 500-ing the whole dashboard.
router.get('/kpis', requireAdmin, async (req, res) => {
  const accountId = req.user.accountId;
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch (e: any) { console.error('[admin/kpis] metric failed:', e?.message || e); return fallback; }
  };
  try {
    const [
      assetsUnderManagement,
      readingsIngested,
      pdfsParsed,
      extractAgg,
      scanExtractions,
      activeRows,
      account,
      firstDef,
    ] = await Promise.all([
      safe(prisma.asset.count({ where: { accountId, archivedAt: null } }), 0),
      safe(prisma.testMeasurement.count({ where: { accountId, deletedAt: null } }), 0),
      safe(prisma.extractionEvent.count({ where: { accountId, kind: 'test_report' } }), 0),
      safe(prisma.extractionEvent.aggregate({
        where: { accountId, kind: 'test_report', committedAt: { not: null } },
        _sum: { fieldsCommitted: true, fieldsCorrected: true },
        _count: { _all: true },
      }) as any, null as any),
      safe(prisma.extractionEvent.count({ where: { accountId, kind: { in: ['nameplate', 'photo_inspect'] } } }), 0),
      safe(prisma.activityLog.findMany({
        where: { accountId, createdAt: { gte: since7d }, userId: { not: null } },
        select: { userId: true }, distinct: ['userId'],
      }), [] as any[]),
      safe(prisma.account.findUnique({ where: { id: accountId }, select: { createdAt: true } }), null as any),
      safe(prisma.deficiency.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }), null as any),
    ]);

    // WAU by role — resolve the distinct active user ids to their roles.
    const activeIds = (activeRows as any[]).map((r) => r.userId).filter(Boolean);
    const wauByRole: Record<string, number> = {};
    let wauTotal = 0;
    if (activeIds.length) {
      const users = await safe(
        prisma.user.findMany({ where: { id: { in: activeIds } }, select: { role: true } }),
        [] as any[],
      );
      for (const u of users as any[]) { wauByRole[u.role] = (wauByRole[u.role] || 0) + 1; wauTotal++; }
    }

    const committedFields = (extractAgg && extractAgg._sum && extractAgg._sum.fieldsCommitted) || 0;
    const correctedFields = (extractAgg && extractAgg._sum && extractAgg._sum.fieldsCorrected) || 0;
    const pdfsCommitted = (extractAgg && extractAgg._count && extractAgg._count._all) || 0;
    const fieldAccuracy = committedFields > 0
      ? Math.round((1 - correctedFields / committedFields) * 1000) / 1000
      : null;

    const timeToFirstFixListMs = (account && firstDef)
      ? Math.max(0, new Date(firstDef.createdAt).getTime() - new Date(account.createdAt).getTime())
      : null;

    return res.json({
      success: true,
      data: {
        scope: 'account',
        generatedAt: new Date().toISOString(),
        assetsUnderManagement,
        readingsIngested,
        pdfsParsed,
        pdfsCommitted,
        fieldAccuracy,           // null until at least one report is committed
        correctedFields,
        committedFields,
        scanExtractions,
        wauTotal,
        wauByRole,
        timeToFirstFixListMs,
      },
    });
  } catch (err: any) {
    console.error('[admin/kpis] failed:', err?.message || err);
    return res.status(500).json({ success: false, error: 'Failed to compute KPIs' });
  }
});

// ── L7: admin view of landing-page early-access submissions ──────────────────
// GET /api/admin/early-access/list  → JSON array of {id, name, email, ...}
// Mounted under requireAdmin so only admins can see lead data; the public
// POST /api/early-access (lead submission) is mounted separately in
// server/index.js with no auth.
//
// Tenant-isolation hardening (2026-05-10 review B1):
// On DEMO_MODE instances every freshly-registered sandbox user is
// auto-provisioned with role='admin' so they can poke at admin-tier
// features in their own per-visitor sandbox. That role check alone is
// NOT enough to gate lead data — early-access submissions originate
// from the marketing site and we never want them visible to sandbox
// visitors, even if the DB happens to be shared with the ops instance.
// Real ops admins see leads on the non-DEMO_MODE deployment.
function denyOnDemo(req, res, next) {
  if (process.env.DEMO_MODE === 'true') {
    return res.status(403).json({
      success: false,
      error:   'Early-access leads are not viewable from the demo sandbox.',
    });
  }
  next();
}
router.use('/early-access', requireAdmin, denyOnDemo, earlyAccessRouter);

// ── AI Daily Caps admin panel ─────────────────────────────────────────────────
//
// GET  /api/admin/ai-caps
//   Returns per-action cap data for the requesting admin's account:
//   { actions: [{ action, label, envCap, accountCap, effectiveCap, todayTotal, users }] }
//   - envCap: resolved from env vars / demo defaults (getDailyCap)
//   - accountCap: AccountSetting override, or null if none
//   - effectiveCap: accountCap ?? envCap
//   - todayTotal: sum of all users' counts today for this action
//   - users: [{ userId, name, count }] for non-zero users today
//
// PUT  /api/admin/ai-caps
//   Body: { caps: { extract?: N, ask?: N, brief?: N, brief_search?: N } }
//   N = null|'' removes the override; N >= 0 sets it; N = 0 blocks entirely.

const AI_CAP_ACTIONS = [
  { action: 'extract',      label: 'PDF & Nameplate Extraction (shared)' },
  { action: 'ask',          label: 'Ask ServiceCycle Assistant' },
  { action: 'brief',        label: 'Maintenance Brief Generation' },
  { action: 'brief_search', label: 'Brief Web-Search Enrichment (Tavily)' },
  { action: 'narrate',      label: 'AI Report Narration' },  // v0.68.0 (audit Medium)
];

router.get('/ai-caps', requireAdmin, async (req, res) => {
  const accountId = req.user.accountId;
  const today = new Date().toISOString().slice(0, 10);

  try {
    // Fetch today's usage rows for all users in this account in one query
    const allUsers = await prisma.user.findMany({
      where:  { accountId, isActive: true },
      select: { id: true, name: true, email: true },
    });
    const userIds = allUsers.map(u => u.id);
    const usageRows = userIds.length === 0 ? [] : await prisma.aiUsage.findMany({
      where:  { userId: { in: userIds }, day: today },
      select: { userId: true, action: true, count: true },
    });
    const usageByUserAction = new Map();
    for (const r of usageRows) {
      usageByUserAction.set(`${r.userId}:${r.action}`, r.count);
    }

    const actions = await Promise.all(AI_CAP_ACTIONS.map(async ({ action, label }) => {
      const envCap     = getDailyCap(action);
      const accountCap = await getAccountCapOverride(accountId, action);
      const effectiveCap = accountCap !== null ? accountCap : envCap;

      const users = allUsers
        .map(u => ({
          userId: u.id,
          name:   u.name,
          email:  u.email,
          count:  usageByUserAction.get(`${u.id}:${action}`) ?? 0,
        }))
        .filter(u => u.count > 0);

      const todayTotal = users.reduce((s, u) => s + u.count, 0);

      return {
        action,
        label,
        envCap:      envCap === UNLIMITED ? null : envCap,
        accountCap,
        effectiveCap: effectiveCap === UNLIMITED ? null : effectiveCap,
        todayTotal,
        users,
      };
    }));

    return res.json({ success: true, data: { actions } });
  } catch (err) {
    console.error('[admin/ai-caps GET] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to load AI cap data' });
  }
});

router.put('/ai-caps', requireAdmin, async (req, res) => {
  const accountId = req.user.accountId;
  const { caps } = req.body || {};
  if (!caps || typeof caps !== 'object') {
    return res.status(400).json({ success: false, error: 'caps object required' });
  }

  const validActions = AI_CAP_ACTIONS.map(a => a.action);
  const ops = [];

  for (const [action, rawVal] of Object.entries<any>(caps)) {
    if (!validActions.includes(action)) continue;
    const key = `ai_cap_${action}`;

    // null / '' / negative = remove the override
    if (rawVal === null || rawVal === '' || rawVal === undefined) {
      ops.push(prisma.accountSetting.deleteMany({ where: { accountId, key } }));
    } else {
      const n = parseInt(rawVal, 10);
      if (Number.isNaN(n) || n < 0) continue;  // ignore invalid
      ops.push(prisma.accountSetting.upsert({
        where:  { accountId_key: { accountId, key } },
        create: { accountId, key, value: String(n) },
        update: { value: String(n) },
      }));
    }
  }

  try {
    await Promise.all(ops);
    return res.json({ success: true });
  } catch (err) {
    console.error('[admin/ai-caps PUT] failed:', err);
    return res.status(500).json({ success: false, error: 'Failed to save AI cap overrides' });
  }
});


// ── GET /api/admin/notification-log ─────────────────────────────────────────
// S5-FN-07 (v0.75.x): Returns the most recent alert notification send records
// for this account. Operators use this to confirm "did asset X maintenance
// alert actually fire and reach the recipient?" without parsing server logs.
//
// Query params:
//   ?limit=N       (default 100, max 500)
//   ?assetId=      (filter to one asset)
//   ?channel=      (email|slack|teams|webhook)
//   ?status=       (sent|failed|skipped)
router.get('/notification-log', requireAdmin, async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const where: any = { accountId };
    if (req.query.assetId)  where.assetId = req.query.assetId;
    if (req.query.channel)  where.channel = req.query.channel;
    if (req.query.status)   where.status  = req.query.status;

    const rows = await prisma.notificationLog.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      take: limit,
      // NotificationLog.assetId is a bare column (no relation) — the asset
      // may be deleted after the send, and the log row must survive that.
      select: {
        id: true, channel: true, template: true, recipient: true,
        providerMessageId: true, status: true, errorMessage: true,
        alertCount: true, sentAt: true, assetId: true, userId: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
    res.json({ success: true, data: { rows, count: rows.length } });
  } catch (err) {
    console.error('[admin] notification-log error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch notification log' });
  }
});

// GET /api/admin/metrics/overview
// Audit 3.2.6 + 6.3.3 + 6.4.1 + 6.4.2 - the business metrics dashboard the
// post-launch monitoring cluster needed. One round-trip, five groups:
//   1. totals: users / accounts / assets (active + archived)
//   2. signups_by_day  (last 30 days)
//   3. assets_by_day   (last 30 days)
//   4. dau_by_day      (last 7 days - distinct login_success users)
//   5. retention       (one cohort, registered 8-15 days ago,
//                       pct with any login on day 1 / day 3 / day 7)
//   6. top_actions_7d  (activity_log groupBy action, top 15)
//
// All queries are bounded by date filters to keep them index-friendly.
// Per-day buckets use date_trunc 'day' so the values are stable across
// timezones (server runs UTC).
//
// SECURITY (F1): every query here is PLATFORM-WIDE (no accountId) — total
// users/accounts/assets, signups, DAU, retention, top actions across ALL
// tenants. That is operator BI, not tenant data, so it is gated to super_admin
// (was requireAdmin, which exposed it to every customer admin — and, since the
// demo auto-grants admin, to anonymous demo visitors).
router.get('/metrics/overview', requireSuperAdmin, async (req, res) => {
  try {
    const [totalUsers, totalAccounts, totalActive, totalArchived] = await Promise.all([
      prisma.user.count(),
      prisma.account.count(),
      prisma.asset.count({ where: { archivedAt: null } }),
      prisma.asset.count({ where: { archivedAt: { not: null } } }),
    ]);

    // L1 (2026-06-09 audit): tagged-template $queryRaw instead of
    // $queryRawUnsafe. These queries are 100% static (no interpolation) and
    // admin-only, so there was never an injection path — but the tagged form
    // keeps Prisma's parameterization safety net in place so a future edit
    // that drops a variable in here can't silently become injectable.
    const signupsByDayRows = await prisma.$queryRaw<any[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS count
       FROM users
       WHERE "createdAt" >= NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY 1`;

    const assetsByDayRows = await prisma.$queryRaw<any[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS count
       FROM assets
       WHERE "createdAt" >= NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY 1`;

    const dauByDayRows = await prisma.$queryRaw<any[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT "userId")::int AS count
       FROM activity_logs
       WHERE action = 'login_success'
         AND "createdAt" >= NOW() - INTERVAL '7 days'
         AND "userId" IS NOT NULL
       GROUP BY 1 ORDER BY 1`;

    const retentionRows = await prisma.$queryRaw<any[]>`
      WITH cohort AS (
         SELECT id, "createdAt" FROM users
         WHERE "createdAt" >= NOW() - INTERVAL '15 days'
           AND "createdAt" <  NOW() - INTERVAL '8 days'
       )
       SELECT
         (SELECT COUNT(*) FROM cohort)::int AS cohort_size,
         (SELECT COUNT(DISTINCT c.id) FROM cohort c
           JOIN activity_logs l ON l."userId" = c.id
                               AND l.action = 'login_success'
                               AND l."createdAt" >= c."createdAt" + INTERVAL '1 day')::int AS d1,
         (SELECT COUNT(DISTINCT c.id) FROM cohort c
           JOIN activity_logs l ON l."userId" = c.id
                               AND l.action = 'login_success'
                               AND l."createdAt" >= c."createdAt" + INTERVAL '3 days')::int AS d3,
         (SELECT COUNT(DISTINCT c.id) FROM cohort c
           JOIN activity_logs l ON l."userId" = c.id
                               AND l.action = 'login_success'
                               AND l."createdAt" >= c."createdAt" + INTERVAL '7 days')::int AS d7`;
    const ret = retentionRows?.[0] ?? { cohort_size: 0, d1: 0, d3: 0, d7: 0 };
    const cohortSize = Number(ret.cohort_size || 0);
    const pct = (n) => (cohortSize > 0 ? Math.round((Number(n) / cohortSize) * 1000) / 10 : 0);

    const topActionsRows = await prisma.$queryRaw<any[]>`
      SELECT action, COUNT(*)::int AS count
       FROM activity_logs
       WHERE "createdAt" >= NOW() - INTERVAL '7 days'
       GROUP BY action
       ORDER BY count DESC
       LIMIT 15`;

    return res.json({
      success: true,
      data: {
        sampledAt: new Date().toISOString(),
        totals: {
          users: totalUsers,
          accounts: totalAccounts,
          assetsActive: totalActive,
          assetsArchived: totalArchived,
        },
        signupsByDay: ((signupsByDayRows as any[]) || []).map(r => ({ day: r.day, count: Number(r.count) })),
        assetsByDay:  ((assetsByDayRows as any[]) || []).map(r => ({ day: r.day, count: Number(r.count) })),
        dauByDay:       ((dauByDayRows as any[]) || []).map(r => ({ day: r.day, count: Number(r.count) })),
        retention: {
          cohortWindow: 'registered 8-15 days ago',
          cohortSize,
          d1: { count: Number(ret.d1 || 0), pct: pct(ret.d1) },
          d3: { count: Number(ret.d3 || 0), pct: pct(ret.d3) },
          d7: { count: Number(ret.d7 || 0), pct: pct(ret.d7) },
        },
        topActions7d: ((topActionsRows as any[]) || []).map(r => ({ action: r.action, count: Number(r.count) })),
      },
    });
  } catch (err) {
    console.error('[admin] metrics/overview error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to compute metrics' });
  }
});
// ── GET /api/admin/db-pool-health ─────────────────────────────────────────────
// Audit 3.2.4 — DB connection pool metrics. Exposes pg_stat_activity counts
// so operators can spot pool exhaustion before it cascades into 5xxs.
// Cheap to call (single query against the pg system view); admin-only so
// the counts aren't enumerable by tenants. Sample output:
//   { success: true, data: { total: 4, active: 1, idle: 3, idleInTx: 0, max: 100, utilizationPct: 4 } }
// SECURITY (2026-06-20 audit): operator-only infra data (platform-wide
// pg_stat_activity), with no client UI dependency — gated to super_admin so a
// customer admin (or, on a demo box, an auto-provisioned sandbox admin) cannot
// enumerate the platform's DB pool state. (The sibling /metrics/overview leaks
// platform-wide BI but backs a customer-facing page; it is flagged separately
// for a coordinated server+client gating change.)
router.get('/db-pool-health', requireSuperAdmin, async (req, res) => {
  try {
    // datname filter scopes to the servicecycle database; postgres role excluded
    // so internal autovacuum / replication connections don't inflate the count.
    const rows = await prisma.$queryRaw<any[]>`
      SELECT
        COUNT(*) FILTER (WHERE state = 'active')                            AS active,
        COUNT(*) FILTER (WHERE state = 'idle')                              AS idle,
        COUNT(*) FILTER (WHERE state = 'idle in transaction')               AS idle_in_tx,
        COUNT(*) FILTER (WHERE wait_event_type = 'Lock')                    AS waiting_on_lock,
        COUNT(*)                                                            AS total
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename <> 'postgres'
    `;
    const maxRows = await prisma.$queryRaw<any[]>`SHOW max_connections`;
    const max = parseInt(maxRows?.[0]?.max_connections ?? '0', 10) || 0;
    const r = rows?.[0] ?? {};
    // Cast bigints (Postgres COUNT) to JS numbers; safe for connection-count ranges.
    const total       = Number(r.total       ?? 0);
    const active      = Number(r.active      ?? 0);
    const idle        = Number(r.idle        ?? 0);
    const idleInTx    = Number(r.idle_in_tx  ?? 0);
    const waitingOnLock = Number(r.waiting_on_lock ?? 0);
    return res.json({
      success: true,
      data: {
        total,
        active,
        idle,
        idleInTx,
        waitingOnLock,
        max,
        utilizationPct: max > 0 ? Math.round((total / max) * 1000) / 10 : null,
        sampleAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[admin] db-pool-health error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to query pg_stat_activity' });
  }
});

module.exports = router;

export {};
