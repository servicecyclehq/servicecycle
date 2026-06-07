-- Migration: add_v058_data_capture_fields
-- v0.58.0: four data-capture additions unlocking Tier 1 reports + multiple
-- downstream KPIs (per canned-reports research 2026-05-21 Section 4).
--   * Vendor.criticalityTier - strategic importance distinct from spend size
--     (tier_1 revenue-impacting .. tier_4 nice-to-have). Stored as TEXT to
--     keep migration additive; app-layer validates the accepted values.
--     Unlocks: Vendor Portfolio Heat Map (C P0), Strategic Vendor Risk
--     Index, weighting on all risk reports.
--   * Contract.glCode - first-class GL code field. Custom-field path
--     remains supported for accounts already populating it; new accounts
--     should prefer this column. Unlocks: Spend by GL Category (F P0).
--   * Account.fteCount - per-tenant total headcount, drives the
--     cost-per-employee KPI (most-cited investor-deck metric).
-- Notes:
--   - costCenter is NOT in this migration: Contract.costCenter was already
--     a first-class scalar field added pre-v0.58. v0.58 only exposes it in
--     the UI + zod paths that previously hadn't surfaced it.
--   - All three columns are nullable for zero-downtime migration. App-layer
--     code handles null appropriately (KPI tiles show "Set headcount" CTA;
--     vendor tier defaults to unset; GL code falls back to custom field).

ALTER TABLE "vendors"
  ADD COLUMN IF NOT EXISTS "criticalityTier" TEXT;

ALTER TABLE "contracts"
  ADD COLUMN IF NOT EXISTS "glCode" TEXT;

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "fteCount" INTEGER;