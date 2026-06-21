-- Arc-flash Slice 2: ingest + gap-analysis DRAFT tables (purely additive).
-- Holds an uploaded one-line / study-report, its AI extraction, and the
-- per-bus IEEE 1584 gap punch list, pending review-and-confirm. Account scoping
-- is enforced at the app layer (scalar FKs), so no existing table is altered.

-- CreateTable
CREATE TABLE "arc_flash_ingests" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'one_line',
    "fileKey" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "pageCount" INTEGER,
    "extractionMethod" TEXT,
    "aiProvider" TEXT,
    "promptVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'extracting',
    "overallBand" TEXT,
    "readyBusCount" INTEGER NOT NULL DEFAULT 0,
    "totalBusCount" INTEGER NOT NULL DEFAULT 0,
    "systemMeta" JSONB,
    "rawExtraction" JSONB,
    "error" TEXT,
    "producedStudyId" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arc_flash_ingests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arc_flash_ingest_buses" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ingestId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "busName" TEXT NOT NULL,
    "equipmentTypeGuess" TEXT,
    "fedFromBusName" TEXT,
    "nominalVoltage" TEXT,
    "boltedFaultCurrentKA" DECIMAL(10,2),
    "arcingCurrentKA" DECIMAL(10,2),
    "electrodeConfig" TEXT,
    "conductorGapMm" DECIMAL(6,1),
    "clearingTimeMs" DECIMAL(10,1),
    "workingDistanceIn" DECIMAL(10,1),
    "upstreamDevice" TEXT,
    "incidentEnergyCalCm2" DECIMAL(10,2),
    "arcFlashBoundaryIn" DECIMAL(10,1),
    "ppeCategory" INTEGER,
    "gaps" JSONB,
    "readiness" TEXT NOT NULL DEFAULT 'blocked',
    "confidence" TEXT NOT NULL DEFAULT 'red',
    "matchedAssetId" TEXT,
    "resolution" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arc_flash_ingest_buses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "arc_flash_ingests_accountId_idx" ON "arc_flash_ingests"("accountId");

-- CreateIndex
CREATE INDEX "arc_flash_ingests_accountId_siteId_idx" ON "arc_flash_ingests"("accountId", "siteId");

-- CreateIndex
CREATE INDEX "arc_flash_ingests_accountId_status_idx" ON "arc_flash_ingests"("accountId", "status");

-- CreateIndex
CREATE INDEX "arc_flash_ingest_buses_accountId_idx" ON "arc_flash_ingest_buses"("accountId");

-- CreateIndex
CREATE INDEX "arc_flash_ingest_buses_ingestId_idx" ON "arc_flash_ingest_buses"("ingestId");

-- CreateIndex
CREATE INDEX "arc_flash_ingest_buses_ingestId_seq_idx" ON "arc_flash_ingest_buses"("ingestId", "seq");

-- AddForeignKey
ALTER TABLE "arc_flash_ingest_buses" ADD CONSTRAINT "arc_flash_ingest_buses_ingestId_fkey" FOREIGN KEY ("ingestId") REFERENCES "arc_flash_ingests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
