-- Migration: 20260627000000_add_revenue_intelligence_schema
-- Revenue Intelligence module (super_admin-only field-intelligence feed).
--
-- 1. Site: one-line diagram tracking. Drives the "One-Line On File" signal and
--    a +5 composite-score component when a diagram is missing.
-- 2. rate_sheet: platform-level singleton holding the pricing inputs used to
--    compute SC dollar estimates. No accountId -- this is platform config,
--    not tenant data, so it lives outside the per-account RLS surface.

-- 1. Site one-line diagram fields
ALTER TABLE "sites" ADD COLUMN "oneLineDiagramOnFile" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sites" ADD COLUMN "oneLineDiagramDate" TIMESTAMP(3);

-- 2. Platform-level rate sheet (single row)
CREATE TABLE "rate_sheet" (
    "id" TEXT NOT NULL,
    "arcFlashStudyPerPanelCents" INTEGER,
    "arcFlashStudyMinimumCents" INTEGER,
    "arcFlashStudyMaximumCents" INTEGER,
    "pmServiceHourlyRateCents" INTEGER,
    "pmVisitMinimumCents" INTEGER,
    "oneLineDiagramCreationCents" INTEGER,
    "equipmentReplacementRanges" JSONB,
    "expiresAfterDays" INTEGER NOT NULL DEFAULT 180,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "lastConfirmedAt" TIMESTAMP(3),
    "lastConfirmedById" TEXT,
    CONSTRAINT "RateSheet_pkey" PRIMARY KEY ("id")
);
