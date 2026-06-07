-- Migration: add_user_feature_flags
-- Adds two JSONB columns to users:
--   featureFlags   — admin-controlled visibility grants per user
--   hiddenFeatures — user-controlled personal hide overrides

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "featureFlags"   JSONB;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hiddenFeatures" JSONB;
