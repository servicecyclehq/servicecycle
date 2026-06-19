-- AlterEnum
-- Adds two values to IngestJobStatus. PG12+ allows ADD VALUE in a transaction
-- as long as the new value is not USED in the same transaction (it is not here).
ALTER TYPE "IngestJobStatus" ADD VALUE 'needs_review';
ALTER TYPE "IngestJobStatus" ADD VALUE 'rejected';

-- AlterTable
ALTER TABLE "ingest_jobs" ADD COLUMN     "ackSentAt" TIMESTAMP(3),
ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "gate" JSONB,
ADD COLUMN     "notifyEmail" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "ingest_jobs_accountId_status_idx" ON "ingest_jobs"("accountId", "status");

-- CreateIndex
CREATE INDEX "ingest_jobs_batchId_idx" ON "ingest_jobs"("batchId");