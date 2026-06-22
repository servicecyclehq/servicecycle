-- Slice 2.7: field-collection of protective-device data + photo-read.
-- Two new tables, purely additive (no changes to existing tables):
--   protective_devices       = the DURABLE record of a collected upstream device
--                              (frame/sensor rating + LSIG trip settings or fuse),
--                              versioned via supersededById.
--   arc_flash_collection_tasks = "open panel X and record the device + cable"
--                              tasks generated from an ingest's blocked buses,
--                              carrying PPE / outage / qualified-person sequencing.

-- CreateTable
CREATE TABLE "protective_devices" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "assetId" TEXT,
    "ingestBusId" TEXT,
    "label" TEXT NOT NULL,
    "deviceType" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "partNumber" TEXT,
    "frameRatingA" DECIMAL(10,1),
    "sensorRatingA" DECIMAL(10,1),
    "settings" JSONB,
    "settingsCollectedAt" TIMESTAMP(3),
    "collectedById" TEXT,
    "photoKey" TEXT,
    "source" TEXT NOT NULL DEFAULT 'field',
    "supersededById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protective_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arc_flash_collection_tasks" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "ingestId" TEXT,
    "ingestBusId" TEXT,
    "assetId" TEXT,
    "busName" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "neededFields" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assignedUserId" TEXT,
    "hazardClass" TEXT,
    "ppeNote" TEXT,
    "requiresOutage" BOOLEAN NOT NULL DEFAULT false,
    "requiresQualifiedPerson" BOOLEAN NOT NULL DEFAULT true,
    "collectedDeviceId" TEXT,
    "collectedById" TEXT,
    "collectedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "arc_flash_collection_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "protective_devices_accountId_idx" ON "protective_devices"("accountId");

-- CreateIndex
CREATE INDEX "protective_devices_accountId_siteId_idx" ON "protective_devices"("accountId", "siteId");

-- CreateIndex
CREATE INDEX "protective_devices_assetId_idx" ON "protective_devices"("assetId");

-- CreateIndex
CREATE INDEX "protective_devices_ingestBusId_idx" ON "protective_devices"("ingestBusId");

-- CreateIndex
CREATE INDEX "protective_devices_accountId_status_idx" ON "protective_devices"("accountId", "status");

-- CreateIndex
CREATE INDEX "arc_flash_collection_tasks_accountId_idx" ON "arc_flash_collection_tasks"("accountId");

-- CreateIndex
CREATE INDEX "arc_flash_collection_tasks_accountId_siteId_idx" ON "arc_flash_collection_tasks"("accountId", "siteId");

-- CreateIndex
CREATE INDEX "arc_flash_collection_tasks_accountId_status_idx" ON "arc_flash_collection_tasks"("accountId", "status");

-- CreateIndex
CREATE INDEX "arc_flash_collection_tasks_assignedUserId_status_idx" ON "arc_flash_collection_tasks"("assignedUserId", "status");

-- CreateIndex
CREATE INDEX "arc_flash_collection_tasks_ingestId_idx" ON "arc_flash_collection_tasks"("ingestId");
