/**
 * routes/aiUsage.js (v0.32.4)
 *
 * GET /api/ai/usage/me — returns the current user's per-action daily AI
 * quota state so the SPA can render "X of Y daily calls remaining"
 * helper text under each AI input box.
 *
 * Separate from /api/ingest/usage (which returns the account-level
 * freemium ingest count); this one is the PER-USER, PER-ACTION daily
 * cap state and is read on page load by the demo client to surface
 * the disclosure inline.
 *
 * Authenticated route. No-op cheap on self-host (counts are 0/INF
 * because the quota system short-circuits UNLIMITED in DEMO_MODE !==
 * 'true').
 */

'use strict';

const express = require('express');
const aiQuota = require('../lib/aiQuota');
const { peek: peekAiBudget } = require('../lib/aiBudgetGuard');

const router = express.Router();

const ACTIONS = ['ingest_extract', 'ask', 'maintenance_brief', 'narrate'];

router.get('/me', async (req, res) => {
  try {
    const userId    = req.user.id;
    const accountId = req.user.accountId;

    // Per-user, per-action usage. Read-only — does NOT mutate.
    const perAction: any = {};
    for (const action of ACTIONS) {
      // eslint-disable-next-line no-await-in-loop
      const u = await aiQuota.getUsage(userId, action, accountId);
      perAction[action] = {
        count:     u.count,
        cap:       Number.isFinite(u.cap) ? u.cap : null, // serialise Infinity as null for JSON
        remaining: Number.isFinite(u.cap) ? Math.max(0, u.cap - u.count) : null,
        resetAt:   u.resetAt,
      };
    }

    // Global-day budget posture so the SPA can render a "shared demo AI
    // budget is exhausted, come back tomorrow or self-host" empty state
    // proactively rather than waiting for a 503.
    const budget = peekAiBudget();

    return res.json({
      success: true,
      data: {
        demoMode: process.env.DEMO_MODE === 'true',
        actions:  perAction,
        budget: {
          callsToday: budget.callsToday,
          budget:     Number.isFinite(budget.budget) ? budget.budget : null,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/ai/usage/me error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load AI usage' });
  }
});

module.exports = router;

export {};
