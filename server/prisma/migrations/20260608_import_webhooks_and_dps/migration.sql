-- Migration: Import Webhooks + Degradation Priority Score (DPS)
-- Feature 1: per-account import webhook (importWebhookUrl / importWebhookSecret on accounts,
--            webhook_deliveries log table)
-- Feature 2: conditionScore + priorityScore on assets,
--            priority field on quote_requests

-- 1. Account: import webhook fields
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "importWebhookUrl"    TEXT,
  ADD COLUMN IF NOT EXISTS "importWebhookSecret" TEXT;

-- 2. Asset: DPS fields
ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "conditionScore" INTEGER,
  ADD COLUMN IF NOT EXISTS "priorityScore"  INTEGER;

-- 3. QuoteRequest: DPS-derived priority
ALTER TABLE "quote_requests"
  ADD COLUMN IF NOT EXISTS "priority" TEXT;

-- 4. WebhookDelivery log table
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"         TEXT        NOT NULL,
  "accountId"  TEXT        NOT NULL,
  "event"      TEXT        NOT NULL,
  "deliveryId" TEXT        NOT NULL,
  "status"     TEXT        NOT NULL,
  "statusCode" INTEGER,
  "responseMs" INTEGER,
  "error"      TEXT,
  "payload"    JSONB       NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "webhook_deliveries_accountId_createdAt_idx"
  ON "webhook_deliveries"("accountId", "createdAt");
