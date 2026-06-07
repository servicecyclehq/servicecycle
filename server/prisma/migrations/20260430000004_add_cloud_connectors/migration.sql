-- CreateTable: cloud_connectors
-- Stores per-account cloud marketplace API credentials (AWS, Azure, GCP).
CREATE TABLE IF NOT EXISTS "cloud_connectors" (
  "id"          TEXT NOT NULL,
  "accountId"   TEXT NOT NULL,
  "provider"    TEXT NOT NULL,
  "label"       TEXT,
  "credentials" JSONB,
  "status"      TEXT NOT NULL DEFAULT 'not_configured',
  "lastError"   TEXT,
  "lastSyncAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cloud_connectors_pkey" PRIMARY KEY ("id")
);

-- Foreign key
ALTER TABLE "cloud_connectors"
  ADD CONSTRAINT "cloud_connectors_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique: one config per provider per account
ALTER TABLE "cloud_connectors"
  ADD CONSTRAINT "cloud_connectors_accountId_provider_key"
  UNIQUE ("accountId", "provider");

CREATE INDEX IF NOT EXISTS "cloud_connectors_accountId_idx"
  ON "cloud_connectors"("accountId");
