-- DropIndex
-- 2026-05-11: made IF EXISTS because the index name in this local migrate-dev
-- shadow database may not match what's actually present on the demo DB. The
-- index drift is unrelated to the Phase 1 category changes — Prisma is just
-- cleaning up history; if the index isn't there, the drop is a no-op.
DROP INDEX IF EXISTS "accounts_lastActiveAt_idx";

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "custom_field_definitions" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT,
    "defaultNoticeDays" INTEGER,
    "defaultAutoRenewal" BOOLEAN,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "categories_accountId_archivedAt_displayOrder_idx" ON "categories"("accountId", "archivedAt", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "categories_accountId_slug_key" ON "categories"("accountId", "slug");

-- CreateIndex
CREATE INDEX "contracts_accountId_categoryId_idx" ON "contracts"("accountId", "categoryId");

-- CreateIndex
CREATE INDEX "custom_field_definitions_accountId_categoryId_idx" ON "custom_field_definitions"("accountId", "categoryId");

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
-- 2026-05-11: wrapped in a DO block with EXISTS check so the rename doesn't
-- fail on demo if the old index name was already updated by a manual op or
-- isn't present. Same drift caveat as the DropIndex above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'custom_field_definitions_account_active_order_idx') THEN
    ALTER INDEX "custom_field_definitions_account_active_order_idx" RENAME TO "custom_field_definitions_accountId_archivedAt_displayOrder_idx";
  END IF;
END $$;
