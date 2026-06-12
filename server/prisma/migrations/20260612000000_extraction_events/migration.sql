-- Extraction telemetry (#4) + report fingerprint / dedupe (#5): one row per
-- extraction across every ingest + scan path. Additive only.
-- CreateTable
CREATE TABLE "extraction_events" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "ocr" BOOLEAN NOT NULL DEFAULT false,
    "aiUsed" BOOLEAN NOT NULL DEFAULT false,
    "pageCount" INTEGER,
    "pagesScanned" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "assetSections" INTEGER,
    "fieldsExtracted" INTEGER NOT NULL DEFAULT 0,
    "confMin" DOUBLE PRECISION,
    "confMean" DOUBLE PRECISION,
    "redCount" INTEGER,
    "yellowCount" INTEGER,
    "greenCount" INTEGER,
    "sha256" TEXT,
    "committedAt" TIMESTAMP(3),
    "fieldsCommitted" INTEGER,
    "fieldsCorrected" INTEGER,
    "corrections" JSONB,
    "reviewMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extraction_events_accountId_createdAt_idx" ON "extraction_events"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "extraction_events_kind_createdAt_idx" ON "extraction_events"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "extraction_events_accountId_sha256_idx" ON "extraction_events"("accountId", "sha256");

-- CreateIndex
CREATE INDEX "extraction_events_accountId_committedAt_idx" ON "extraction_events"("accountId", "committedAt");

