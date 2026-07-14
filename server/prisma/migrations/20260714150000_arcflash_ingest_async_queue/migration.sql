-- W1 part 2 (2026-07-14): async arc-flash ingest worker fields.
--
-- extractArcFlashDocument (native-PDF) runs 50-150s — a chunked large report is
-- several native calls — far too long to hold the HTTP request open. Extraction
-- moved off the request into lib/arcFlashIngestWorker, an in-process poller on
-- the existing arc_flash_ingests draft table (mirrors the ingest_jobs queue used
-- by lib/ingestWorker). These two columns give that worker its reliability
-- contract on this table:
--   attempts  — extraction attempt count, so a poison job goes terminal instead
--               of looping (MAX_ATTEMPTS).
--   startedAt — when the current 'processing' claim began, so a row stuck
--               'processing' past STALE_MS (worker crashed mid-extraction) is
--               requeued by recoverStaleArcFlashIngests().
-- The 'status' column already exists and now also carries 'queued'/'processing'.
--
-- Additive: NOT NULL DEFAULT 0 / nullable — no backfill, no impact on existing
-- rows. Matches house style (see 20260708120000_audit_remediation_batch1).
ALTER TABLE "arc_flash_ingests" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "arc_flash_ingests" ADD COLUMN "startedAt" TIMESTAMP(3);
