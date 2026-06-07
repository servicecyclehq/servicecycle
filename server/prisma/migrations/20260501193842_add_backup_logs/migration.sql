-- CreateTable
CREATE TABLE "backup_logs" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "storageKey" TEXT,
    "error" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'cron',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_logs_accountId_idx" ON "backup_logs"("accountId");

-- CreateIndex
CREATE INDEX "backup_logs_createdAt_idx" ON "backup_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
