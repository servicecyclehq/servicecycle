-- CreateTable: asset_part_requirements
-- Links a Part to an Asset as a "required spare" with a quantity threshold.
-- Drives the Required Parts panel (AssetDetail) and Parts Alerts dashboard card.

CREATE TABLE "asset_part_requirements" (
    "id"          TEXT NOT NULL,
    "accountId"   TEXT NOT NULL,
    "assetId"     TEXT NOT NULL,
    "partId"      TEXT NOT NULL,
    "qtyRequired" INTEGER NOT NULL DEFAULT 1,
    "notes"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_part_requirements_pkey" PRIMARY KEY ("id")
);

-- Unique: one requirement record per (asset, part) pair
CREATE UNIQUE INDEX "asset_part_requirements_assetId_partId_key"
    ON "asset_part_requirements"("assetId", "partId");

-- Lookup indexes
CREATE INDEX "asset_part_requirements_accountId_idx" ON "asset_part_requirements"("accountId");
CREATE INDEX "asset_part_requirements_assetId_idx"   ON "asset_part_requirements"("assetId");
CREATE INDEX "asset_part_requirements_partId_idx"    ON "asset_part_requirements"("partId");

-- Foreign keys
ALTER TABLE "asset_part_requirements"
    ADD CONSTRAINT "asset_part_requirements_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_part_requirements"
    ADD CONSTRAINT "asset_part_requirements_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_part_requirements"
    ADD CONSTRAINT "asset_part_requirements_partId_fkey"
    FOREIGN KEY ("partId") REFERENCES "parts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
