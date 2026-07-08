-- 2026-07-08 acquisition-audit remediation, Batch 1 (schema & migrations).
-- Every step is guarded (IF NOT EXISTS / DO-block existence checks) so this
-- migration is idempotent and safe to re-run, matching the style already
-- used elsewhere in this migrations directory (see
-- 20260624120000_parts_tables_create_if_not_exists).

-- ── W1-H3 / AI-1: per-reading provenance on TestMeasurement ────────────────
-- Populated going forward by commitTestReport.ts (remediation Batch 3).
ALTER TABLE "test_measurements"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION;

-- ── W1-M3: ActivityLog.asset onDelete Cascade -> SetNull ────────────────────
-- Was Cascade: hard-deleting an Asset silently destroyed its audit history.
-- SetNull preserves the rows (matches .account's existing SetNull). Paired
-- with the canonical() change in server/lib/activityLogChain.ts (excludes
-- accountId/assetId from the hash payload) so a legitimate SetNull no
-- longer reads as tampering. Run
-- `docker compose exec server node scripts/backfill-activity-log-chain.js`
-- once after this migration deploys to re-anchor the chain under the new
-- canonical() form.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_logs_assetId_fkey') THEN
    ALTER TABLE "activity_logs" DROP CONSTRAINT "activity_logs_assetId_fkey";
  END IF;
  ALTER TABLE "activity_logs"
    ADD CONSTRAINT "activity_logs_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
END $$;

-- ── W1-L13: missing indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "activity_logs_userId_idx" ON "activity_logs"("userId");
CREATE INDEX IF NOT EXISTS "partner_invites_accountId_idx" ON "partner_invites"("accountId");
CREATE INDEX IF NOT EXISTS "custom_field_values_definitionId_idx" ON "custom_field_values"("definitionId");
CREATE INDEX IF NOT EXISTS "work_orders_assignedTechId_idx" ON "work_orders"("assignedTechId");

-- ── W1-L5: Part duplicate-partNumber protection ─────────────────────────────
-- GUARDED: if pre-existing duplicate (accountId, partNumber) rows are found,
-- skip adding the constraint and log a NOTICE instead of failing the
-- migration (this init-container-gated deploy would otherwise take prod
-- down on a data conflict we can't see from a static migration). If the
-- NOTICE fires, the fix is a manual dedupe pass followed by a follow-up
-- migration — flagged in docs/REMEDIATION_SUMMARY_2026-07-08.md.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "accountId", "partNumber" FROM "parts"
    GROUP BY "accountId", "partNumber" HAVING COUNT(*) > 1
  ) d;
  IF dup_count = 0 THEN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'parts_accountId_partNumber_idx') THEN
      DROP INDEX "parts_accountId_partNumber_idx";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_accountId_partNumber_key') THEN
      ALTER TABLE "parts" ADD CONSTRAINT "parts_accountId_partNumber_key" UNIQUE ("accountId", "partNumber");
    END IF;
  ELSE
    RAISE NOTICE 'parts: % duplicate (accountId, partNumber) group(s) found — skipping unique constraint. Needs a manual dedupe pass before this can be added safely.', dup_count;
  END IF;
END $$;

-- ── W1-L5: SpareInventory duplicate-row protection ──────────────────────────
-- Expression unique index (not representable in Prisma's schema DSL — see
-- comment above the SpareInventory model in schema.prisma). Collapses NULL
-- assetId/siteId to '' so the "account-wide float" and "site-level" cases
-- are collision-checked too, not just asset-scoped rows. Same guard pattern
-- as the Part constraint above.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "accountId", "partId", COALESCE("assetId", ''), COALESCE("siteId", '')
    FROM "spare_inventory"
    GROUP BY "accountId", "partId", COALESCE("assetId", ''), COALESCE("siteId", '')
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'spare_inventory_dedupe_key') THEN
      CREATE UNIQUE INDEX "spare_inventory_dedupe_key" ON "spare_inventory"
        ("accountId", "partId", COALESCE("assetId", ''), COALESCE("siteId", ''));
    END IF;
  ELSE
    RAISE NOTICE 'spare_inventory: % duplicate (accountId, partId, assetId, siteId) group(s) found — skipping unique index. Needs a manual dedupe pass before this can be added safely.', dup_count;
  END IF;
END $$;
