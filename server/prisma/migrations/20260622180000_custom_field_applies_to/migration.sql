-- Slice H: custom-field definitions can target the arc-flash equipment long tail.
-- null/"asset" = a general asset field (existing behavior); "arc_flash" = a field
-- surfaced in the per-asset Arc Flash tab. Values stay on the asset-scoped table.
ALTER TABLE "custom_field_definitions" ADD COLUMN "appliesTo" TEXT;
