-- CreateEnum
CREATE TYPE "IngestJobStatus" AS ENUM ('queued', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "ingest_jobs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdById" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'test_report',
    "status" "IngestJobStatus" NOT NULL DEFAULT 'queued',
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT,
    "targetAccountId" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingest_jobs_status_createdAt_idx" ON "ingest_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ingest_jobs_accountId_createdAt_idx" ON "ingest_jobs"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "ingest_jobs" ADD CONSTRAINT "ingest_jobs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

