-- Slice C: promote electrodeConfig String -> ElectrodeConfig enum (IEEE 1584-2018).
-- The five conductor/electrode arrangements; column was a free String.

-- CreateEnum
CREATE TYPE "ElectrodeConfig" AS ENUM ('VCB', 'VCBB', 'HCB', 'VOA', 'HOA');

-- Defensive: null out any legacy values that aren't one of the five so the USING
-- cast can't fail on dirty data (the app already validated to these, so expect 0).
UPDATE "system_study_assets"    SET "electrodeConfig" = NULL WHERE "electrodeConfig" IS NOT NULL AND "electrodeConfig" NOT IN ('VCB', 'VCBB', 'HCB', 'VOA', 'HOA');
UPDATE "arc_flash_ingest_buses" SET "electrodeConfig" = NULL WHERE "electrodeConfig" IS NOT NULL AND "electrodeConfig" NOT IN ('VCB', 'VCBB', 'HCB', 'VOA', 'HOA');

-- AlterTable: change the column type with an explicit cast.
ALTER TABLE "system_study_assets"    ALTER COLUMN "electrodeConfig" TYPE "ElectrodeConfig" USING "electrodeConfig"::"ElectrodeConfig";
ALTER TABLE "arc_flash_ingest_buses" ALTER COLUMN "electrodeConfig" TYPE "ElectrodeConfig" USING "electrodeConfig"::"ElectrodeConfig";
