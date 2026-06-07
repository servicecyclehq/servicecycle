-- AlterTable
ALTER TABLE "users" ADD COLUMN     "twoFactorBackupCodes" TEXT,
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorSecret" TEXT;
