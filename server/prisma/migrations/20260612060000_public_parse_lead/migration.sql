-- CreateTable
CREATE TABLE "public_parse_leads" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fileName" TEXT,
    "source" TEXT,
    "measurementCount" INTEGER NOT NULL DEFAULT 0,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "public_parse_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "public_parse_leads_email_idx" ON "public_parse_leads"("email");

-- CreateIndex
CREATE INDEX "public_parse_leads_createdAt_idx" ON "public_parse_leads"("createdAt");

