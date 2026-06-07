-- AlterTable
ALTER TABLE "users" ADD COLUMN     "aiConsentDismissedAt" TIMESTAMP(3),
ADD COLUMN     "aiConsentSilenced" BOOLEAN NOT NULL DEFAULT false;
