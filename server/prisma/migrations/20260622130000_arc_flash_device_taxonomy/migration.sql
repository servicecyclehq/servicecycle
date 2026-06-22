-- Schema-bootstrap slice 1: arc-flash device taxonomy (from ARC_FLASH_DOMAIN_MODEL.md).
-- Adds the trip-unit-type + fuse-class enums and additive nullable columns on the
-- three arc-flash models. tripUnitType is what makes the "settings required?" rule
-- correct: only electronic_lsi/lsig (and relays) need recorded settings; thermal-mag
-- breakers, fuses, and switches derive clearing time from the published TCC.

-- CreateEnum
CREATE TYPE "TripUnitType" AS ENUM ('none', 'thermal_magnetic', 'electronic_lsi', 'electronic_lsig');

-- CreateEnum
CREATE TYPE "FuseClass" AS ENUM ('L', 'RK1', 'RK5', 'J', 'T', 'CC', 'G', 'CF', 'H', 'K', 'other');

-- AlterTable
ALTER TABLE "arc_flash_ingest_buses"
  ADD COLUMN "tripUnitType" "TripUnitType",
  ADD COLUMN "fuseClass" "FuseClass";

-- AlterTable
ALTER TABLE "system_study_assets"
  ADD COLUMN "tripUnitType" "TripUnitType",
  ADD COLUMN "fuseClass" "FuseClass";

-- AlterTable
ALTER TABLE "protective_devices"
  ADD COLUMN "tripUnitType" "TripUnitType",
  ADD COLUMN "fuseClass" "FuseClass";
