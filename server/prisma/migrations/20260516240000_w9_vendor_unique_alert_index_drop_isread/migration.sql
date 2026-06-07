-- Wave 9 audit migrations (2026-05-16)
--
-- 1. Vendor (accountId, name) unique constraint â€” closes the syncEngine
--    duplicate-create race when two parallel imports / nightly syncs hit
--    the same vendor name in the same account. Dry-run against demo
--    surfaced one existing duplicate ("Aramark Uniform Services" twice
--    in the demo seed account from a seed-script race), so the
--    migration first dedups by keeping the oldest row per
--    (accountId, name) and reassigning every referencing row to the
--    keeper.
--
-- 2. Alert composite index for the dedup query (contractId + alertType
--    + daysBeforeEnd + status). Pre-fix the dedup did a ~2k-row scan
--    per account on the contractId index. New index makes it O(log n).
--
-- 3. Drop the deprecated VendorNews.isRead column. Was a per-row flag
--    that affected every user in the account; replaced by the
--    UserNewsRead per-user join table 2026-05-02. No code path reads
--    or writes the column any more (grep confirmed).

-- ===== Step 1a: dedup vendors that share (accountId, name) =====
-- Build a list of (drop_id, keeper_id) for every duplicate cluster.
-- keeper = oldest row by createdAt (tie-broken by id).
CREATE TEMPORARY TABLE _w9_vendor_dedup AS
SELECT
  v.id        AS drop_id,
  k.keeper_id
FROM (
  SELECT
    id,
    "accountId",
    name,
    "createdAt",
    ROW_NUMBER() OVER (PARTITION BY "accountId", name ORDER BY "createdAt", id) AS rn
  FROM vendors
) v
JOIN (
  SELECT
    "accountId",
    name,
    (array_agg(id ORDER BY "createdAt", id))[1] AS keeper_id
  FROM vendors
  GROUP BY "accountId", name
  HAVING COUNT(*) > 1
) k
ON v."accountId" = k."accountId" AND v.name = k.name AND v.rn > 1;

-- Reassign every FK reference from the drop rows to the keeper row.
UPDATE contracts
   SET "vendorId" = d.keeper_id
  FROM _w9_vendor_dedup d
 WHERE contracts."vendorId" = d.drop_id;

UPDATE communications
   SET "vendorId" = d.keeper_id
  FROM _w9_vendor_dedup d
 WHERE communications."vendorId" = d.drop_id;

UPDATE vendor_contacts
   SET "vendorId" = d.keeper_id
  FROM _w9_vendor_dedup d
 WHERE vendor_contacts."vendorId" = d.drop_id;

UPDATE vendor_news
   SET "vendorId" = d.keeper_id
  FROM _w9_vendor_dedup d
 WHERE vendor_news."vendorId" = d.drop_id;

-- Now safe to delete the surplus vendor rows.
DELETE FROM vendors
 WHERE id IN (SELECT drop_id FROM _w9_vendor_dedup);

-- ===== Step 1b: add the unique constraint =====
CREATE UNIQUE INDEX "vendors_accountId_name_key" ON "vendors"("accountId", "name");

-- ===== Step 2: composite alerts index =====
CREATE INDEX "alerts_contractId_alertType_daysBeforeEnd_status_idx"
    ON "alerts"("contractId", "alertType", "daysBeforeEnd", "status");

-- ===== Step 3: drop the deprecated vendor_news.isRead column =====
ALTER TABLE "vendor_news" DROP COLUMN IF EXISTS "isRead";