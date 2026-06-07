-- Migration: Quote Request feature + Service Rep on Account
-- Generated manually for prisma migrate deploy

-- 1. New enum types
CREATE TYPE "QuoteDriver" AS ENUM (
  'down_now',
  'suspected_failing',
  'failed_inspection',
  'planned_replacement',
  'budgetary_only'
);

CREATE TYPE "QuoteTimeline" AS ENUM (
  'immediately',
  'within_one_week',
  'within_thirty_days',
  'next_budget_cycle'
);

CREATE TYPE "QuoteRequestStatus" AS ENUM (
  'requested',
  'quoted',
  'accepted',
  'declined'
);

-- 2. Service rep fields on accounts
ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "serviceRepName"  TEXT,
  ADD COLUMN IF NOT EXISTS "serviceRepEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "serviceRepPhone" TEXT;

-- 3. QuoteRequest table
CREATE TABLE "quote_requests" (
  "id"              TEXT NOT NULL,
  "accountId"       TEXT NOT NULL,
  "assetId"         TEXT NOT NULL,
  "requestedById"   TEXT NOT NULL,
  "status"          "QuoteRequestStatus" NOT NULL DEFAULT 'requested',
  "driver"          "QuoteDriver" NOT NULL,
  "timeline"        "QuoteTimeline" NOT NULL,
  "outageAvailable" BOOLEAN,
  "outageWindow"    TEXT,
  "budgeted"        BOOLEAN,
  "budgetNotes"     TEXT,
  "attachmentNotes" TEXT,
  "emergencyMode"   BOOLEAN NOT NULL DEFAULT false,
  "dossierSnapshot" JSONB,
  "notes"           TEXT,
  "quotedAt"        TIMESTAMP(3),
  "quoteNotes"      TEXT,
  "respondedAt"     TIMESTAMP(3),
  "declineReason"   TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

-- 4. Foreign keys
ALTER TABLE "quote_requests"
  ADD CONSTRAINT "quote_requests_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "quote_requests_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "quote_requests_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id");

-- 5. Indexes
CREATE INDEX "quote_requests_accountId_idx" ON "quote_requests"("accountId");
CREATE INDEX "quote_requests_accountId_status_idx" ON "quote_requests"("accountId", "status");
CREATE INDEX "quote_requests_assetId_idx" ON "quote_requests"("assetId");
CREATE INDEX "quote_requests_requestedById_idx" ON "quote_requests"("requestedById");