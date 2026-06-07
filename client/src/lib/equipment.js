// ─────────────────────────────────────────────────────────────────────────────
// lib/equipment.js — shared ServiceCycle equipment-domain constants.
//
// Single source of truth for the NFPA 70B / NETA vocabulary the Assets
// surfaces render: equipment-type labels, condition-of-maintenance metadata
// (C1/C2/C3), work-order lifecycle chips, deficiency severities, NETA decal
// colors, plus the assetLabel()/fmtDate() helpers every asset page shares.
//
// Color values are literal hexes (not CSS vars) because the condition/decal
// palette is a domain convention (green/amber/red traffic light), not a
// theme-dependent accent — they must read identically in light + dark mode
// the way a physical NETA decal would.
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors the server's 26-value EquipmentType enum (prisma/schema.prisma),
// in the same order. Every key must exist here — selects enumerate this map.
export const EQUIPMENT_TYPE_LABELS = {
  TRANSFORMER_LIQUID:      'Transformer (Liquid)',
  TRANSFORMER_DRY:         'Transformer (Dry)',
  SWITCHGEAR:              'Switchgear',
  SWITCHBOARD:             'Switchboard',
  PANELBOARD:              'Panelboard',
  BUSWAY:                  'Busway / Bus Duct',
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
};

// Power-path redundancy at the asset's position. N = single point of failure
// (red), N+1 = one spare path (amber), 2N = fully duplicated (green).
export const REDUNDANCY_META = {
  N:        { label: 'N (no redundancy)', color: '#dc2626', bg: '#fef2f2' },
  N_PLUS_1: { label: 'N+1',               color: '#d97706', bg: '#fffbeb' },
  TWO_N:    { label: '2N',                color: '#16a34a', bg: '#f0fdf4' },
};

// Business-impact criticality score (1–5). Labels describe the consequence of
// failure; colors escalate red-ward as the score climbs.
export const CRITICALITY_SCORE_META = {
  5: { label: 'Failure = injury / shutdown / fines',   color: '#dc2626', bg: '#fef2f2' },
  4: { label: 'Major disruption to operations',        color: '#ea580c', bg: '#fff7ed' },
  3: { label: 'Moderate disruption, workaround exists', color: '#d97706', bg: '#fffbeb' },
  2: { label: 'Minor inconvenience',                   color: '#64748b', bg: '#f1f5f9' },
  1: { label: 'Minimal impact',                        color: '#94a3b8', bg: '#f8fafc' },
};

// NFPA 70B:2023 condition of maintenance. The governing condition is the
// WORST of the three assessment axes (physical / criticality / environment)
// and selects the maintenance interval column on each task definition.
export const CONDITION_META = {
  C1: { label: 'C1 — Good', color: '#16a34a', bg: '#f0fdf4' },
  C2: { label: 'C2 — Fair', color: '#d97706', bg: '#fffbeb' },
  C3: { label: 'C3 — Poor', color: '#dc2626', bg: '#fef2f2' },
};

export const WO_STATUS_META = {
  SCHEDULED:   { label: 'Scheduled',   color: '#2563eb', bg: '#eff6ff' },
  IN_PROGRESS: { label: 'In Progress', color: '#d97706', bg: '#fffbeb' },
  COMPLETE:    { label: 'Complete',    color: '#16a34a', bg: '#f0fdf4' },
  CANCELLED:   { label: 'Cancelled',   color: '#64748b', bg: '#f1f5f9' },
};

export const SEVERITY_META = {
  IMMEDIATE:   { label: 'Immediate',   color: '#dc2626', bg: '#fef2f2' },
  RECOMMENDED: { label: 'Recommended', color: '#d97706', bg: '#fffbeb' },
  ADVISORY:    { label: 'Advisory',    color: '#64748b', bg: '#f1f5f9' },
};

// NETA decal / lab-sample ResultRating, relabeled to NETA service terms.
// Note: NETA's physical "Serviceable" decal is WHITE — we keep the green
// accent on screen because white carries no signal against a light UI.
export const DECAL_META = {
  GREEN:  { label: 'Serviceable',     color: '#16a34a', bg: '#f0fdf4' },
  YELLOW: { label: 'Limited Service', color: '#d97706', bg: '#fffbeb' },
  RED:    { label: 'Non-serviceable', color: '#dc2626', bg: '#fef2f2' },
};

// Engineering system studies tracked per site (audit-readiness).
export const STUDY_TYPE_LABELS = {
  arc_flash:       'Arc Flash / Incident Energy',
  short_circuit:   'Short-Circuit Study',
  coordination:    'Coordination Study',
  one_line_review: 'One-Line Diagram Review',
};

// IEEE C57.104 DGA condition status for transformer lab samples.
export const IEEE_STATUS_META = {
  1: { label: 'Normal',          color: '#16a34a', bg: '#f0fdf4' },
  2: { label: 'Caution',         color: '#d97706', bg: '#fffbeb' },
  3: { label: 'Action required', color: '#dc2626', bg: '#fef2f2' },
};

/**
 * Human label for an asset: "Square D QED-2 #SN-4417" style — manufacturer +
 * model + serial, falling back to the equipment-type label when the
 * nameplate identity fields are all blank.
 */
export function assetLabel(asset) {
  if (!asset) return '';
  const parts = [asset.manufacturer, asset.model].filter(Boolean);
  let label = parts.join(' ');
  if (asset.serialNumber) label = label ? `${label} #${asset.serialNumber}` : `#${asset.serialNumber}`;
  return label || EQUIPMENT_TYPE_LABELS[asset.equipmentType] || asset.equipmentType || 'Asset';
}

/**
 * House money format — "$12,500" (cents only when present); em-dash for
 * blank/unparseable. Accepts the server's decimal strings or numbers.
 */
export function fmtMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

/** House date format — "Jan 5, 2026"; em-dash for blank. */
export function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
