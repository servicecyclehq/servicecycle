-- H2 (audit High, 2026-05-22): add unique indexes for alert + contract
-- dedup at the DB level.
--
-- (1) alerts: createMany({skipDuplicates:true}) in alertEngine.js was a
--     no-op without this -- two concurrent runs could insert the same
--     fire row twice.
-- (2) contracts: syncEngine.js findFirst+create had a TOCTOU race when
--     two sync runs hit the same external row at once. Postgres treats
--     NULL as not-equal-to-NULL, so manually-created contracts (where
--     both syncSource AND externalId are null) never collide; only
--     sync'd rows (where both are populated) are uniqued.
--
-- Existing data: a one-off dedup pass before this migration runs is NOT
-- needed because:
--   - the in-memory firedNonPayment Set in alertEngine prevented
--     within-run duplicates from ever landing; cross-run duplicates
--     would only happen if two engine processes ran concurrently, which
--     has never been the case (single-process pm2 + single-droplet).
--   - contracts: syncEngine.findFirst() before create() already prevents
--     duplicates in serial-run cases. We've never had multiple sync
--     workers.
-- If the index creation finds a duplicate, the migration will fail
-- loudly and the operator needs to manually de-dup before re-running.
-- Spot-check on the demo droplet pre-migration showed zero duplicates
-- in either table.

CREATE UNIQUE INDEX "alerts_contractId_alertType_daysBeforeEnd_key"
  ON "alerts" ("contractId", "alertType", "daysBeforeEnd");

CREATE UNIQUE INDEX "contracts_accountId_syncSource_externalId_key"
  ON "contracts" ("accountId", "syncSource", "externalId");
