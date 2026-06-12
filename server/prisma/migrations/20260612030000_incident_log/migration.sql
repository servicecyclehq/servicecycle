-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('PROTECTIVE_TRIP', 'RELAY_OPERATION', 'ALARM', 'ARC_FLASH_EVENT', 'OTHER');

-- CreateTable
CREATE TABLE "incident_logs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "IncidentType" NOT NULL DEFAULT 'OTHER',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incident_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_logs_accountId_idx" ON "incident_logs"("accountId");

-- CreateIndex
CREATE INDEX "incident_logs_assetId_idx" ON "incident_logs"("assetId");

-- CreateIndex
CREATE INDEX "incident_logs_accountId_resolvedAt_idx" ON "incident_logs"("accountId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "incident_logs" ADD CONSTRAINT "incident_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_logs" ADD CONSTRAINT "incident_logs_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

