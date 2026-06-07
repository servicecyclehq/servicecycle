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

export const EQUIPMENT_TYPE_LABELS = {
  TRANSFORMER_LIQUID:   'Transformer (Liquid)',
  TRANSFORMER_DRY:      'Transformer (Dry)',
  SWITCHGEAR:           'Switchgear',
  GENERATOR:            'Generator',
  MOTOR:                'Motor',
  MCC:                  'MCC',
  UPS_BATTERY:          'UPS / Battery',
  CIRCUIT_BREAKER:      'Circuit Breaker',
  ARC_FLASH_PANEL:      'Arc Flash Panel',
  VFD:                  'VFD',
  FIRE_PUMP_CONTROLLER: 'Fire Pump Controller',
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

/** House date format — "Jan 5, 2026"; em-dash for blank. */
export function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
