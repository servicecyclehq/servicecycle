DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PartnerEventType') THEN
    CREATE TYPE "PartnerEventType" AS ENUM ('IMMEDIATE_DEFICIENCY', 'INSPECTION_COMPLETED', 'QUOTE_REQUEST_CREATED', 'TASK_OVERDUE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RetentionTier') THEN
    CREATE TYPE "RetentionTier" AS ENUM ('STANDARD', 'HEALTHCARE', 'UTILITY', 'CUSTOM');
  END IF;
END $$;

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "assignedRepId" TEXT,
  ADD COLUMN IF NOT EXISTS "fallbackRepId" TEXT,
  ADD COLUMN IF NOT EXISTS "retentionCustomYears" INTEGER,
  ADD COLUMN IF NOT EXISTS "retentionTier" "RetentionTier" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "criticalSparesAvailable" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "endOfManufacture" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "endOfSupport" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "modernizationRiskScore" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "obsolescenceStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "replacementCostCents" INTEGER,
  ADD COLUMN IF NOT EXISTS "sparePartsLeadTimeDays" INTEGER;

ALTER TABLE "contractor_techs"
  ADD COLUMN IF NOT EXISTS "qemwCertNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "qemwExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "qemwIssuingBody" TEXT;

ALTER TABLE "quote_requests"
  ADD COLUMN IF NOT EXISTS "triggerType" TEXT;

ALTER TABLE "partner_organizations"
  ADD COLUMN IF NOT EXISTS "digestIntervalDays" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "webhookSecret" TEXT,
  ADD COLUMN IF NOT EXISTS "webhookUrl" TEXT;

CREATE TABLE IF NOT EXISTS "partner_invites" (
    "id" TEXT NOT NULL,
    "partnerOrgId" TEXT NOT NULL,
    "inviteeEmail" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "partner_event_logs" (
    "id" TEXT NOT NULL,
    "partnerOrgId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "eventType" "PartnerEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "assignedRepId" TEXT,
    "digestSentAt" TIMESTAMP(3),
    "immediateEmailSentAt" TIMESTAMP(3),
    "webhookSentAt" TIMESTAMP(3),
    "seenAt" TIMESTAMP(3),
    "actionedAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_event_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "partner_invites_tokenHash_key" ON "partner_invites"("tokenHash");
CREATE INDEX IF NOT EXISTS "partner_invites_partnerOrgId_idx" ON "partner_invites"("partnerOrgId");
CREATE INDEX IF NOT EXISTS "partner_invites_invitedById_idx" ON "partner_invites"("invitedById");
CREATE INDEX IF NOT EXISTS "partner_event_logs_partnerOrgId_idx" ON "partner_event_logs"("partnerOrgId");
CREATE INDEX IF NOT EXISTS "partner_event_logs_accountId_idx" ON "partner_event_logs"("accountId");
CREATE INDEX IF NOT EXISTS "partner_event_logs_archived_idx" ON "partner_event_logs"("partnerOrgId", "archived", "digestSentAt");
CREATE INDEX IF NOT EXISTS "partner_event_logs_evtype_idx" ON "partner_event_logs"("accountId", "eventType", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_assignedRepId_fkey') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_fallbackRepId_fkey') THEN
    ALTER TABLE "accounts" ADD CONSTRAINT "accounts_fallbackRepId_fkey" FOREIGN KEY ("fallbackRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_invites_partnerOrgId_fkey') THEN
    ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_invites_invitedById_fkey') THEN
    ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_invites_accountId_fkey') THEN
    ALTER TABLE "partner_invites" ADD CONSTRAINT "partner_invites_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_event_logs_partnerOrgId_fkey') THEN
    ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_event_logs_accountId_fkey') THEN
    ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_event_logs_assignedRepId_fkey') THEN
    ALTER TABLE "partner_event_logs" ADD CONSTRAINT "partner_event_logs_assignedRepId_fkey" FOREIGN KEY ("assignedRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;