-- Slice 2.7+ "build it out": persist the protective-device + feeder-cable record
-- on the durable per-study per-equipment binding so each study revision keeps its
-- own snapshot (the year-over-year track) instead of confirm() dropping the
-- field-collected device/cable. Purely additive; mirrors arc_flash_ingest_buses.

ALTER TABLE "system_study_assets"
  ADD COLUMN "deviceType" TEXT,
  ADD COLUMN "deviceManufacturer" TEXT,
  ADD COLUMN "deviceModel" TEXT,
  ADD COLUMN "deviceRatingA" DECIMAL(10,1),
  ADD COLUMN "deviceSettings" JSONB,
  ADD COLUMN "cableLengthFt" DECIMAL(10,1),
  ADD COLUMN "cableSize" TEXT,
  ADD COLUMN "cableMaterial" TEXT;
