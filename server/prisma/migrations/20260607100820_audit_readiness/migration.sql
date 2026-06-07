-- DropForeignKey
ALTER TABLE "arc_flash_studies" DROP CONSTRAINT "arc_flash_studies_accountId_fkey";

-- DropForeignKey
ALTER TABLE "arc_flash_studies" DROP CONSTRAINT "arc_flash_studies_siteId_fkey";

-- DropForeignKey
ALTER TABLE "arc_flash_studies" DROP CONSTRAINT "arc_flash_studies_supersededById_fkey";

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "ownerId" TEXT;

-- AlterTable
ALTER TABLE "compliance_snapshots" ADD COLUMN     "auditVisitId" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'compliance';

-- AlterTable
ALTER TABLE "contractor_techs" ADD COLUMN     "qualifiedPersonDesignatedAt" TIMESTAMP(3),
ADD COLUMN     "thermographerCertLevel" TEXT,
ADD COLUMN     "trainingExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "contractors" ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "lab_samples" ADD COLUMN     "faultCode" TEXT,
ADD COLUMN     "ieeeStatus" INTEGER,
ADD COLUMN     "n2" DECIMAL(10,2),
ADD COLUMN     "o2" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "maintenance_schedules" ADD COLUMN     "lastPerformedByName" TEXT;

-- AlterTable
ALTER TABLE "test_measurements" ADD COLUMN     "expectedRange" TEXT,
ADD COLUMN     "loadPercent" DECIMAL(5,1),
ADD COLUMN     "severityPriority" INTEGER,
ADD COLUMN     "testVoltage" TEXT;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "ambientTempC" DECIMAL(5,1),
ADD COLUMN     "humidityPct" DECIMAL(5,1),
ADD COLUMN     "testEquipment" JSONB;

-- DropTable
DROP TABLE "arc_flash_studies";

-- CreateTable
CREATE TABLE "system_studies" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "studyType" TEXT NOT NULL DEFAULT 'arc_flash',
    "performedDate" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "performedBy" TEXT,
    "method" TEXT,
    "peName" TEXT,
    "peLicense" TEXT,
    "trigger" TEXT,
    "reportPdfUrl" TEXT,
    "notes" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_visits" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "auditType" TEXT NOT NULL,
    "auditorName" TEXT,
    "auditorOrg" TEXT,
    "scheduledDate" TIMESTAMP(3),
    "performedDate" TIMESTAMP(3),
    "outcome" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_recommendations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "auditVisitId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'insurer',
    "severity" TEXT NOT NULL DEFAULT 'recommendation',
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "responseNotes" TEXT,
    "respondedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "assignedToUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_studies_accountId_idx" ON "system_studies"("accountId");

-- CreateIndex
CREATE INDEX "system_studies_accountId_expiresAt_idx" ON "system_studies"("accountId", "expiresAt");

-- CreateIndex
CREATE INDEX "system_studies_siteId_studyType_idx" ON "system_studies"("siteId", "studyType");

-- CreateIndex
CREATE INDEX "audit_visits_accountId_performedDate_idx" ON "audit_visits"("accountId", "performedDate" DESC);

-- CreateIndex
CREATE INDEX "audit_visits_siteId_idx" ON "audit_visits"("siteId");

-- CreateIndex
CREATE INDEX "audit_recommendations_accountId_status_dueDate_idx" ON "audit_recommendations"("accountId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "audit_recommendations_auditVisitId_idx" ON "audit_recommendations"("auditVisitId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_studies" ADD CONSTRAINT "system_studies_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "system_studies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_visits" ADD CONSTRAINT "audit_visits_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_visits" ADD CONSTRAINT "audit_visits_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_auditVisitId_fkey" FOREIGN KEY ("auditVisitId") REFERENCES "audit_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_recommendations" ADD CONSTRAINT "audit_recommendations_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_auditVisitId_fkey" FOREIGN KEY ("auditVisitId") REFERENCES "audit_visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

