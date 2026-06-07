-- Category-conditional fields (contract-section-refresh)
-- 1. Nullable native lease columns on contracts. Surfaced in the edit form +
--    detail view only for the hardware + lease_rent categories; stored for all.
ALTER TABLE "contracts"
  ADD COLUMN "leaseStart" TIMESTAMP(3),
  ADD COLUMN "leaseEnd" TIMESTAMP(3),
  ADD COLUMN "leaseType" TEXT,
  ADD COLUMN "leaseBuyout" DECIMAL(14,2);

-- 2. Seed the new "Facilities" system category for every account missing it.
--    Mirrors server/scripts/seed-categories.js (kept in sync for new accounts).
INSERT INTO "categories" (
  "id", "accountId", "name", "slug", "icon", "color",
  "defaultNoticeDays", "defaultAutoRenewal", "isSystemDefault", "displayOrder",
  "createdById", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), a."id", 'Facilities', 'facilities', '🧰', '#0ea5e9',
       60, true, true, 55, NULL, NOW(), NOW()
FROM "accounts" a
WHERE NOT EXISTS (
  SELECT 1 FROM "categories" c WHERE c."accountId" = a."id" AND c."slug" = 'facilities'
);
