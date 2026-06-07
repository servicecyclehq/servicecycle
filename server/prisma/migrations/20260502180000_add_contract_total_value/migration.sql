-- (A3 5/02) Denormalized contract total value (cost × qty).
-- Persisted at write time so the contracts list can sort by computed value
-- in the database rather than fetching every row and sorting in JS. NULL
-- when either factor is missing -- the application treats that as "no value".

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN "totalValue" DECIMAL(14, 2);

-- Backfill existing rows where both factors are present
UPDATE "contracts"
   SET "totalValue" = "costPerLicense" * "quantity"
 WHERE "costPerLicense" IS NOT NULL
   AND "quantity"       IS NOT NULL;

-- CreateIndex
CREATE INDEX "contracts_accountId_totalValue_idx"
  ON "contracts"("accountId", "totalValue");
