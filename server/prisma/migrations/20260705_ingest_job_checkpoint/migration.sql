-- IngestJob checkpoint plumbing (2026-07-05, §11 A2 Half 1)
--
-- Purely additive: two new nullable columns on an existing table, no default
-- required (both null until a job runs), no existing column/constraint/index
-- touched. Hand-verified against a shadow database seeded from the full
-- migration history (applied cleanly). Same drift-detection caveat as the
-- protection_curves migration -- see that migration.sql's header comment
-- and the overnight recap memo; this file contains ONLY the ingest_jobs
-- addition.

-- AlterTable
ALTER TABLE "ingest_jobs" ADD COLUMN     "lastGoodPage" INTEGER,
ADD COLUMN     "pageProgress" JSONB;
