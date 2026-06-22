/**
 * lib/arcFlashPermit.ts — Slice 5: energized electrical work permit (NFPA 70E
 * 130.2(B)) generator + issuance gate.
 *
 * Pre-fills the permit from the bus's current arc-flash label (incident energy,
 * arc-flash boundary, shock approach boundaries, required PPE / arc rating) so the
 * crew isn't transcribing it by hand — and BLOCKS issuance when the underlying
 * study is missing, expired, superseded, or has no incident energy, because a
 * permit written off a stale study is a safety problem. Deterministic + pure.
 *
 * SC pre-fills + validates the data; a qualified person and the responsible
 * manager still complete, authorize, and sign the permit per the site's program.
 */

'use strict';

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseVolts(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

/**
 * Validate whether an energized-work permit may be issued for a bus's current
 * study. Returns canIssue + the blocking reasons. Pure.
 */
export function validatePermitIssuance(bus: any, study: any, asOf: Date = new Date()): { canIssue: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!study) reasons.push('No arc-flash study is bound to this equipment.');
  if (study && study.supersededById) reasons.push('The bound study has been superseded by a newer revision.');
  if (study && study.expiresAt && new Date(study.expiresAt).getTime() < asOf.getTime()) reasons.push('The arc-flash study has expired (re-evaluation overdue).');
  const ie = num(bus && bus.incidentEnergyCalCm2);
  const volts = parseVolts(bus && bus.nominalVoltage);
  if (ie == null && volts == null) reasons.push('No incident energy or system voltage on record for this bus.');
  return { canIssue: reasons.length === 0, reasons };
}

/**
 * Build the pre-filled energized-work permit (the data half — the crew fills the
 * task / justification / approvals). Pure.
 */
export function buildEnergizedWorkPermit(ctx: { bus: any; study: any; asset?: any; asOf?: Date }): any {
  const { bus, study, asset } = ctx;
  const asOf = ctx.asOf || new Date();
  const ie = num(bus && bus.incidentEnergyCalCm2);
  const volts = parseVolts(bus && bus.nominalVoltage);
  const danger = (ie != null && ie > 40) || (volts != null && volts > 600);
  const validation = validatePermitIssuance(bus, study, asOf);

  return {
    generatedAt: asOf.toISOString(),
    standard: 'NFPA 70E-2024 §130.2(B) energized electrical work permit',
    equipment: {
      busName: bus?.busName || null,
      site: asset?.site?.name || null,
      equipmentType: asset?.equipmentType || null,
      nominalVoltage: bus?.nominalVoltage || null,
    },
    hazard: {
      incidentEnergyCalCm2: ie,
      arcFlashBoundaryIn: num(bus?.arcFlashBoundaryIn),
      workingDistanceIn: num(bus?.workingDistanceIn),
      shockLimitedApproachIn: num(bus?.shockLimitedApproachIn),
      shockRestrictedApproachIn: num(bus?.shockRestrictedApproachIn),
      ppeCategory: bus?.ppeCategory ?? null,
      requiredArcRatingCalCm2: num(bus?.requiredArcRatingCalCm2),
      hazardClass: danger ? 'DANGER' : (ie != null || volts != null ? 'WARNING' : null),
    },
    study: {
      performedDate: study?.performedDate || null,
      expiresAt: study?.expiresAt || null,
      peName: study?.peName || null,
      method: study?.method || null,
      superseded: !!(study && study.supersededById),
    },
    // The crew/manager completes these per the site program — listed so the
    // printed permit is ready to fill + sign.
    toComplete: [
      'Description of the energized work and justification (why de-energizing is infeasible)',
      'Safe work practices and job-specific procedures',
      'Results of the shock and arc-flash risk assessment review',
      'Required PPE confirmed available and rated for the incident energy above',
      'Means to restrict access to the arc-flash and shock boundaries',
      'Qualified person(s) and evidence of job briefing',
      'Authorizing manager signature and date',
    ],
    validation,
    disclaimer: 'ServiceCycle pre-fills the hazard data from the current study and checks the study is valid. A qualified person and the responsible manager must complete, authorize, and sign this permit per NFPA 70E and your electrical safety program.',
  };
}
