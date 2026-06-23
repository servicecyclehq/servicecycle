-- Arc-flash incident / near-miss register. Manual customer entry; SC snapshots
-- the bus's arc-flash data state at log time so the record self-contextualizes.
-- Additive, scalar FKs only (pure append).

-- CreateTable
CREATE TABLE "arc_flash_incidents" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "assetId" TEXT,
    "systemStudyAssetId" TEXT,
    "busName" TEXT,
    "incidentType" TEXT NOT NULL DEFAULT 'near_miss',
    "occurredAt" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "injury" BOOLEAN NOT NULL DEFAULT false,
    "injuryDetail" TEXT,
    "ppeWorn" TEXT,
    "workType" TEXT,
    "oshaRecordable" BOOLEAN,
    "correctiveAction" TEXT,
    "studyStateSnapshot" JSONB,
    "reportUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reportedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "arc_flash_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "arc_flash_incidents_accountId_idx" ON "arc_flash_incidents"("accountId");
CREATE INDEX "arc_flash_incidents_accountId_siteId_idx" ON "arc_flash_incidents"("accountId", "siteId");
CREATE INDEX "arc_flash_incidents_assetId_idx" ON "arc_flash_incidents"("assetId");
CREATE INDEX "arc_flash_incidents_accountId_status_idx" ON "arc_flash_incidents"("accountId", "status");