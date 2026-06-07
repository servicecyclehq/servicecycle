-- #8 contract-section-refresh: merge quantity + seatsLicensed into ONE linked value.
-- quantity is canonical; seatsLicensed mirrors it. The application layer keeps
-- them in lockstep on every write (routes/contracts.ts POST/PUT/renew). This
-- migration reconciles pre-existing rows so reports (which read seatsLicensed)
-- and the Financial card (which reads quantity) agree.

-- 1. Where quantity is null but seatsLicensed has a value, adopt seatsLicensed.
UPDATE "contracts"
  SET "quantity" = "seatsLicensed"
  WHERE "quantity" IS NULL AND "seatsLicensed" IS NOT NULL;

-- 2. Everywhere quantity is set, mirror it into seatsLicensed (quantity wins on divergence).
UPDATE "contracts"
  SET "seatsLicensed" = "quantity"
  WHERE "quantity" IS NOT NULL AND "seatsLicensed" IS DISTINCT FROM "quantity";

-- 3. Recompute denormalized totalValue for rows whose quantity changed in step 1.
UPDATE "contracts"
  SET "totalValue" = LEAST("costPerLicense" * "quantity", 999999999999.99)
  WHERE "quantity" IS NOT NULL AND "costPerLicense" IS NOT NULL;