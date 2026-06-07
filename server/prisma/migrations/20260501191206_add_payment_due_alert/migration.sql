-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'payment_due';

-- DropForeignKey
ALTER TABLE "consultant_accesses" DROP CONSTRAINT "consultant_accesses_consultantId_fkey";

-- DropForeignKey
ALTER TABLE "consultant_accesses" DROP CONSTRAINT "consultant_accesses_grantedById_fkey";

-- DropForeignKey
ALTER TABLE "consultant_accesses" DROP CONSTRAINT "consultant_accesses_revokedById_fkey";

-- DropIndex
DROP INDEX "vendor_news_accountId_publishedAt_idx";

-- DropIndex
DROP INDEX "vendor_news_accountId_url_key";

-- AlterTable
ALTER TABLE "cloud_connectors" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "refresh_tokens" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "vendor_news_accountId_publishedAt_idx" ON "vendor_news"("accountId", "publishedAt");

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_consultantId_fkey" FOREIGN KEY ("consultantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultant_accesses" ADD CONSTRAINT "consultant_accesses_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
