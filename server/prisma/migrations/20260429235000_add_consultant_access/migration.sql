-- Add consultant to UserRole enum
ALTER TYPE "UserRole" ADD VALUE 'consultant';

-- CreateTable ConsultantAccess
CREATE TABLE "consultant_accesses" (
    "id"           TEXT NOT NULL,
    "accountId"    TEXT NOT NULL,
    "consultantId" TEXT NOT NULL,
    "grantedById"  TEXT NOT NULL,
    "grantedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedById"  TEXT,
    "revokedAt"    TIMESTAMP(3),
    "isActive"     BOOLEAN NOT NULL DEFAULT true,
    "notes"        TEXT,

    CONSTRAINT "consultant_accesses_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "consultant_accesses_accountId_idx"    ON "consultant_accesses"("accountId");
CREATE INDEX "consultant_accesses_consultantId_idx" ON "consultant_accesses"("consultantId");

-- Foreign Keys
ALTER TABLE "consultant_accesses"
    ADD CONSTRAINT "consultant_accesses_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "consultant_accesses"
    ADD CONSTRAINT "consultant_accesses_consultantId_fkey"
    FOREIGN KEY ("consultantId") REFERENCES "users"("id") ON UPDATE CASCADE;

ALTER TABLE "consultant_accesses"
    ADD CONSTRAINT "consultant_accesses_grantedById_fkey"
    FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON UPDATE CASCADE;

ALTER TABLE "consultant_accesses"
    ADD CONSTRAINT "consultant_accesses_revokedById_fkey"
    FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON UPDATE CASCADE;
