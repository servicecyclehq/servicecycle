-- Parts catalog + SpareInventory (Chunk 4) -- idempotent create.
--
-- The original 20260623120000_parts_spare_inventory migration shipped EMPTY, so
-- on any environment migrated from committed history the `parts` /
-- `spare_inventory` tables were never created and every /api/parts write 500'd.
-- That empty migration is deliberately LEFT empty: if an environment already
-- recorded it, its checksum is fixed, and changing the file would make
-- `prisma migrate deploy` fail with "migration was modified after applied".
--
-- This follow-up migration creates the tables idempotently: CREATE TABLE /
-- CREATE INDEX IF NOT EXISTS plus pg_constraint-guarded foreign keys, so it
-- applies cleanly whether or not the tables already exist on a given
-- environment. The DDL matches the Prisma Part + SpareInventory models exactly
-- (columns, 7 indexes, 5 FKs with onDelete: parts.account Cascade;
-- spare_inventory -> part Cascade, -> asset SetNull, -> site SetNull).

-- CreateTable
CREATE TABLE IF NOT EXISTS "parts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "manufacturer" TEXT,
    "category" TEXT,
    "unitCost" DECIMAL(14,2),
    "leadTimeWeeks" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "spare_inventory" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "assetId" TEXT,
    "siteId" TEXT,
    "qtyOnHand" INTEGER NOT NULL DEFAULT 0,
    "qtyMin" INTEGER,
    "location" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spare_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "parts_accountId_idx" ON "parts"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "parts_accountId_category_idx" ON "parts"("accountId", "category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "parts_accountId_partNumber_idx" ON "parts"("accountId", "partNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spare_inventory_accountId_idx" ON "spare_inventory"("accountId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spare_inventory_partId_idx" ON "spare_inventory"("partId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spare_inventory_assetId_idx" ON "spare_inventory"("assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spare_inventory_siteId_idx" ON "spare_inventory"("siteId");

-- AddForeignKey (guarded -- ALTER TABLE ADD CONSTRAINT is not idempotent on its own)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parts_accountId_fkey') THEN
    ALTER TABLE "parts" ADD CONSTRAINT "parts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spare_inventory_accountId_fkey') THEN
    ALTER TABLE "spare_inventory" ADD CONSTRAINT "spare_inventory_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spare_inventory_partId_fkey') THEN
    ALTER TABLE "spare_inventory" ADD CONSTRAINT "spare_inventory_partId_fkey" FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spare_inventory_assetId_fkey') THEN
    ALTER TABLE "spare_inventory" ADD CONSTRAINT "spare_inventory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spare_inventory_siteId_fkey') THEN
    ALTER TABLE "spare_inventory" ADD CONSTRAINT "spare_inventory_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
