-- OEM Partner Fleet: PartnerOrganization table + oem_admin role + partnerOrgId on Account

-- AlterEnum: add oem_admin to UserRole
ALTER TYPE "UserRole" ADD VALUE 'oem_admin';

-- CreateTable: PartnerOrganization
CREATE TABLE "partner_organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "website" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_organizations_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Add partnerOrgId to accounts
ALTER TABLE "accounts" ADD COLUMN "partnerOrgId" TEXT;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_partnerOrgId_fkey" FOREIGN KEY ("partnerOrgId") REFERENCES "partner_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
