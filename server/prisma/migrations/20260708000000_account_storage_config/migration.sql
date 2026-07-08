-- Per-tenant "bring your own storage" (2026-07-08). Purely additive: 6
-- nullable columns on the existing "accounts" table, zero drops/renames/
-- NOT-NULL-without-default. Hand-authored to match schema.prisma directly
-- (same convention as 20260705_edms_phase1_scaffold) rather than a
-- `prisma migrate diff` run, since this is a small, mechanical addition.
--
-- storageProvider is the switch: null means "use the global STORAGE_* env
-- vars" (today's only behaviour, unchanged for every existing account).
-- Setting it to 's3' opts an account into its own bucket via the other five
-- columns. storageS3KeyId / storageS3Secret are written encrypted at rest
-- (lib/crypto.ts, same AES-256-GCM path as accounts.importWebhookSecret) --
-- application-layer concern, not something this migration enforces at the
-- DB level.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "storageProvider" TEXT;
ALTER TABLE "accounts" ADD COLUMN     "storageS3Bucket" TEXT;
ALTER TABLE "accounts" ADD COLUMN     "storageS3Region" TEXT;
ALTER TABLE "accounts" ADD COLUMN     "storageS3Endpoint" TEXT;
ALTER TABLE "accounts" ADD COLUMN     "storageS3KeyId" TEXT;
ALTER TABLE "accounts" ADD COLUMN     "storageS3Secret" TEXT;
