-- Migration: add_outbound_webhook_dlq
-- v0.37.1 W5 MT-132. Persists failed webhook deliveries after the
-- in-process retry loop (3 attempts, exponential backoff) exhausts.
-- Admin UI surfaces these for inspection + manual retry; a nightly cron
-- purges entries older than 30 days so the table stays bounded.
--
-- v0.38.1: defensive-SQL pass — IF NOT EXISTS guards added to the
-- CREATE TABLE + CREATE INDEX statements, and the ALTER TABLE ADD
-- CONSTRAINT statements wrapped in DO blocks that swallow duplicate_object
-- errors. This makes the migration safely re-runnable in restore-from-
-- backup scenarios where the table already exists but the prisma
-- _prisma_migrations row was lost.

CREATE TABLE IF NOT EXISTS "outbound_webhook_dlq" (
  "id"                TEXT         NOT NULL,
  "accountId"         TEXT         NOT NULL,
  "webhookEndpointId" TEXT,
  "deliveryId"        TEXT         NOT NULL,
  "eventType"         TEXT         NOT NULL,
  "targetUrlMasked"   TEXT         NOT NULL,
  "payload"           JSONB        NOT NULL,
  "attemptCount"      INTEGER      NOT NULL DEFAULT 0,
  "lastError"         TEXT,
  "lastStatus"        INTEGER,
  "firstFailedAt"     TIMESTAMP(3) NOT NULL,
  "lastAttemptAt"     TIMESTAMP(3) NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "outbound_webhook_dlq_pkey" PRIMARY KEY ("id")
);

-- Cascade on account delete so removing an account scrubs its DLQ.
DO $$ BEGIN
  ALTER TABLE "outbound_webhook_dlq"
    ADD CONSTRAINT "outbound_webhook_dlq_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SET NULL on endpoint delete: a deleted webhook leaves orphan DLQ rows
-- so the operator can still see what failed before the endpoint was
-- removed. The cron purge job's TTL eventually clears them.
DO $$ BEGIN
  ALTER TABLE "outbound_webhook_dlq"
    ADD CONSTRAINT "outbound_webhook_dlq_webhookEndpointId_fkey"
    FOREIGN KEY ("webhookEndpointId") REFERENCES "webhook_endpoints"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Per-account list query.
CREATE INDEX IF NOT EXISTS "outbound_webhook_dlq_accountId_createdAt_idx"
  ON "outbound_webhook_dlq"("accountId", "createdAt");

-- TTL purge query.
CREATE INDEX IF NOT EXISTS "outbound_webhook_dlq_createdAt_idx"
  ON "outbound_webhook_dlq"("createdAt");

-- Idempotency / debugging lookup by deliveryId.
CREATE INDEX IF NOT EXISTS "outbound_webhook_dlq_deliveryId_idx"
  ON "outbound_webhook_dlq"("deliveryId");
