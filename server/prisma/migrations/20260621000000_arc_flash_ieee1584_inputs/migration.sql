-- IEEE 1584-2018 calculation inputs on arc-flash study asset bindings.
-- Additive: powers incident-energy trending + the >40 cal/cm2 DANGER threshold
-- + what-if recompute when a protective device changes. All nullable.
ALTER TABLE "system_study_assets"
  ADD COLUMN "boltedFaultCurrentKA" DECIMAL(10,2),
  ADD COLUMN "arcingCurrentKA"      DECIMAL(10,2),
  ADD COLUMN "electrodeConfig"      TEXT,
  ADD COLUMN "conductorGapMm"       DECIMAL(6,1),
  ADD COLUMN "clearingTimeMs"       DECIMAL(10,1),
  ADD COLUMN "upstreamDevice"       TEXT;