/**
 * Tier enforcement middleware (Sprint 6 prep).
 *
 * Usage:
 *   const { requireTier } = require('../middleware/requireTier');
 *   router.post('/some-premium-feature', requireTier('mid'), handler);
 *
 * Behaviour:
 *   - When STRIPE_ENABLED=false (self-hosted licensed instances), this is a
 *     no-op — the licensed install paid for the whole product.
 *   - When STRIPE_ENABLED=true and the account's planType is 'licensed',
 *     same: a licensed customer doesn't get downgraded by the SaaS billing
 *     gate.
 *   - When STRIPE_ENABLED=true AND planType='saas', checks the account's
 *     planTier against the minimum required by the route. If insufficient,
 *     returns 402 Payment Required with a `requiredTier` hint so the SPA
 *     can route the user to a plan-upgrade UI.
 *   - When the subscription is past-due or canceled, returns 402 even if the
 *     planTier itself is sufficient — the customer needs to update payment
 *     in the Stripe Customer Portal.
 *
 * Tier rank (higher = more privileged): small < mid < enterprise.
 */

const { isStripeEnabled } = require('../lib/stripe');
import prisma from '../lib/prisma';

const TIER_RANK = Object.freeze({
  small:      1,
  mid:        2,
  enterprise: 3,
});

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// S5-FN-03 (v0.74.1): write a non-fatal ActivityLog row every time the tier
// gate blocks a request so operators can see gate hits in the audit trail.
// Failures are swallowed — audit writes must never break the gated request.
async function _logTierBlock({ req, reason, requiredTier, userTier }) {
  try {
    await prisma.activityLog.create({
      data: {
        userId:    req.user?.id    || null,
        accountId: req.user?.accountId || null,
        action:    'tier_gate_blocked',
        details: {
          reason,
          requiredTier,
          userTier: userTier ?? null,
          route:    req.originalUrl || req.path || null,
          method:   req.method || null,
        },
      },
    });
  } catch (_) { /* non-fatal */ }
}

function requireTier(minTier) {
  if (!TIER_RANK[minTier]) {
    throw new Error(`requireTier: unknown tier "${minTier}". Valid: small | mid | enterprise.`);
  }

  return async function tierGuard(req, res, next) {
    // No Stripe configured → self-hosted; nothing to enforce.
    if (!isStripeEnabled()) return next();

    if (!req.user?.accountId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // Auth middleware (server/middleware/auth.js) only attaches a flat
    // user object — no nested account relation — so this middleware
    // fetches the billing-relevant columns on demand. The cost (one
    // indexed lookup per gated request) is paid only on routes that
    // actually opt in via requireTier(...).
    let account;
    try {
      account = await prisma.account.findUnique({
        where: { id: req.user.accountId },
        select: {
          planType:                 true,
          planTier:                 true,
          stripeSubscriptionStatus: true,
        },
      });
    } catch (err) {
      console.error('requireTier: account lookup failed:', err);
      return res.status(500).json({ success: false, error: 'Tier check failed' });
    }
    if (!account) {
      return res.status(401).json({ success: false, error: 'Account not found' });
    }

    // Licensed instances bought the whole product — never gate features.
    if (account.planType === 'licensed') return next();

    // SaaS path: subscription must be active or trialing.
    const status = account.stripeSubscriptionStatus;
    if (status && !ACTIVE_STATUSES.has(status)) {
      _logTierBlock({ req, reason: 'subscription_inactive', requiredTier: minTier, userTier: account.planTier });
      return res.status(402).json({
        success: false,
        error: `Subscription is ${status}. Update payment in the Stripe Customer Portal to continue.`,
        subscriptionStatus: status,
      });
    }

    // Tier rank check. A nullable planTier is treated as below 'small'.
    const have = TIER_RANK[account.planTier] ?? 0;
    const need = TIER_RANK[minTier];
    if (have < need) {
      _logTierBlock({ req, reason: 'insufficient_tier', requiredTier: minTier, userTier: account.planTier });
      return res.status(402).json({
        success: false,
        error: `This feature requires the ${minTier} plan or higher. Current: ${account.planTier || 'no plan'}.`,
        currentTier:  account.planTier || null,
        requiredTier: minTier,
      });
    }

    return next();
  };
}

module.exports = { requireTier, TIER_RANK };

export {};
