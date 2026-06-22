-- Schema-bootstrap slices B + D + F (from ARC_FLASH_DOMAIN_MODEL.md).
-- B: outcome/label fields (arc rating, PPE method, shock approach boundaries, derived severity)
-- D: enclosure type + dimensions (IEEE 1584-2018 enclosure-size correction)
-- F: mitigation flags (ERMS/ZSI/differential/arc-resistant/NEC 240.87) + dual-scenario + calc method
-- All additive nullable columns + new enum types. Mirrored on the capture model
-- (arc_flash_ingest_buses) and the durable per-study record (system_study_assets).

-- CreateEnum
CREATE TYPE "PpeMethod" AS ENUM ('incident_energy', 'ppe_category');

-- CreateEnum
CREATE TYPE "LabelSeverity" AS ENUM ('warning', 'danger');

-- CreateEnum
CREATE TYPE "EnclosureType" AS ENUM ('panelboard', 'mcc', 'lv_switchgear', 'mv_switchgear', 'cable', 'open_air', 'other');

-- CreateEnum
CREATE TYPE "CalcMethod" AS ENUM ('ieee_1584_2018', 'lee_method', 'manufacturer_test');

-- AlterTable
ALTER TABLE "system_study_assets"
  ADD COLUMN "requiredArcRatingCalCm2" DECIMAL(10,2),
  ADD COLUMN "ppeMethod" "PpeMethod",
  ADD COLUMN "shockLimitedApproachIn" DECIMAL(10,1),
  ADD COLUMN "shockRestrictedApproachIn" DECIMAL(10,1),
  ADD COLUMN "labelSeverity" "LabelSeverity",
  ADD COLUMN "enclosureType" "EnclosureType",
  ADD COLUMN "enclosureHeightMm" DECIMAL(8,1),
  ADD COLUMN "enclosureWidthMm" DECIMAL(8,1),
  ADD COLUMN "enclosureDepthMm" DECIMAL(8,1),
  ADD COLUMN "ermsPresent" BOOLEAN,
  ADD COLUMN "zsiEnabled" BOOLEAN,
  ADD COLUMN "differentialPresent" BOOLEAN,
  ADD COLUMN "arcResistant" BOOLEAN,
  ADD COLUMN "nec24087Method" TEXT,
  ADD COLUMN "calcMethod" "CalcMethod",
  ADD COLUMN "arcingCurrentReducedKA" DECIMAL(10,2),
  ADD COLUMN "governingScenario" TEXT;

-- AlterTable
ALTER TABLE "arc_flash_ingest_buses"
  ADD COLUMN "requiredArcRatingCalCm2" DECIMAL(10,2),
  ADD COLUMN "ppeMethod" "PpeMethod",
  ADD COLUMN "shockLimitedApproachIn" DECIMAL(10,1),
  ADD COLUMN "shockRestrictedApproachIn" DECIMAL(10,1),
  ADD COLUMN "labelSeverity" "LabelSeverity",
  ADD COLUMN "enclosureType" "EnclosureType",
  ADD COLUMN "enclosureHeightMm" DECIMAL(8,1),
  ADD COLUMN "enclosureWidthMm" DECIMAL(8,1),
  ADD COLUMN "enclosureDepthMm" DECIMAL(8,1),
  ADD COLUMN "ermsPresent" BOOLEAN,
  ADD COLUMN "zsiEnabled" BOOLEAN,
  ADD COLUMN "differentialPresent" BOOLEAN,
  ADD COLUMN "arcResistant" BOOLEAN,
  ADD COLUMN "nec24087Method" TEXT,
  ADD COLUMN "calcMethod" "CalcMethod",
  ADD COLUMN "arcingCurrentReducedKA" DECIMAL(10,2),
  ADD COLUMN "governingScenario" TEXT;
