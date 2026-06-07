/**
 * Stripe billing seam (Sprint 6 prep).
 *
 * Self-hosted licensed instances bypass Stripe entirely (planType=licensed).
 * SaaS-managed instances enable it via STRIPE_ENABLED=true. This module is the
 * shared surface both code paths import — when disabled, every helper is a
 * cheap no-op that returns the values the rest of the app expects so feature
 * code does not need to branch on env state.
 *
 * What's done in this seam:
 *   - isStripeEnabled() — feature flag check
 *   - getStripe() — lazy client (only required when enabled, so the npm dep
 *     stays optional for self-hosted operators)
 *   - getOrCreateCustomer(account) — idempotent customer-by-account lookup
 *   - PRICE_IDS — env-loaded mapping for the three plan tiers
 *
 * What's NOT done — fill in when the first paying customer signal arrives:
 *   - Checkout session creation (POST /api/billing/checkout)
 *   - Customer Portal session creation (POST /api/billing/portal)
 *   - Webhook handler at POST /api/billing/webhook (subscription.updated,
 *     customer.subscription.deleted, invoice.payment_failed, etc.)
 *   - Plan-change UI in the SPA (Settings → Billing tab)
 *   - Grace logic when stripeSubscriptionStatus flips to past_due
 *
 * See docs/stripe-integration.md for a checklist of remaining work.
 */

let _stripeClient = null;

function isStripeEnabled() {
  return process.env.STRIPE_ENABLED === 'true' && !!process.env.STRIPE_SECRET_KEY;
}

// Surface a misconfigured deploy at boot time. STRIPE_ENABLED=true with
// a missing STRIPE_SECRET_KEY silently disables billing — for a SaaS
// instance that's a revenue leak (Checkout / Portal / webhook all
// silently fail). Run once at module load instead of per-call so the
// signal lands in the boot logs.
if (process.env.STRIPE_ENABLED === 'true' && !process.env.STRIPE_SECRET_KEY) {
  console.warn(
    '[stripe] STRIPE_ENABLED=true but STRIPE_SECRET_KEY is unset. ' +
    'Billing is silently disabled — set STRIPE_SECRET_KEY or unset STRIPE_ENABLED. ' +
    'See docs/stripe-integration.md.'
  );
}

/**
 * Lazy-load the Stripe client. Throws if called when STRIPE_ENABLED=false so
 * callers can't accidentally hit the API in self-hosted mode. The `stripe`
 * npm dep is already listed in server/package.json (v22.x) and is loaded
 * here on first use to keep cold-boot lightweight on self-hosted instances
 * that never touch billing.
 */
function getStripe() {
  if (!isStripeEnabled()) {
    throw new Error('Stripe is disabled. Set STRIPE_ENABLED=true and STRIPE_SECRET_KEY before calling getStripe().');
  }
  if (_stripeClient) return _stripeClient;

  let StripeCtor;
  try {
    // eslint-disable-next-line global-require
    StripeCtor = require('stripe');
  } catch (err) {
    // Should not happen — `stripe` is a regular dep — but if a fork ever
    // strips it, fail loudly rather than fall through silently.
    throw new Error(
      'Stripe module failed to load. Run `npm install` in server/ to restore. ' +
      'See docs/stripe-integration.md. Underlying: ' + (err?.message || err)
    );
  }
  _stripeClient = new StripeCtor(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia',
    appInfo: { name: 'LapseIQ', version: 'sprint-6-prep' },
    typescript: false,
  });
  return _stripeClient;
}

/**
 * Map of PlanTier enum value → Stripe price ID. Used by Checkout session
 * creation in the future. Returns the env-configured value or null when a
 * tier is intentionally not offered.
 */
const PRICE_IDS = Object.freeze({
  small:      process.env.STRIPE_PRICE_ID_SMALL      || null,
  mid:        process.env.STRIPE_PRICE_ID_MID        || null,
  enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE || null,
});

function priceIdForTier(tier) {
  return PRICE_IDS[tier] ?? null;
}

/**
 * Idempotent: return the existing stripeCustomerId on the account, or create
 * a new Stripe customer and persist its id. The account row update happens
 * inside the caller's transaction context if one is passed.
 *
 * Throws when STRIPE_ENABLED=false — callers are expected to gate on
 * isStripeEnabled() upstream rather than receive a stub id.
 */
/**
 * Verify and parse a Stripe webhook payload. Throws when the signature is
 * missing, malformed, or doesn't match. The integration session MUST call
 * this — never inspect the raw body directly.
 *
 * Critical preconditions:
 *   - The webhook route must mount BEFORE the global express.json() so the
 *     request body is the raw bytes, not a parsed object. Use
 *       app.post('/api/billing/webhook',
 *         express.raw({ type: 'application/json' }),
 *         handler);
 *     The handler then receives `req.body` as a Buffer.
 *   - Pass `req.body` (Buffer) directly here — do NOT JSON.stringify it.
 *
 * Returns the verified event. Caller is responsible for handling the type
 * (e.g. `customer.subscription.updated`) and updating the Account row.
 */
function verifyWebhook(rawBody, signatureHeader) {
  if (!isStripeEnabled()) {
    throw new Error('verifyWebhook requires STRIPE_ENABLED=true');
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  if (!signatureHeader) {
    throw new Error('Missing Stripe-Signature header');
  }
  const stripe = getStripe();
  // constructEvent throws if the signature doesn't match. Don't catch here —
  // the caller should respond 400 on any error so Stripe will retry.
  return stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

async function getOrCreateCustomer(account, prismaClient /* required */) {
  if (!isStripeEnabled()) {
    throw new Error('getOrCreateCustomer requires STRIPE_ENABLED=true');
  }
  if (!account?.id) throw new Error('getOrCreateCustomer requires a persisted Account');
  if (account.stripeCustomerId) return account.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    name: account.companyName,
    metadata: { lapseiq_account_id: account.id },
  });
  await prismaClient.account.update({
    where: { id: account.id },
    data:  { stripeCustomerId: customer.id },
  });
  return customer.id;
}

module.exports = {
  isStripeEnabled,
  getStripe,
  PRICE_IDS,
  priceIdForTier,
  getOrCreateCustomer,
  verifyWebhook,
};

export {};
