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
// Chip palette note (v0.93 UI pass; v0.95 fallbacks synced to the canonical
// AA-audited token values, stock-Tailwind blue retired -> petrol info): colors route through the semantic
// --chip-* CSS tokens declared in index.css so every pill stays AA-readable
// in BOTH themes (the old literal hexes were light-mode-only). The hex
// fallbacks preserve the previous light-mode look if a token is missing.
export const REDUNDANCY_META = {
  N:        { label: 'N (no redundancy)', color: 'var(--chip-red-fg, #991b1b)',   bg: 'var(--chip-red-bg, #fef2f2)' },
  N_PLUS_1: { label: 'N+1',               color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  TWO_N:    { label: '2N',                color: 'var(--chip-green-fg, #166534)', bg: 'var(--chip-green-bg, #f0fdf4)' },
};

// Business-impact criticality score (1–5). Labels describe the consequence of
// failure; colors escalate red-ward as the score climbs.
export const CRITICALITY_SCORE_META = {
  5: { label: 'Failure = injury / shutdown / fines',   color: 'var(--chip-red-fg, #991b1b)',        bg: 'var(--chip-red-bg, #fef2f2)' },
  4: { label: 'Major disruption to operations',        color: 'var(--chip-orange-fg, #9a3412)',     bg: 'var(--chip-orange-bg, #fff7ed)' },
  3: { label: 'Moderate disruption, workaround exists', color: 'var(--chip-amber-fg, #854d0e)',     bg: 'var(--chip-amber-bg, #fefce8)' },
  2: { label: 'Minor inconvenience',                   color: 'var(--chip-slate-fg, #334155)',      bg: 'var(--chip-slate-bg, #f1f5f9)' },
  1: { label: 'Minimal impact',                        color: 'var(--chip-slate-soft-fg, #475569)', bg: 'var(--chip-slate-soft-bg, #f8fafc)' },
};

// NFPA 70B:2023 condition of maintenance. The governing condition is the
// WORST of the three assessment axes (physical / criticality / environment)
// and selects the maintenance interval column on each task definition.
export const CONDITION_META = {
  C1: { label: 'C1 — Good', color: 'var(--chip-green-fg, #166534)', bg: 'var(--chip-green-bg, #f0fdf4)' },
  C2: { label: 'C2 — Fair', color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  C3: { label: 'C3 — Poor', color: 'var(--chip-red-fg, #991b1b)',   bg: 'var(--chip-red-bg, #fef2f2)' },
};

export const WO_STATUS_META = {
  SCHEDULED:   { label: 'Scheduled',   color: 'var(--chip-blue-fg, #0d4f6e)',  bg: 'var(--chip-blue-bg, #e6f0f5)' },
  IN_PROGRESS: { label: 'In Progress', color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  COMPLETE:    { label: 'Complete',    color: 'var(--chip-green-fg, #166534)', bg: 'var(--chip-green-bg, #f0fdf4)' },
  CANCELLED:   { label: 'Cancelled',   color: 'var(--chip-slate-fg, #334155)', bg: 'var(--chip-slate-bg, #f1f5f9)' },
};

export const SEVERITY_META = {
  IMMEDIATE:   { label: 'Immediate',   color: 'var(--chip-red-fg, #991b1b)',   bg: 'var(--chip-red-bg, #fef2f2)' },
  RECOMMENDED: { label: 'Recommended', color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  ADVISORY:    { label: 'Advisory',    color: 'var(--chip-slate-fg, #334155)', bg: 'var(--chip-slate-bg, #f1f5f9)' },
};

// NETA decal / lab-sample ResultRating, relabeled to NETA service terms.
// Note: NETA's physical "Serviceable" decal is WHITE — we keep the green
// accent on screen because white carries no signal against a light UI.
export const DECAL_META = {
  GREEN:  { label: 'Serviceable',     color: 'var(--chip-green-fg, #166534)', bg: 'var(--chip-green-bg, #f0fdf4)' },
  YELLOW: { label: 'Limited Service', color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  RED:    { label: 'Non-serviceable', color: 'var(--chip-red-fg, #991b1b)',   bg: 'var(--chip-red-bg, #fef2f2)' },
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
  1: { label: 'Normal',          color: 'var(--chip-green-fg, #166534)', bg: 'var(--chip-green-bg, #f0fdf4)' },
  2: { label: 'Caution',         color: 'var(--chip-amber-fg, #854d0e)', bg: 'var(--chip-amber-bg, #fefce8)' },
  3: { label: 'Action required', color: 'var(--chip-red-fg, #991b1b)',   bg: 'var(--chip-red-bg, #fef2f2)' },
};

/**
 * Map an AI/free-text equipment-type guess to a canonical EquipmentType enum
 * key, or null if no confident match. Tries: exact key, normalized key
 * (uppercase + non-alnum→_), then case-insensitive label match. Shared by the
 * NewAsset and FieldNewAsset photo-identify flows (#12).
 */
export function matchEquipmentType(guess) {
  if (!guess) return null;
  const raw = String(guess).trim();
  if (EQUIPMENT_TYPE_LABELS[raw]) return raw;
  const up = raw.toUpperCase().replace(/[\s/()-]+/g, '_').replace(/_+/g, '_');
  if (EQUIPMENT_TYPE_LABELS[up]) return up;
  const byLabel = Object.entries(EQUIPMENT_TYPE_LABELS)
    .find(([, label]) => label.toLowerCase() === raw.toLowerCase());
  return byLabel ? byLabel[0] : null;
}

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
