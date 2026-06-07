/**
 * aiQuota.js  (L1, L14)
 *
 * Per-user, per-action, per-day AI quota.
 *
 * Used to cap Anthropic credit burn on shared demo instances. Default
 * behaviour on self-hosted is UNLIMITED — operators bring their own
 * AI_API_KEY, so credit spend is their concern.
 *
 * Action names are free-form strings so caller routes can pick a granularity.
 * Today's catalogue + per-action demo defaults:
 *   - 'ingest_extract'    — PDF/image extraction (test reports, nameplates) (demo cap: 3/day)
 *   - 'ask'               — in-product assistant (L14)                      (demo cap: 5/day)
 *   - 'maintenance_brief' — AI maintenance recommendation / NFPA compliance
 *                           summary (placeholder until the brief route lands)(demo cap: 2/day)
 *   - 'narrate'           — AI-narrated report summaries                    (demo cap: 2/day)
 *
 * Why Ask gets a larger cap than extract: Ask is conversational — visitors
 * naturally exchange 4-5 questions with an assistant before getting bored.
 * Extract is "demo this feature once" — a single PDF is enough to see how
 * AI extraction works. Cost protection on the larger Ask cap comes from
 * prompt caching on the AI Guide system prompt, which collapses Ask
 * per-call cost from ~$0.07 to ~$0.005 after the first call in a session.
 *
 * Day buckets are UTC ISO date strings (YYYY-MM-DD). All callers see the same
 * reset boundary regardless of where the server lives, which avoids the
 * "midnight in the operator's tz reset midnight in the user's tz" bug class.
 *
 * Cap-then-act semantics: increment fires BEFORE the AI call so two
 * concurrent requests cannot both read count=cap-1 and both pass. A request
 * that crashes mid-AI-call still counts against quota — accepted because the
 * alternative is a free-call vector via deliberate downstream failures.
 * If the increment pushes the count over the cap, we roll back the +1 and
 * return ok=false, so a hostile burst doesn't permanently pin the user above
 * the cap.
 */

import prisma from './prisma';

const UNLIMITED = Number.POSITIVE_INFINITY;

// Per-action demo defaults. Only consulted when DEMO_MODE=true and no
// explicit operator override is set. Lookup order in getDailyCap(action):
//   1. AI_DAILY_CAP_PER_USER_<ACTION_UPPER>   — per-action explicit override
//   2. AI_DAILY_CAP_PER_USER                  — uniform explicit override
//   3. DEMO_DEFAULT_CAPS[action]              — only when DEMO_MODE=true
//   4. UNLIMITED                              — self-host default
//
// 'ingest_extract' is the bucket for AI extraction from uploaded documents
// (contractor test reports, nameplate photos, legacy maintenance logs).
// routes/ingest calls checkAndIncrement with action='ingest_extract'.
//
// 'maintenance_brief' is the placeholder bucket for AI maintenance
// recommendation / compliance summary generation; the route wiring lands
// with the assets adaptation. Self-host is unlimited (UNLIMITED
// short-circuit in checkAndIncrement).
// 2026-05-17 (v0.32.4): demo AI provider switched from Anthropic Haiku to
// Google Gemini 2.0 Flash. Gemini Flash's free tier offers 1500 requests/
// day per API key at zero marginal cost, which lets us bump per-user
// caps to something closer to a "real product trial" without putting
// ForgeRift's bill at risk.
//
// Demo per-user, per-action, per-UTC-day caps:
//   - ingest_extract:    3 (one PDF + retry + alt format)
//   - ask:               5 (real Q&A turns, not a single shot)
//   - maintenance_brief: 2 (generate + regenerate to see output variance)
//
// Per-active-user worst case stays comfortably under aiBudgetGuard's
// global daily fuse since most visitors do not max every action.
//
// Global-day safety net: see aiBudgetGuard.js (v0.32.4) — a separate
// process-wide counter caps total Gemini calls per UTC day at
// GEMINI_DAILY_CALL_BUDGET (default 1300, leaving buffer under the
// 1500 free-tier ceiling). When the counter hits the budget, every
// subsequent AI endpoint returns 503 ai_demo_budget_exhausted with a
// "self-host to keep going" message — far better than rolling into
// paid Gemini overage charges by surprise.
//
// Self-host installs are UNLIMITED (DEMO_MODE !== 'true' short-circuit
// in getDailyCap). Operators bring their own AI provider key.
const DEMO_DEFAULT_CAPS = {
  ingest_extract:    3,
  ask:               5,
  maintenance_brief: 2,
  // v0.61.0: AI-narrated reports. Light per-call cost (~600 input +
  // 320 output tokens, ~30 CF Neurons each); the cap matches
  // maintenance_brief at 2/day because narrative regeneration is
  // conceptually adjacent to brief generation and should share the same
  // trust budget. Self-host stays UNLIMITED via the DEMO_MODE
  // short-circuit above.
  narrate:           2,
};

// v0.66.0 — per-role daily-total caps (sum across all actions for the user today).
//
// Built-in defaults (self-host; demo accounts all have role='admin' so this
// is functionally inert on demo unless an operator sets ai_cap_role_*):
//
//   admin       UNLIMITED   preserves the "operators have full control" promise
//   manager           100   generous, covers any real day-of-week use
//   consultant         50   mid-tier; consultants need AI but shouldn't be unbounded
//   viewer             20   limited; viewers shouldn't burn the operator's AI budget
//                           just exploring
//
// Resolution order (lowest wins between this per-role cap and the per-action
// cap from getDailyCap):
//   1. env override     AI_DAILY_CAP_PER_USER_ROLE_<ROLE>  (e.g. ..._MANAGER=200)
//   2. AccountSetting   ai_cap_role_<role>                  (UI-driven, per-account)
//   3. ROLE_DEFAULTS    built-in default                    (this map)
//   4. UNLIMITED        any unknown role
//
// The role cap is enforced as a SUM ACROSS ALL ACTIONS today. So a viewer
// with cap=20 can mix extract + ask + brief + narrate freely up to 20 total
// AI calls per UTC day, then is blocked across the board until midnight.
const ROLE_DEFAULTS = {
  admin:      UNLIMITED,
  manager:    100,
  consultant:  50,
  viewer:      20,
};

function getRoleDailyCap(role) {
  if (!role) return UNLIMITED;
  const r = String(role).toLowerCase();
  const envName = `AI_DAILY_CAP_PER_USER_ROLE_${r.toUpperCase()}`;
  const envCap = _parseEnvCap(process.env[envName]);
  if (envCap !== null) return envCap;
  if (ROLE_DEFAULTS[r] !== undefined) return ROLE_DEFAULTS[r];
  return UNLIMITED;
}

/**
 * getAccountRoleCapOverride(accountId, role) — async per-account, per-role
 * cap lookup. Same shape as getAccountCapOverride but on the role axis.
 * Reads AccountSetting key `ai_cap_role_<role>`.
 *
 * Returns null when no override is set (caller falls back to env/default).
 * Returns a numeric cap when set. Value '0' = block all; '-1' or '' = clear.
 */
async function getAccountRoleCapOverride(accountId, role) {
  if (!accountId || !role) return null;
  const r = String(role).toLowerCase();
  try {
    const row = await prisma.accountSetting.findUnique({
      where:  { accountId_key: { accountId, key: `ai_cap_role_${r}` } },
      select: { value: true },
    });
    if (!row) return null;
    const n = parseInt(row.value, 10);
    if (Number.isNaN(n) || n < 0) return null;
    return n;
  } catch {
    return null;  // fail-open
  }
}

/**
 * _sumUsageToday(userId) — total AI calls across all actions for this user today.
 * One extra query per AI call when the user has a finite role cap.
 */
async function _sumUsageToday(userId) {
  if (!userId) return 0;
  const day = todayUtc();
  const rows = await prisma.aiUsage.aggregate({
    _sum: { count: true },
    where: { userId, day },
  });
  return Number(rows?._sum?.count || 0);
}

function todayUtc() {
  // toISOString() always returns UTC; slice(0,10) → 'YYYY-MM-DD'.
  return new Date().toISOString().slice(0, 10);
}

function nextMidnightUtcIso() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0); // tomorrow 00:00:00 UTC
  return d.toISOString();
}

/**
 * Parse a numeric env var. Negative or non-numeric values resolve to
 * UNLIMITED rather than crashing the route — operators sometimes paste
 * 'inf' or '-1' meaning "no cap"; we honour the intent.
 */
function _parseEnvCap(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return UNLIMITED;
  return n;
}

/**
 * Resolve the daily cap for a given action (or globally if no action passed).
 *
 * Resolution order:
 *   1. AI_DAILY_CAP_PER_USER_<ACTION_UPPER>   — per-action explicit override
 *   2. AI_DAILY_CAP_PER_USER                  — uniform explicit override
 *      (back-compat; still honoured for operators who set it before L14)
 *   3. DEMO_DEFAULT_CAPS[action]              — only when DEMO_MODE=true
 *   4. UNLIMITED                              — self-host default
 *
 * Calling with no action (or an unknown one) skips step 1 and step 3 and
 * returns either AI_DAILY_CAP_PER_USER or UNLIMITED (so the legacy
 * `getDailyCap()` signature still returns a sensible global value for
 * backwards compatibility with any callers that don't pass action).
 */
function getDailyCap(action) {
  // 1. Per-action explicit override
  if (action) {
    const envName = `AI_DAILY_CAP_PER_USER_${action.toUpperCase()}`;
    const perActionCap = _parseEnvCap(process.env[envName]);
    if (perActionCap !== null) return perActionCap;
  }

  // 2. Uniform explicit override
  const uniformCap = _parseEnvCap(process.env.AI_DAILY_CAP_PER_USER);
  if (uniformCap !== null) return uniformCap;

  // 3. Demo default (per-action), or 4. unlimited self-host default
  if (process.env.DEMO_MODE === 'true') {
    if (action && DEMO_DEFAULT_CAPS[action] !== undefined) {
      return DEMO_DEFAULT_CAPS[action];
    }
    // Unknown action under DEMO_MODE — fall back to the most restrictive
    // catalogued cap. Safer than UNLIMITED on a shared key, tracks
    // tighter as new high-cost actions are enrolled.
    return Math.min(...Object.values(DEMO_DEFAULT_CAPS));
  }
  return UNLIMITED;
}

/**
 * getAccountCapOverride(accountId, action) — async per-account cap lookup.
 *
 * Checks AccountSetting for key `ai_cap_<action>`. Returns a numeric override
 * when one is set, or null when none is configured (caller falls back to
 * env-var / demo-default path via getDailyCap).
 *
 * Stored as AccountSetting keys, e.g.:
 *   ai_cap_ingest_extract, ai_cap_ask, ai_cap_maintenance_brief
 *
 * A value of "0" means "block all" (cap = 0). A value of "-1" or "" means
 * "remove override" — treated as null so the env-var/demo path takes over.
 */
async function getAccountCapOverride(accountId, action) {
  if (!accountId || !action) return null;
  try {
    const row = await prisma.accountSetting.findUnique({
      where:  { accountId_key: { accountId, key: `ai_cap_${action}` } },
      select: { value: true },
    });
    if (!row) return null;
    const n = parseInt(row.value, 10);
    if (Number.isNaN(n) || n < 0) return null;
    return n;
  } catch {
    return null;  // fail-open: DB error shouldn't break AI calls
  }
}

/**
 * checkAndIncrement(userId, action[, accountId]) — atomic increment + cap check.
 *
 * Returns:
 *   { ok: true,  count, cap, resetAt } — caller should proceed with the AI call
 *   { ok: false, count, cap, resetAt } — caller MUST return 402 to the client
 *
 * `resetAt` is a UTC ISO timestamp for the next reset (always tomorrow 00:00 UTC).
 * `count` is the user's current count for the day on success, or the cap on
 * failure (so the client can render "you've used N/N of your daily AI calls").
 *
 * accountId (optional) — when supplied, an AccountSetting override for the action
 * takes priority over env-var / demo-default caps. Pass req.user.accountId from routes.
 *
 * Throws on missing arguments — programmer error, surface loudly.
 */
async function checkAndIncrement(userId, action, accountId, userRole) {
  if (!userId) throw new Error('aiQuota.checkAndIncrement: userId is required');
  if (!action) throw new Error('aiQuota.checkAndIncrement: action is required');

  // Resolve per-action + per-role caps before opening a transaction
  // (these are read-only and may use other connections).
  const accountOverride = accountId ? await getAccountCapOverride(accountId, action) : null;
  const actionCap = accountOverride !== null ? accountOverride : getDailyCap(action);

  let roleCap = UNLIMITED;
  if (userRole) {
    const accountRoleOverride = accountId ? await getAccountRoleCapOverride(accountId, userRole) : null;
    roleCap = accountRoleOverride !== null ? accountRoleOverride : getRoleDailyCap(userRole);
  }

  const day     = todayUtc();
  const resetAt = nextMidnightUtcIso();

  // Both caps UNLIMITED: short-circuit the entire transaction. Saves a write
  // per AI call on self-hosted-default deployments.
  if (actionCap === UNLIMITED && roleCap === UNLIMITED) {
    return { ok: true, count: 0, cap: UNLIMITED, resetAt };
  }

  // H3 (audit High, 2026-05-22): wrap increment + cap checks in a
  // transaction with a per-user Postgres advisory lock so concurrent calls
  // for the same userId serialize. Without this serialization the pre-v0.67.2
  // role-cap check raced: two requests both sumUsageToday under cap, both
  // proceed to increment, both pass, cap violated. The advisory lock auto-
  // releases on transaction commit/rollback. Different users don't contend
  // (lock is keyed on hashtextextended(userId)).
  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;

    // Atomic upsert + read.
    const rows = await tx.$queryRaw`
      INSERT INTO ai_usage ("userId", "action", "day", "count")
      VALUES (${userId}, ${action}, ${day}, 1)
      ON CONFLICT ("userId", "action", "day")
      DO UPDATE SET "count" = ai_usage."count" + 1
      RETURNING "count"
    `;
    const count = Array.isArray(rows) && rows[0] ? Number(rows[0].count) : 1;

    // Per-action cap: rollback this increment if it pushed us over.
    if (actionCap !== UNLIMITED && count > actionCap) {
      await tx.$executeRaw`
        UPDATE ai_usage
        SET "count" = "count" - 1
        WHERE "userId" = ${userId} AND "action" = ${action} AND "day" = ${day}
      `;
      return { ok: false, count: actionCap, cap: actionCap, capReason: 'action', action, resetAt };
    }

    // Per-role total-day cap: sum AFTER the increment so the just-incremented
    // row is visible. Rollback if the new total exceeds the role cap.
    if (roleCap !== UNLIMITED) {
      const totalRow = await tx.$queryRaw`
        SELECT COALESCE(SUM("count"), 0)::int AS total
        FROM ai_usage
        WHERE "userId" = ${userId} AND "day" = ${day}
      `;
      const todayTotal = Array.isArray(totalRow) && totalRow[0] ? Number(totalRow[0].total) : 0;
      if (todayTotal > roleCap) {
        await tx.$executeRaw`
          UPDATE ai_usage
          SET "count" = "count" - 1
          WHERE "userId" = ${userId} AND "action" = ${action} AND "day" = ${day}
        `;
        return {
          ok: false,
          count: todayTotal - 1,
          cap: roleCap,
          capReason: 'role',
          role: userRole,
          resetAt,
        };
      }
    }

    return { ok: true, count, cap: actionCap !== UNLIMITED ? actionCap : roleCap, resetAt };
  });
}

/**
 * getUsage(userId, action[, accountId]) — inspect-only. Does NOT mutate.
 *
 * For routes that need to surface remaining quota in /me-style endpoints
 * without consuming a slot. Returns 0 when no row exists.
 * accountId (optional) — resolves per-account cap override same as checkAndIncrement.
 */
async function getUsage(userId, action, accountId) {
  const accountOverride = accountId ? await getAccountCapOverride(accountId, action) : null;
  const cap = accountOverride !== null ? accountOverride : getDailyCap(action);
  const day     = todayUtc();
  const resetAt = nextMidnightUtcIso();
  if (!userId) return { count: 0, cap, resetAt };
  const row = await prisma.aiUsage.findUnique({
    where:  { userId_action_day: { userId, action, day } },
    select: { count: true },
  });
  return { count: row?.count || 0, cap, resetAt };
}

/**
 * refundIncrement(userId, action) -- subtract 1 from today's count for the
 * given action. Idempotent at the floor (won't go below 0). Use ONLY when
 * a known-failure path consumed the slot and the user should not be penalized
 * for it (e.g. LLM provider returned 502, network timeout, OOM, etc.).
 *
 * v0.37.3 W6 followup MT-102. Keeps the cap-then-act concurrency safety
 * (still prevents burst races) while no-charging legitimate failures. The
 * "crashed mid-AI-call before reaching the catch" pathological case still
 * counts against quota -- accepted because we can't detect it from here.
 *
 * No-op on UNLIMITED quotas. Errors are swallowed -- a failed refund must
 * never cascade into the caller's error handler.
 */
async function refundIncrement(userId, action, accountId) {
  if (!userId || !action) return;
  try {
    // H3 (audit High, 2026-05-22): use the per-account cap-override resolution
    // before falling back to the env-var default. Without this, an admin who
    // tightened ai_cap_<action> from UNLIMITED to a finite number would see
    // refunds silently no-op'd (the env-var default still resolves to
    // UNLIMITED, the early-return fires).
    const accountOverride = accountId ? await getAccountCapOverride(accountId, action) : null;
    const cap = accountOverride !== null ? accountOverride : getDailyCap(action);
    if (cap === UNLIMITED) return;
    const day = todayUtc();
    await prisma.$executeRaw`
      UPDATE ai_usage
      SET "count" = GREATEST("count" - 1, 0)
      WHERE "userId" = ${userId} AND "action" = ${action} AND "day" = ${day}
    `;
  } catch (err) {
    console.warn('aiQuota.refundIncrement (non-fatal):', err && err.message ? err.message : err);
  }
}

module.exports = {
  getDailyCap,
  getAccountCapOverride,
  getRoleDailyCap,
  getAccountRoleCapOverride,
  checkAndIncrement,
  refundIncrement,
  getUsage,
  ROLE_DEFAULTS,
  UNLIMITED,
};

export {};
