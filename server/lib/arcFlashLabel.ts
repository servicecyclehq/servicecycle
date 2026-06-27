/**
 * lib/arcFlashLabel.ts — Slice 3.5c helpers: the canonical NFPA 70E label
 * snapshot + deterministic printed-vs-current mismatch.
 *
 * The QR/NFC label is a PORTAL: scanning resolves to the live record, and we flag
 * when the physically-printed sticker no longer matches the current study (a
 * re-study changed the incident energy, PPE, boundary, etc. — reprint needed).
 * Pure + deterministic; the routes own persistence + token issuance.
 */

'use strict';

// The fields a physical arc-flash label carries (NFPA 70E 130.5(H)).
// [AFX-2] arcFlashBoundaryIn already present — confirmed.
// [AFX-3] Added shockLimitedApproachIn and shockRestrictedApproachIn so the
// mismatch detector flags reprints when shock approach boundaries change.
export const LABEL_FIELDS = [
  'nominalVoltage', 'incidentEnergyCalCm2', 'arcFlashBoundaryIn', 'workingDistanceIn',
  'ppeCategory', 'requiredArcRatingCalCm2', 'labelSeverity',
  'shockLimitedApproachIn', 'shockRestrictedApproachIn',
] as const;

const LABEL_FIELD_LABEL: Record<string, string> = {
  nominalVoltage: 'Nominal voltage', incidentEnergyCalCm2: 'Incident energy', arcFlashBoundaryIn: 'Arc Flash Protection Boundary (AFPB)',
  workingDistanceIn: 'Working distance', ppeCategory: 'PPE category', requiredArcRatingCalCm2: 'Required arc rating',
  labelSeverity: 'Severity',
  shockLimitedApproachIn: 'Shock limited approach boundary', shockRestrictedApproachIn: 'Shock restricted approach boundary',
};

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Parse a nominal-voltage label ("480V", "13.8kV", "208") to volts (phase-to-phase).
function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

// [NETA-8-8] NFPA 70E Table 130.4(E)(a) — AC shock approach boundaries for
// exposed FIXED circuit parts, by nominal system voltage (phase-to-phase). These
// are the stable, widely-published values (unchanged across the 2018/2021/2024
// editions). Distances are in INCHES to match the *In fields. `restricted` is
// null where the standard specifies "avoid contact" (50–150 V) rather than a
// distance, or below 50 V where no boundary is defined.
//   [vMaxInclusive, limitedIn, restrictedIn|null]
const TABLE_130_4: Array<[number, number, number | null]> = [
  [50,     0,  null],   // < 50 V: not specified / no defined approach boundary
  [150,    42, null],   // 50–150 V: limited 3 ft 6 in; restricted = avoid contact
  [750,    42, 12],     // 151–750 V: limited 3 ft 6 in; restricted 1 ft 0 in
  [15000,  60, 26],     // 751–15 kV: limited 5 ft 0 in; restricted 2 ft 2 in
  [36000,  72, 31],     // 15.001–36 kV: limited 6 ft 0 in; restricted 2 ft 7 in
  [46000,  96, 33],     // 36.001–46 kV: limited 8 ft 0 in; restricted 2 ft 9 in
  [72500,  96, 39],     // 46.001–72.5 kV: limited 8 ft 0 in; restricted 3 ft 3 in
];

/**
 * Shock approach boundaries from NFPA 70E Table 130.4(E)(a) for a nominal system
 * voltage. Pure + deterministic. Accepts a volts number or a label string
 * ("480V", "13.8kV"). Returns inches (or null where the table specifies a
 * non-distance rule), plus the band's nominal voltage cap so callers can cite it.
 */
export function shockApproachBoundaries(nominalVoltage: any): { limitedIn: number | null; restrictedIn: number | null; bandMaxVolts: number | null } {
  const v = typeof nominalVoltage === 'number' ? nominalVoltage : voltsOf(nominalVoltage);
  if (v == null || v <= 0) return { limitedIn: null, restrictedIn: null, bandMaxVolts: null };
  for (const [vMax, limitedIn, restrictedIn] of TABLE_130_4) {
    if (v <= vMax) {
      // Below the lowest defined band (< 50 V) there is no approach boundary.
      if (vMax === 50) return { limitedIn: null, restrictedIn: null, bandMaxVolts: null };
      return { limitedIn, restrictedIn, bandMaxVolts: vMax };
    }
  }
  // Above 72.5 kV: outside the table's scope — do not fabricate a value.
  return { limitedIn: null, restrictedIn: null, bandMaxVolts: null };
}

// Canonical, JSON-safe label snapshot from a SystemStudyAsset row (Decimals -> numbers).
export function labelSnapshot(row: any): any {
  if (!row) return {};
  // [NETA-8-8] Shock approach boundaries are MANDATORY on the NFPA 70E §130.5(H)
  // label. Prefer a stored (PE-confirmed) value; otherwise derive the published
  // Table 130.4 distance from the nominal voltage so the label/portal/permit never
  // carry a blank. A `*Source` flag distinguishes captured vs. table-derived.
  const t = shockApproachBoundaries(row.nominalVoltage);
  const limitedStored = num(row.shockLimitedApproachIn);
  const restrictedStored = num(row.shockRestrictedApproachIn);
  const limited = limitedStored != null ? limitedStored : t.limitedIn;
  const restricted = restrictedStored != null ? restrictedStored : t.restrictedIn;
  return {
    nominalVoltage: row.nominalVoltage ?? null,
    incidentEnergyCalCm2: num(row.incidentEnergyCalCm2),
    arcFlashBoundaryIn: num(row.arcFlashBoundaryIn),
    workingDistanceIn: num(row.workingDistanceIn),
    ppeCategory: row.ppeCategory ?? null,
    requiredArcRatingCalCm2: num(row.requiredArcRatingCalCm2),
    labelSeverity: row.labelSeverity ?? null,
    // [AFX-3] Shock approach boundaries are mandatory per NFPA 70E §130.5(H); track
    // them in the snapshot so changes trigger a reprint flag. The snapshot shape
    // stays === LABEL_FIELDS; callers that need provenance use
    // shockApproachBoundaries() directly.
    shockLimitedApproachIn: limited,
    shockRestrictedApproachIn: restricted,
  };
}

function eq(a: any, b: any): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a).trim() === String(b).trim();
}

/**
 * Compare the printed snapshot against the current live label. Returns the
 * differing fields. `printed` null/empty (never issued) -> no mismatch. Pure.
 */
export function computeLabelMismatch(printed: any, current: any): { isMismatch: boolean; changes: Array<{ field: string; label: string; printed: any; current: any }> } {
  if (!printed || typeof printed !== 'object' || Object.keys(printed).length === 0) {
    return { isMismatch: false, changes: [] };
  }
  const cur = labelSnapshot(current || {});
  const changes: Array<{ field: string; label: string; printed: any; current: any }> = [];
  for (const f of LABEL_FIELDS) {
    if (!eq((printed as any)[f], (cur as any)[f])) {
      changes.push({ field: f, label: LABEL_FIELD_LABEL[f] || f, printed: (printed as any)[f] ?? null, current: (cur as any)[f] ?? null });
    }
  }
  return { isMismatch: changes.length > 0, changes };
}
