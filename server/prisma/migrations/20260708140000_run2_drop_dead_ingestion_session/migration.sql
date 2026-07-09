-- 2026-07-08 Run 2 (W1-L7): drop dead schema IngestionSession / ingestion_sessions.
-- Re-verified zero .create/.update/.find* call sites anywhere in server/; the
-- only Prisma-client references were 3 defensive tenant-prune deleteMany()
-- calls (lib/demoPrune.ts, scripts/seed-demo.js, scripts/seed-powerdb-demo.js),
-- removed in this same commit since the generated client's `ingestionSession`
-- delegate goes away with the model. Superseded by ArcFlashIngest/
-- ArcFlashIngestBus (routes/arcFlashIngest.ts) and IngestJob
-- (lib/ingestWorker.ts, routes/ingestJobs.ts) for the two real ingestion
-- pipelines; docs/ARCHITECTURE.md describing this table as the live
-- arc-flash ingest store is stale documentation, not evidence of use.
--
-- FailedLoginAttempt (the OTHER model this same audit item named) was
-- investigated and NOT dropped -- it's intentionally-provisioned
-- infrastructure for a documented, still-open item (DD-8-4/SEC5, see
-- routes/auth.ts's loginFailMap comment), not dead code. Left untouched.
--
-- Guarded (IF EXISTS), matching house style -- see
-- 20260708120000_audit_remediation_batch1. No other table carries a FK into
-- ingestion_sessions (all 3 FKs were defined ON this table in
-- 20260606000000_init), so DROP TABLE needs no companion ALTER TABLE
-- elsewhere.

DROP TABLE IF EXISTS "ingestion_sessions";

DROP TYPE IF EXISTS "IngestionStatus";
