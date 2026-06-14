-- CreateTable
CREATE TABLE "system_study_assets" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "studyId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "busName" TEXT,
    "nominalVoltage" TEXT,
    "incidentEnergyCalCm2" DECIMAL(10,2),
    "arcFlashBoundaryIn" DECIMAL(10,1),
    "workingDistanceIn" DECIMAL(10,1),
    "ppeCategory" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_study_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_study_assets_accountId_idx" ON "system_study_assets"("accountId");

-- CreateIndex
CREATE INDEX "system_study_assets_studyId_idx" ON "system_study_assets"("studyId");

-- CreateIndex
CREATE INDEX "system_study_assets_assetId_idx" ON "system_study_assets"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "system_study_assets_studyId_assetId_key" ON "system_study_assets"("studyId", "assetId");

-- AddForeignKey
ALTER TABLE "system_study_assets" ADD CONSTRAINT "system_study_assets_studyId_fkey" FOREIGN KEY ("studyId") REFERENCES "system_studies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_study_assets" ADD CONSTRAINT "system_study_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

