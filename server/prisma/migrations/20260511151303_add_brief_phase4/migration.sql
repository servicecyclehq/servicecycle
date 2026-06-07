-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "renewalBriefCategorySlug" TEXT,
ADD COLUMN     "renewalBriefTemplateVersion" TEXT;

-- CreateTable
CREATE TABLE "template_feedback" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contractId" TEXT,
    "userId" TEXT,
    "categorySlug" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "rating" BOOLEAN NOT NULL,
    "freeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "template_feedback_accountId_createdAt_idx" ON "template_feedback"("accountId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "template_feedback_accountId_categorySlug_idx" ON "template_feedback"("accountId", "categorySlug");

-- CreateIndex
CREATE INDEX "template_feedback_contractId_idx" ON "template_feedback"("contractId");

-- AddForeignKey
ALTER TABLE "template_feedback" ADD CONSTRAINT "template_feedback_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_feedback" ADD CONSTRAINT "template_feedback_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_feedback" ADD CONSTRAINT "template_feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
