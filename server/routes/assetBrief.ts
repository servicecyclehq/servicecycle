/**
 * routes/assetBrief.ts — POST /api/assets/:id/brief
 *
 * AI maintenance brief for one asset: structured maintenance
 * recommendation + NFPA 70B compliance summary. Replaces the inherited
 * product's per-contract renewal brief; the gating ARCHITECTURE is copied
 * from that route, the contract content is not.
 *
 * Gate order (per the legacy brief route, adapted):
 *   1. AI_ENABLED kill-switch            → 503 ai_disabled
 *   2. GPC opt-out (Sec-GPC: 1)          → 403 GPC_AI_BLOCKED
 *   3. per-user burst limiter (30/hr)    → 429 (express-rate-limit message)
 *   4. asset ownership (accountId!)      → 404
 *   5. account.aiBriefEnabled toggle     → 403 ai_brief_disabled_for_account
 *   6. AI consent (lib/aiConsent)        → 403 ai_consent_required | ai_consent_outdated
 *   7. aiQuota 'maintenance_brief'       → 429 ai_daily_cap_reached  (cap-then-act;
 *                                          slot refunded on any downstream failure)
 *   8. demo budget guard (lib/aiBudgetGuard.ensureAiBudget)
 *                                        → 503 ai_demo_*_budget_exhausted
 *                                          (quota slot refunded — no AI call happened)
 *   9. build context → LLM call → validate → respond
 *      catch: refund quota slot, 500
 *
 * NO CACHING in v1 — the Asset model has no brief columns; every POST is a
 * fresh generation. See the future-cache-table note in lib/maintenanceBrief.
 *
 * Auth: authenticateToken is applied at the mount point in index.ts (NOT
 * mounted yet — see the mount line in the integration notes). aiIpLimiter
 * (per-IP, account-rotation defense) is stacked per-route below, matching
 * the legacy pattern, so the mount line stays a plain two-arg app.use and
 * asset CRUD traffic never burns the AI IP budget.
 *
 * TENANCY: the asset lookup AND buildBriefContext both filter by
 * req.user.accountId.
 */

'use strict';

const router    = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z }     = require('zod');

const { ensureAiConsent }  = require('../lib/aiConsent');
const { ensureAiBudget }   = require('../lib/aiBudgetGuard');
const { checkAndIncrement: checkAiQuota, refundIncrement: refundAiQuota } = require('../lib/aiQuota');
const { aiIpLimiter }      = require('../middleware/aiIpLimit');
const { buildBriefContext, generateMaintenanceBrief } = require('../lib/maintenanceBrief');
import prisma from '../lib/prisma';

// ─── Per-user burst limiter ───────────────────────────────────────────────────
// 30 briefs/hour/user — same shape as the legacy briefLimiter. The daily
// aiQuota cap is the real cost gate (2/day on demo); this stops a stuck
// client (or a hostile script on self-host, where quota is UNLIMITED) from
// racking up provider calls inside a single hour.
const briefLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `maintenance_brief:${req.user?.id || 'anon'}`,
  message: { success: false, error: 'Too many AI brief requests — try again in an hour.' },
});

const UuidParam = z.string().uuid();

// ─── Activity logging helper ──────────────────────────────────────────────────
// Fire-and-forget, mirrors routes/assets.ts — a logging failure never
// blocks the response.
async function logActivity(assetId, userId, accountId, action, details = null) {
  try {
    await prisma.activityLog.create({
      data: { assetId, userId, accountId: accountId ?? null, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

// ─── POST /:id/brief ──────────────────────────────────────────────────────────

router.post('/:id/brief', aiIpLimiter, briefLimiter, async (req, res) => {
  // 1. Instance-level AI kill-switch.
  if (process.env.AI_ENABLED === 'false') {
    return res.status(503).json({
      success: false,
      error:   'ai_disabled',
      message: 'AI features are disabled on this instance.',
    });
  }

  // 2. Global Privacy Control opt-out blocks AI processing (house rule —
  //    every AI endpoint honors Sec-GPC: 1).
  if (req.gpc) {
    return res.status(403).json({
      success: false,
      error:   'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.',
      code:    'GPC_AI_BLOCKED',
    });
  }

  const idCheck = UuidParam.safeParse(req.params.id);
  if (!idCheck.success) {
    return res.status(400).json({ success: false, error: 'Invalid asset id' });
  }
  const assetId   = idCheck.data;
  const userId    = req.user.id;
  const accountId = req.user.accountId;

  let quotaCharged = false;
  try {
    // 4. Ownership — accountId filter is the tenancy boundary. Also pull
    //    the per-account brief toggle in the same round-trip.
    const asset = await prisma.asset.findFirst({
      where:  { id: assetId, accountId },
      select: {
        id: true,
        archivedAt: true,
        account: { select: { aiBriefEnabled: true } },
      },
    });
    if (!asset) {
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    // 5. Per-account feature toggle (Account.aiBriefEnabled, default OFF on
    //    self-host; demo seed flips it on). Server-side enforcement — does
    //    not depend on the UI hiding the button.
    if (!asset.account?.aiBriefEnabled) {
      return res.status(403).json({
        success: false,
        error:   'ai_brief_disabled_for_account',
        message: 'AI maintenance brief is disabled for this account. An admin can enable it in Settings.',
      });
    }

    // Archived assets keep their history but don't need fresh briefs;
    // reject before any AI cost is incurred.
    if (asset.archivedAt) {
      return res.status(409).json({
        success: false,
        error:   'brief_not_applicable_archived_asset',
        message: 'A maintenance brief is only available for active (non-archived) assets.',
      });
    }

    // 6. Per-user AI consent. ensureAiConsent sends the 403 itself with
    //    error 'ai_consent_required' (first ever AI call) or
    //    'ai_consent_outdated' (consent text / provider drift) — the
    //    client consent modal keys off those exact strings.
    if (!(await ensureAiConsent(req, res))) return;

    // 7. Daily per-user quota — 'maintenance_brief' action (demo cap 2/day,
    //    UNLIMITED self-host). Cap-then-act: the slot is consumed BEFORE
    //    the AI call so concurrent requests can't both squeeze under the
    //    cap; every downstream failure path refunds it.
    const quota = await checkAiQuota(userId, 'maintenance_brief', accountId, req.user.role);
    if (!quota.ok) {
      return res.status(429).json({
        success: false,
        error:   'ai_daily_cap_reached',
        message: `You've used ${quota.count}/${quota.cap} of your daily AI maintenance briefs. Resets at midnight UTC.`,
        data:    { count: quota.count, cap: quota.cap, capReason: quota.capReason || 'action', resetAt: quota.resetAt },
      });
    }
    quotaCharged = true;

    // 8. Demo budget guard (global monthly $/daily-call fuse). ensureAiBudget
    //    sends its own 503 (ai_demo_monthly_budget_exhausted / ai_demo_budget_
    //    exhausted) when tripped. No-op on self-host. The quota slot is
    //    refunded — the user got nothing for it.
    if (!ensureAiBudget(req, res)) {
      await refundAiQuota(userId, 'maintenance_brief', accountId);
      return;
    }

    // 9. Build context + generate.
    const context = await buildBriefContext(prisma, accountId, assetId);
    if (!context) {
      // Asset vanished between the ownership check and here (concurrent
      // delete) — treat as not-found, refund the slot.
      await refundAiQuota(userId, 'maintenance_brief', accountId);
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    if (context._meta?.sanitizerRedactions > 0) {
      // High redaction volume on embedded free text is the indirect
      // prompt-injection tell — log it for triage, don't block.
      console.warn(`[assetBrief] sanitizer redacted ${context._meta.sanitizerRedactions} injection marker(s) for asset=${assetId} account=${accountId}`);
    }

    const brief = await generateMaintenanceBrief(context);

    void logActivity(assetId, userId, accountId, 'maintenance_brief_generated', {
      model: brief.model,
      actions: brief.sections.recommendedActions.length,
    });

    return res.json({ success: true, data: { brief } });
  } catch (err) {
    console.error('Maintenance brief generation error:', err);
    // Refund-on-failure (legacy MT-102 pattern): the user should not be
    // penalized for a provider 5xx / timeout / unparseable response.
    // refundIncrement swallows its own errors and floors at 0.
    if (quotaCharged) {
      void refundAiQuota(userId, 'maintenance_brief', accountId);
    }
    return res.status(500).json({ success: false, error: 'Failed to generate maintenance brief' });
  }
});

module.exports = router;

export {};
