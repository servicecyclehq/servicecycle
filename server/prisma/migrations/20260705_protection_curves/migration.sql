-- ProtectionCurve (2026-07-05, §10 A3 TCC backend prep)
--
-- Purely additive: one new table, three new indexes. No existing table,
-- column, constraint, or relation is touched.
--
-- NOTE: this file was hand-extracted from a `prisma migrate diff` run
-- against the full migration history, which also reported a number of
-- UNRELATED drift statements (DropForeignKey on access_blockers, several
-- RenameConstraint/RenameIndex ops on failed_login_attempts / rate_sheet /
-- work_order_part_usages / WorkOrder). Those are pre-existing drift between
-- prisma/migrations/ and schema.prisma that predates this session -- they
-- are NOT included here and were NOT applied anywhere. See the overnight
-- recap memo (servicecycle-overnight-parser-2026-07-05) for the full diff
-- output and a flag for Dustin to investigate separately; this migration
-- file contains ONLY the protection_curves addition.

-- CreateTable
CREATE TABLE "protection_curves" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT,
    "protectiveDeviceId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "deviceLabel" TEXT NOT NULL,
    "deviceModel" TEXT,
    "curveType" TEXT NOT NULL DEFAULT 'breaker',
    "dataSource" TEXT NOT NULL DEFAULT 'manual',
    "curvePoints" JSONB,
    "settings" JSONB,
    "sourceDocumentId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protection_curves_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protection_curves_accountId_idx" ON "protection_curves"("accountId");

-- CreateIndex
CREATE INDEX "protection_curves_assetId_idx" ON "protection_curves"("assetId");

-- CreateIndex
CREATE INDEX "protection_curves_protectiveDeviceId_idx" ON "protection_curves"("protectiveDeviceId");
