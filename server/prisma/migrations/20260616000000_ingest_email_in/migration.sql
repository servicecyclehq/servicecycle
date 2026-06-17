-- #6 email-in: auto-commit flag + target site for inbound ingest jobs (additive).
ALTER TABLE "ingest_jobs" ADD COLUMN "autoCommit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ingest_jobs" ADD COLUMN "siteId" TEXT;
