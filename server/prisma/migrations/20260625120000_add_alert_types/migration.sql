-- Add new alert types to the AlertType enum
-- These power the configurable alert system (condition_degradation,
-- deficiency_alert, arc_flash_expiry, asset_decommission).
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'condition_degradation';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'deficiency_alert';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'arc_flash_expiry';
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'asset_decommission';
