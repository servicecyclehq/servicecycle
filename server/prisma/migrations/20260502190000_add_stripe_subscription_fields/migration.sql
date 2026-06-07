-- Stripe subscription seam (Sprint 6 prep)
-- These columns are populated by the future Checkout flow + webhook
-- handler. Self-hosted licensed instances leave them null and bypass
-- tier enforcement entirely via middleware/requireTier.js.

ALTER TABLE "accounts"
  ADD COLUMN "stripeSubscriptionId"     TEXT,
  ADD COLUMN "stripeSubscriptionStatus" TEXT,
  ADD COLUMN "stripeCurrentPeriodEnd"   TIMESTAMP(3);