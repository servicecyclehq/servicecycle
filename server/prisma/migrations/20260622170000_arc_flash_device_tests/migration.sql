-- Slice G: NETA as-found / as-left device-test linkage. Captures relay-cal /
-- breaker-trip-test records; drift between as-found/as-left (or vs the study's
-- assumed settings) flags a potentially stale incident-energy result.

-- CreateTable
CREATE TABLE "device_test_records" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "assetId" TEXT,
    "protectiveDeviceId" TEXT,
    "systemStudyAssetId" TEXT,
    "ingestBusId" TEXT,
    "testType" TEXT NOT NULL,
    "testDate" TIMESTAMP(3),
    "performedBy" TEXT,
    "asFoundSettings" JSONB,
    "asLeftSettings" JSONB,
    "matchesStudy" BOOLEAN,
    "driftFlagged" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT,
    "notes" TEXT,
    "reportUrl" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "device_test_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_test_records_accountId_idx" ON "device_test_records"("accountId");
CREATE INDEX "device_test_records_accountId_siteId_idx" ON "device_test_records"("accountId", "siteId");
CREATE INDEX "device_test_records_assetId_idx" ON "device_test_records"("assetId");
CREATE INDEX "device_test_records_protectiveDeviceId_idx" ON "device_test_records"("protectiveDeviceId");
CREATE INDEX "device_test_records_systemStudyAssetId_idx" ON "device_test_records"("systemStudyAssetId");
