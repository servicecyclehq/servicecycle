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

// Canonical, JSON-safe label snapshot from a SystemStudyAsset row (Decimals -> numbers).
export function labelSnapshot(row: any): any {
  if (!row) return {};
  return {
    nominalVoltage: row.nominalVoltage ?? null,
    incidentEnergyCalCm2: num(row.incidentEnergyCalCm2),
    arcFlashBoundaryIn: num(row.arcFlashBoundaryIn),
    workingDistanceIn: num(row.workingDistanceIn),
    ppeCategory: row.ppeCategory ?? null,
    requiredArcRatingCalCm2: num(row.requiredArcRatingCalCm2),
    labelSeverity: row.labelSeverity ?? null,
    // [AFX-3] Shock approach boundaries are mandatory per NFPA 70E §130.5(H); track
    // them in the snapshot so changes trigger a reprint flag.
    shockLimitedApproachIn: num(row.shockLimitedApproachIn),
    shockRestrictedApproachIn: num(row.shockRestrictedApproachIn),
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
