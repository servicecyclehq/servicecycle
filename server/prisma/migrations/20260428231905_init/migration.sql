-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'expiring', 'lapsed', 'read_only', 'inactive');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('saas', 'licensed');

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('small', 'mid', 'enterprise');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'manager', 'viewer');

-- CreateEnum
CREATE TYPE "CotermComplexity" AS ENUM ('none', 'moderate', 'complex');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('active', 'under_review', 'renewed', 'cancelled');

-- CreateEnum
CREATE TYPE "DeliveryMethod" AS ENUM ('user', 'device', 'shared_pool');

-- CreateEnum
CREATE TYPE "FlagType" AS ENUM ('auto_renewal', 'price_escalation', 'termination', 'notice_period', 'minimum_commit', 'other');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('call', 'email_thread', 'meeting', 'note');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('review_by', 'cancel_by', 'renewal', 'billing_60', 'billing_30', 'billing_48');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('pending', 'sent', 'acknowledged', 'escalated', 'cancelled');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('processing', 'review_pending', 'approved', 'imported', 'failed');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "planType" "PlanType" NOT NULL,
    "planTier" "PlanTier",
    "stripeCustomerId" TEXT,
    "licenseDate" TIMESTAMP(3),
    "supportExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cotermComplexity" "CotermComplexity" NOT NULL DEFAULT 'none',
    "cotermNotes" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "title" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "contractNumber" TEXT,
    "customerNumber" TEXT,
    "product" TEXT NOT NULL,
    "quantity" INTEGER,
    "costPerLicense" DECIMAL(12,2),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "reviewByDate" TIMESTAMP(3),
    "autoRenewal" BOOLEAN NOT NULL DEFAULT false,
    "autoRenewalNoticeDays" INTEGER,
    "cancelByDate" TIMESTAMP(3),
    "poNumber" TEXT,
    "invoiceNumber" TEXT,
    "requestor" TEXT,
    "deliveryEmail" TEXT,
    "licenseKeys" TEXT,
    "department" TEXT,
    "team" TEXT,
    "costCenter" TEXT,
    "endUserName" TEXT,
    "endUserEmail" TEXT,
    "internalOwnerId" TEXT,
    "deliveryMethod" "DeliveryMethod",
    "notes" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_flags" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "flagType" "FlagType" NOT NULL,
    "description" TEXT NOT NULL,
    "sourcePage" INTEGER,
    "sourceText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "contractId" TEXT,
    "accountId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" TEXT NOT NULL,
    "contractId" TEXT,
    "vendorId" TEXT,
    "accountId" TEXT NOT NULL,
    "type" "CommunicationType" NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "status" "AlertStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "documentId" TEXT,
    "originalFilename" TEXT NOT NULL,
    "rawText" TEXT,
    "extractedFields" JSONB,
    "confidenceScores" JSONB,
    "aiNotes" JSONB,
    "status" "IngestionStatus" NOT NULL DEFAULT 'processing',
    "reviewedBy" TEXT,
    "reviewCompletedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingestion_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_accountId_idx" ON "users"("accountId");

-- CreateIndex
CREATE INDEX "vendors_accountId_idx" ON "vendors"("accountId");

-- CreateIndex
CREATE INDEX "vendor_contacts_vendorId_idx" ON "vendor_contacts"("vendorId");

-- CreateIndex
CREATE INDEX "contracts_accountId_idx" ON "contracts"("accountId");

-- CreateIndex
CREATE INDEX "contracts_accountId_status_idx" ON "contracts"("accountId", "status");

-- CreateIndex
CREATE INDEX "contracts_accountId_endDate_idx" ON "contracts"("accountId", "endDate");

-- CreateIndex
CREATE INDEX "contracts_vendorId_idx" ON "contracts"("vendorId");

-- CreateIndex
CREATE INDEX "contract_flags_contractId_idx" ON "contract_flags"("contractId");

-- CreateIndex
CREATE INDEX "documents_accountId_idx" ON "documents"("accountId");

-- CreateIndex
CREATE INDEX "documents_contractId_idx" ON "documents"("contractId");

-- CreateIndex
CREATE INDEX "communications_accountId_idx" ON "communications"("accountId");

-- CreateIndex
CREATE INDEX "communications_contractId_idx" ON "communications"("contractId");

-- CreateIndex
CREATE INDEX "alerts_accountId_idx" ON "alerts"("accountId");

-- CreateIndex
CREATE INDEX "alerts_contractId_idx" ON "alerts"("contractId");

-- CreateIndex
CREATE INDEX "alerts_accountId_status_idx" ON "alerts"("accountId", "status");

-- CreateIndex
CREATE INDEX "ingestion_sessions_accountId_idx" ON "ingestion_sessions"("accountId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_internalOwnerId_fkey" FOREIGN KEY ("internalOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_flags" ADD CONSTRAINT "contract_flags_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_sessions" ADD CONSTRAINT "ingestion_sessions_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
