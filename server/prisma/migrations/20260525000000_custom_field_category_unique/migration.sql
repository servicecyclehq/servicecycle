-- Migration: change custom_field_definitions unique constraint so the same
-- fieldKey can exist in different category scopes within the same account.
--
-- Before: @@unique([accountId, fieldKey])
--   Problem: seeding "uptime_sla_percent" for telecom AND saas fails because
--   the key is globally unique per account regardless of categoryId.
--
-- After: two partial unique indexes:
--   1. Global fields (categoryId IS NULL): unique on (accountId, fieldKey)
--   2. Category-scoped fields (categoryId IS NOT NULL): unique on
--      (accountId, categoryId, fieldKey)
--
-- This lets the same logical field name exist separately for each category
-- while still preventing duplicate global fields and duplicate per-category
-- fields within one account.

-- Drop the old full-table unique constraint
DROP INDEX IF EXISTS "custom_field_definitions_accountId_fieldKey_key";

-- Uniqueness for global (categoryId IS NULL) fields: one per account+key
CREATE UNIQUE INDEX IF NOT EXISTS "cfd_global_account_fieldKey_unique"
  ON "custom_field_definitions" ("accountId", "fieldKey")
  WHERE "categoryId" IS NULL;

-- Uniqueness for category-scoped (categoryId IS NOT NULL) fields: one per account+category+key
CREATE UNIQUE INDEX IF NOT EXISTS "cfd_scoped_account_category_fieldKey_unique"
  ON "custom_field_definitions" ("accountId", "categoryId", "fieldKey")
  WHERE "categoryId" IS NOT NULL;
