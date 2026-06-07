-- Migration: add_webhook_endpoints
-- Adds the WebhookEndpoint table for generic outbound alert delivery
-- (Zapier / n8n / Make / custom HTTP listeners).
--
-- url and hmacSecret are stored encrypted via lib/crypto (same pattern as
-- cloudConnector credentials and Slack/Teams webhook URLs).

CREATE TABLE "webhook_endpoints" (
  "id"          TEXT         NOT NULL,
  "accountId"   TEXT         NOT NULL,
  "label"       TEXT         NOT NULL DEFAULT '',
  "url"         TEXT         NOT NULL,
  "hmacSecret"  TEXT         NOT NULL,
  "enabled"     BOOLEAN      NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- FK → accounts (cascade delete cleans up endpoints when an account is removed)
ALTER TABLE "webhook_endpoints"
  ADD CONSTRAINT "webhook_endpoints_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Index for per-account queries (list, CRUD)
CREATE INDEX "webhook_endpoints_accountId_idx"
  ON "webhook_endpoints"("accountId");
