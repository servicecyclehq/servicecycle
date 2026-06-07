-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "reviewStartedAt" TIMESTAMP(3),
ADD COLUMN     "reviewStartedById" TEXT;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_reviewStartedById_fkey" FOREIGN KEY ("reviewStartedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
