-- #29 NFPA 70B:2023 7.4 / NETA MTS-2023 Table 100.18 structured IR thermography.
-- ADDITIVE ONLY: one new enum type, one new enum VALUE, two new tables, their
-- indexes and FKs. No DROP, no RENAME, no column type change, no new non-null
-- column on an existing table.
--
-- 'ALTER TYPE ... ADD VALUE' cannot run in a transaction before PostgreSQL 12;
-- on 12+ it may, provided the new value is not USED in the same transaction.
-- Production runs postgres:16-alpine (docker-compose.yml) and nothing below
-- references 'ir_survey', so this is safe as a single migration. Verified by
-- replaying every migration onto a fresh database with 'prisma migrate deploy'.

-- CreateEnum
CREATE TYPE "ThermographyReference" AS ENUM ('AMBIENT', 'SIMILAR', 'BASELINE');

-- AlterEnum
ALTER TYPE "DocType" ADD VALUE 'ir_survey';

-- CreateTable
CREATE TABLE "thermography_surveys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "surveyDate" TIMESTAMP(3) NOT NULL,
    "thermographerName" TEXT,
    "thermographerQual" TEXT,
    "cameraMake" TEXT,
    "cameraModel" TEXT,
    "ambientTempC" DECIMAL(5,1),
    "humidityPct" DECIMAL(5,1),
    "emissivity" DECIMAL(4,2),
    "reflectedTempC" DECIMAL(5,1),
    "loadPercent" DECIMAL(5,1),
    "sourceDocumentId" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thermography_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thermography_findings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "deltaT" DECIMAL(6,1) NOT NULL,
    "referenceType" "ThermographyReference" NOT NULL DEFAULT 'SIMILAR',
    "referenceDeltaT" DECIMAL(6,1),
    "loadPercent" DECIMAL(5,1),
    "emissivity" DECIMAL(4,2),
    "severity" "DeficiencySeverity",
    "severityLabel" TEXT,
    "correctiveAction" TEXT,
    "deficiencyId" TEXT,
    "thermalImageDocId" TEXT,
    "visibleImageDocId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thermography_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "thermography_surveys_accountId_assetId_surveyDate_idx" ON "thermography_surveys"("accountId", "assetId", "surveyDate");

-- CreateIndex
CREATE UNIQUE INDEX "thermography_findings_deficiencyId_key" ON "thermography_findings"("deficiencyId");

-- CreateIndex
CREATE INDEX "thermography_findings_accountId_assetId_idx" ON "thermography_findings"("accountId", "assetId");

-- CreateIndex
CREATE INDEX "thermography_findings_surveyId_idx" ON "thermography_findings"("surveyId");

-- AddForeignKey
ALTER TABLE "thermography_surveys" ADD CONSTRAINT "thermography_surveys_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_surveys" ADD CONSTRAINT "thermography_surveys_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_surveys" ADD CONSTRAINT "thermography_surveys_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_surveys" ADD CONSTRAINT "thermography_surveys_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_findings" ADD CONSTRAINT "thermography_findings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_findings" ADD CONSTRAINT "thermography_findings_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_findings" ADD CONSTRAINT "thermography_findings_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "thermography_surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thermography_findings" ADD CONSTRAINT "thermography_findings_deficiencyId_fkey" FOREIGN KEY ("deficiencyId") REFERENCES "deficiencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
