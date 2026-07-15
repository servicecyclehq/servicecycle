/**
 * lib/equipmentTypes.ts — THE canonical EquipmentType list.
 *
 * Single source of truth mirroring the EquipmentType enum in
 * prisma/schema.prisma (same order). This list was previously hand-copied
 * into five route files and drifted twice during enum expansions; every
 * server-side consumer now imports from here instead:
 *
 *   routes/assets.ts        — create/update zod enum + list filter guard
 *   routes/bootstrap.ts     — list filter guard + equipmentTypes payload
 *   routes/assetsImport.ts  — import vocabulary (labels + fuzzy matching)
 *   routes/v1/assets.ts     — public API query-param enum
 *   routes/schedules.ts     — bulk-apply filter guard
 *   routes/standards.ts     — task-definition CRUD enum
 *   lib/photoInspect.ts     — AI nameplate-extraction vocabulary
 *
 * NOTE for plain-JS scripts (scripts/seed-*.js run under `node`, which cannot
 * require .ts): they reference enum values literally — when the enum grows,
 * update schema.prisma, THIS file, and check the seed scripts.
 *
 * Display labels are the server-side mirror of
 * client/src/lib/equipment.js EQUIPMENT_TYPE_LABELS — keep in sync.
 */

// Matches prisma/schema.prisma enum EquipmentType ORDER exactly.
const EQUIPMENT_TYPE_LABELS: Record<string, string> = {
  TRANSFORMER_LIQUID:      'Transformer (Liquid)',
  TRANSFORMER_DRY:         'Transformer (Dry)',
  SWITCHGEAR:              'Switchgear',
  SWITCHBOARD:             'Switchboard',
  PANELBOARD:              'Panelboard',
  BUSWAY:                  'Busway',
  GENERATOR:               'Generator',
  MOTOR:                   'Motor',
  MCC:                     'MCC',
  VFD:                     'VFD',
  UPS_BATTERY:             'UPS / Battery',
  BATTERY_SYSTEM:          'Battery System',
  CIRCUIT_BREAKER:         'Circuit Breaker',
  FUSE_GEAR:               'Fuse Gear',
  DISCONNECT_SWITCH:       'Disconnect Switch',
  TRANSFER_SWITCH:         'Transfer Switch (ATS)',
  PROTECTION_RELAY:        'Protection Relay',
  GROUND_FAULT_PROTECTION: 'Ground Fault Protection',
  SURGE_ARRESTER:          'Surge Arrester',
  CABLE_LV:                'Cable (LV)',
  CABLE_MV_HV:             'Cable (MV/HV)',
  CABLE_TRAY:              'Cable Tray',
  GROUNDING_SYSTEM:        'Grounding System',
  EMERGENCY_LIGHTING:      'Emergency Lighting',
  ARC_FLASH_PANEL:         'Arc Flash Panel',
  FIRE_PUMP_CONTROLLER:    'Fire Pump Controller',
  UTILITY_SERVICE:         'Utility Service Entrance',
  STATIC_TRANSFER_SWITCH:  'Static Transfer Switch (STS)',
  PARALLELING_SWITCHGEAR:  'Paralleling Switchgear',
  REMOTE_POWER_PANEL:      'Remote Power Panel (RPP)',
  POWER_DISTRIBUTION_UNIT: 'Power Distribution Unit (PDU)',
  MECHANICAL_LOAD:         'Mechanical Load (CRAH/CRAC/Chiller)',
  IT_RACK:                 'IT Rack',
};

// Enum values in schema order — derived from the label map so the two can
// never disagree.
const EQUIPMENT_TYPES: string[] = Object.keys(EQUIPMENT_TYPE_LABELS);

module.exports = { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABELS };

export {};
