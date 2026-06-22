-- Slice 2.6: arc-flash data-collection reality (per the field-PE review).
-- A study's hard inputs are the upstream PROTECTIVE DEVICE ratings + settings
-- (collected down to 480V panels; clearing time is derived from these via the
-- device TCC) and the FEEDER CABLE length/size (impedance -> downstream fault
-- current). Purely additive to the draft (ingest) layer.

ALTER TABLE "arc_flash_ingest_buses"
  ADD COLUMN "deviceType" TEXT,
  ADD COLUMN "deviceManufacturer" TEXT,
  ADD COLUMN "deviceModel" TEXT,
  ADD COLUMN "deviceRatingA" DECIMAL(10,1),
  ADD COLUMN "deviceSettings" JSONB,
  ADD COLUMN "cableLengthFt" DECIMAL(10,1),
  ADD COLUMN "cableSize" TEXT,
  ADD COLUMN "cableMaterial" TEXT;
