-- Phase 4 #9: enterprise group (HoldCo over OpCos) roll-up + centralized master data.
-- Additive only. New role value + group table + grouping FKs + rate-card group tier.

-- New role: cross-OpCo read-only roll-up admin. (PG12+ allows ADD VALUE here;
-- the value is not USED in this same migration, so no transaction conflict.)
ALTER TYPE "UserRole" ADD VALUE 'group_admin';

-- The parent grouping entity.
CREATE TABLE "enterprise_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "enterprise_groups_pkey" PRIMARY KEY ("id")
);

-- Account -> group linkage (distinct from partnerOrgId).
ALTER TABLE "accounts" ADD COLUMN "enterpriseGroupId" TEXT;
CREATE INDEX "accounts_enterpriseGroupId_idx" ON "accounts"("enterpriseGroupId");
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_enterpriseGroupId_fkey" FOREIGN KEY ("enterpriseGroupId") REFERENCES "enterprise_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Group tier on the rate card (account > group > partner > platform).
ALTER TABLE "service_rate_cards" ADD COLUMN "enterpriseGroupId" TEXT;
CREATE INDEX "service_rate_cards_enterpriseGroupId_idx" ON "service_rate_cards"("enterpriseGroupId");
ALTER TABLE "service_rate_cards" ADD CONSTRAINT "service_rate_cards_enterpriseGroupId_fkey" FOREIGN KEY ("enterpriseGroupId") REFERENCES "enterprise_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
