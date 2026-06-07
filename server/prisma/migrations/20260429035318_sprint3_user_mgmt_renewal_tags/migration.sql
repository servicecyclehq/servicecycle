-- DropForeignKey
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_contractId_fkey";

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "daysBeforeEnd" INTEGER;

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "parentContractId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "passwordResetExpiresAt" TIMESTAMP(3),
ADD COLUMN     "passwordResetToken" TEXT;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "scorePriceFlexibility" INTEGER,
ADD COLUMN     "scoreSatisfaction" INTEGER,
ADD COLUMN     "scoreStrategicValue" INTEGER,
ADD COLUMN     "scoreSupport" INTEGER;

-- CreateTable
CREATE TABLE "contract_tags" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "daysBeforeList" TEXT NOT NULL DEFAULT '90,60,30',
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_tags_contractId_idx" ON "contract_tags"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "contract_tags_contractId_tag_key" ON "contract_tags"("contractId", "tag");

-- CreateIndex
CREATE INDEX "alert_preferences_userId_idx" ON "alert_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "alert_preferences_userId_alertType_key" ON "alert_preferences"("userId", "alertType");

-- CreateIndex
CREATE INDEX "alerts_scheduledAt_status_idx" ON "alerts"("scheduledAt", "status");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_parentContractId_fkey" FOREIGN KEY ("parentContractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_tags" ADD CONSTRAINT "contract_tags_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_preferences" ADD CONSTRAINT "alert_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
