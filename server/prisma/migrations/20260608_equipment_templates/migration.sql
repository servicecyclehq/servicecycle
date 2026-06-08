-- Migration: 20260608_equipment_templates
-- Equipment Template Library: AssetTemplate + AssetTemplateTask + global seed rows.

-- ── Tables ────────────────────────────────────────────────────────────────────

CREATE TABLE asset_templates (
  id                                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                           UUID        REFERENCES accounts(id) ON DELETE CASCADE,
  name                                 TEXT        NOT NULL,
  description                          TEXT,
  equipment_type                       "EquipmentType" NOT NULL,
  default_criticality_score            INT,
  default_redundancy_status            TEXT,
  default_requires_predictive_maintenance BOOLEAN  NOT NULL DEFAULT FALSE,
  nameplate_defaults                   JSONB,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asset_templates_account_id    ON asset_templates(account_id);
CREATE INDEX idx_asset_templates_equipment_type ON asset_templates(equipment_type);

CREATE TABLE asset_template_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         UUID NOT NULL REFERENCES asset_templates(id) ON DELETE CASCADE,
  task_definition_id  UUID NOT NULL REFERENCES maintenance_task_definitions(id) ON DELETE CASCADE,
  UNIQUE(template_id, task_definition_id)
);

-- ── Global seed templates ─────────────────────────────────────────────────────
-- These rows have account_id = NULL and are visible to all tenants.
-- Task associations are populated in the seed script (post-migration) because
-- task definition IDs are non-deterministic UUIDs — we join by taskCode here.

-- Pad-Mount Liquid-Filled Transformer
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000001',
  NULL,
  'Liquid-Filled Transformer',
  'Pad-mount or substation liquid-filled power transformer. NFPA 70B + IEEE C57.104 oil sampling required.',
  'TRANSFORMER_LIQUID',
  4,
  TRUE,
  '{"kVA": "", "primaryVoltage": "", "secondaryVoltage": "", "impedance": "", "fluidType": "Mineral oil", "fluidVolumeLiters": ""}'
);

-- Dry-Type Transformer
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000002',
  NULL,
  'Dry-Type Transformer',
  'Indoor ventilated or encapsulated dry-type transformer. NFPA 70B visual + IR thermography.',
  'TRANSFORMER_DRY',
  3,
  FALSE,
  '{"kVA": "", "primaryVoltage": "", "secondaryVoltage": "", "insulationClass": "", "temperatureRise": ""}'
);

-- Metal-Clad Switchgear
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000003',
  NULL,
  'Metal-Clad Switchgear',
  'Medium-voltage or LV metal-clad switchgear. NETA MTS mechanical/dielectric + IR scan.',
  'SWITCHGEAR',
  5,
  FALSE,
  '{"voltageRating": "", "continuousCurrentRating": "", "shortCircuitRating": "", "manufacturer": "", "numBays": ""}'
);

-- Motor Control Center
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000004',
  NULL,
  'Motor Control Center (MCC)',
  'Low-voltage MCC with combination starters and feeder sections. IR thermography + insulation resistance.',
  'MCC',
  3,
  FALSE,
  '{"voltageRating": "480V", "busBarRating": "", "shortCircuitRating": "", "numSections": ""}'
);

-- Emergency Standby Generator
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_redundancy_status, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000005',
  NULL,
  'Emergency Standby Generator',
  'Diesel or gas standby generator. NFPA 110 monthly load test + annual full-load transfer test.',
  'GENERATOR',
  5,
  'N_PLUS_1',
  FALSE,
  '{"kW": "", "kVA": "", "voltage": "480V", "fuelType": "Diesel", "tankCapacityGallons": "", "runtimeHoursAtFullLoad": ""}'
);

-- Automatic Transfer Switch
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_redundancy_status, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000006',
  NULL,
  'Automatic Transfer Switch (ATS)',
  'Life-safety ATS for generator feed. NFPA 110/99 monthly transfer + annual load test.',
  'TRANSFER_SWITCH',
  5,
  'N_PLUS_1',
  FALSE,
  '{"ampRating": "", "voltageRating": "480V", "poles": "", "class": "", "type": "Open / closed transition"}'
);

-- UPS System
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000007',
  NULL,
  'UPS System',
  'Online double-conversion UPS. Battery capacity test + autonomy test per IEEE 1188.',
  'UPS_BATTERY',
  4,
  TRUE,
  '{"kVA": "", "kW": "", "inputVoltage": "", "outputVoltage": "", "batteryType": "VRLA", "runtimeMinutes": ""}'
);

-- Panelboard
INSERT INTO asset_templates (id, account_id, name, description, equipment_type,
  default_criticality_score, default_requires_predictive_maintenance, nameplate_defaults)
VALUES (
  '00000000-0000-0000-0001-000000000008',
  NULL,
  'Panelboard',
  'Lighting or power distribution panelboard. IR thermography + insulation resistance sweep.',
  'PANELBOARD',
  2,
  FALSE,
  '{"ampRating": "", "voltageRating": "120/208V", "phases": "3", "spaces": "", "mainBreakerAmps": ""}'
);
