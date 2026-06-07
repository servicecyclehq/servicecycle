-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EquipmentType" ADD VALUE 'SWITCHBOARD';
ALTER TYPE "EquipmentType" ADD VALUE 'PANELBOARD';
ALTER TYPE "EquipmentType" ADD VALUE 'BUSWAY';
ALTER TYPE "EquipmentType" ADD VALUE 'BATTERY_SYSTEM';
ALTER TYPE "EquipmentType" ADD VALUE 'FUSE_GEAR';
ALTER TYPE "EquipmentType" ADD VALUE 'DISCONNECT_SWITCH';
ALTER TYPE "EquipmentType" ADD VALUE 'TRANSFER_SWITCH';
ALTER TYPE "EquipmentType" ADD VALUE 'PROTECTION_RELAY';
ALTER TYPE "EquipmentType" ADD VALUE 'GROUND_FAULT_PROTECTION';
ALTER TYPE "EquipmentType" ADD VALUE 'SURGE_ARRESTER';
ALTER TYPE "EquipmentType" ADD VALUE 'CABLE_LV';
ALTER TYPE "EquipmentType" ADD VALUE 'CABLE_MV_HV';
ALTER TYPE "EquipmentType" ADD VALUE 'CABLE_TRAY';
ALTER TYPE "EquipmentType" ADD VALUE 'GROUNDING_SYSTEM';
ALTER TYPE "EquipmentType" ADD VALUE 'EMERGENCY_LIGHTING';

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "criticalityScore" INTEGER,
ADD COLUMN     "redundancyStatus" TEXT,
ADD COLUMN     "repairCostEstimate" DECIMAL(14,2),
ADD COLUMN     "requiresPredictiveMaintenance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "spareLeadTimeWeeks" INTEGER;

