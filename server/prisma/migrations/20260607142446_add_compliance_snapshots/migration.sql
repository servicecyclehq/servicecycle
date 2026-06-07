-- CreateTable
CREATE TABLE "compliance_snapshots" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT,
    "standardCode" TEXT,
    "generatedById" TEXT,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "sha256" TEXT NOT NULL,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compliance_snapshots_accountId_createdAt_idx" ON "compliance_snapshots"("accountId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_snapshots" ADD CONSTRAINT "compliance_snapshots_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
