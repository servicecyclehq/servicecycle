-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "fedFromAssetId" TEXT;

-- CreateIndex
CREATE INDEX "assets_fedFromAssetId_idx" ON "assets"("fedFromAssetId");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_fedFromAssetId_fkey" FOREIGN KEY ("fedFromAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

