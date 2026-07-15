-- feature/datacenter-multisource : data-center multi-source / backup-power topology.
--
-- ADDITIVE + NON-BREAKING. Authored, NOT applied (do not run migrate deploy/dev on
-- this review branch). Adds:
--   1. 7 new EquipmentType enum values (data-center classes).
--   2. The asset_feeds table (the AssetFeed multi-source edge model). Asset.fedFromAssetId
--      stays the normal/primary tree edge; asset_feeds adds the extra source edges a tree
--      cannot express (dual utility, A/B trains, ATS/STS transfer, UPS/gen/BESS backup,
--      dual-corded loads).
--   3. accountId + siteId FKs ON DELETE CASCADE (Prisma-managed via @relation) so deleting
--      the demo account cascades these rows -> the prod reseed's account-delete is auto-safe
--      (contrast PartnerEventLog 2026-07-16, whose non-cascading accountId broke the reseed).
--      loadAssetId/sourceAssetId/transferAssetId are intentionally NOT FKs (scalar graph
--      edges) to avoid multiple cascade paths into assets and keep edge lifecycle app-managed.
--   4. A backfill: one asset_feeds row per existing Asset.fedFromAssetId
--      (role='normal', sourceKind='derived', side=null) so the graph is complete on day one.
--
-- IF NOT EXISTS on the enum adds = idempotent (repo convention). ADD VALUE runs fine in a
-- PG12+ transaction because the new values are not consumed in this same migration.

-- AlterEnum
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'UTILITY_SERVICE';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'STATIC_TRANSFER_SWITCH';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'PARALLELING_SWITCHGEAR';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'REMOTE_POWER_PANEL';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'POWER_DISTRIBUTION_UNIT';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'MECHANICAL_LOAD';
ALTER TYPE "EquipmentType" ADD VALUE IF NOT EXISTS 'IT_RACK';

-- CreateTable
CREATE TABLE "asset_feeds" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "loadAssetId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "side" TEXT,
    "sourceKind" TEXT NOT NULL,
    "transferAssetId" TEXT,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_feeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "asset_feeds_accountId_siteId_idx" ON "asset_feeds"("accountId", "siteId");

-- CreateIndex
CREATE INDEX "asset_feeds_loadAssetId_idx" ON "asset_feeds"("loadAssetId");

-- CreateIndex
CREATE INDEX "asset_feeds_sourceAssetId_idx" ON "asset_feeds"("sourceAssetId");

-- AddForeignKey
ALTER TABLE "asset_feeds" ADD CONSTRAINT "asset_feeds_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_feeds" ADD CONSTRAINT "asset_feeds_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: mirror every existing normal/primary tree edge (Asset.fedFromAssetId) into
-- asset_feeds so the redundancy graph starts complete. Additive; safe to re-run only on a
-- fresh table (guard with the NOT EXISTS below so a re-apply does not double-insert).
INSERT INTO "asset_feeds" ("id", "accountId", "siteId", "loadAssetId", "sourceAssetId", "role", "side", "sourceKind", "seq", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."accountId", a."siteId", a."id", a."fedFromAssetId", 'normal', NULL, 'derived', 0, now(), now()
FROM "assets" a
WHERE a."fedFromAssetId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "asset_feeds" f
    WHERE f."loadAssetId" = a."id" AND f."sourceAssetId" = a."fedFromAssetId" AND f."role" = 'normal'
  );
