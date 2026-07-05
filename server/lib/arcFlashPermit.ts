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

const { SC_DATA_LAYER_DISCLAIMER } = require('./arcFlashCopy');
const { writeLog: writeActivityLog } = require('./activityLog');

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
 *
 * [LEGAL-8-12] opts.unreviewedDrift (optional, caller-supplied): a signal that the
 * physical system changed since the study (a swapped breaker, a re-imported
 * protective-device setting, a NETA/ingest drift flag) that has NOT been resolved
 * by a re-study. Date-based supersession alone can't detect this, so a permit must
 * NOT auto-issue authoritative-looking hazard numbers when such drift exists.
 * When set, issuance is blocked (canIssue=false) and the reason is surfaced.
 * Backward-compatible: callers that omit opts behave exactly as before.
 */
export function validatePermitIssuance(
  bus: any,
  study: any,
  asOf: Date = new Date(),
  opts?: { unreviewedDrift?: boolean; driftReason?: string },
): { canIssue: boolean; reasons: string[]; unreviewedDrift: boolean } {
  const reasons: string[] = [];
  if (!study) reasons.push('No arc-flash study is bound to this equipment.');
  if (study && study.supersededById) reasons.push('The bound study has been superseded by a newer revision.');
  if (study && study.expiresAt && new Date(study.expiresAt).getTime() < asOf.getTime()) reasons.push('The arc-flash study has expired (re-evaluation overdue).');
  // [F-P4] An unverified placeholder performedDate (routes/arcFlashIngest.ts F1
  // fix — studyDateSource === 'unverified_default') makes the expiresAt check
  // above unreliable in either direction: expiresAt is computed FROM the
  // placeholder, so a genuinely old study could read as "not expired." Treat
  // this with the same caution as an expired study — block issuance rather
  // than silently trusting a date nobody has verified.
  if (study && study.studyDateSource === 'unverified_default') reasons.push('The study’s performed date could not be read from the source document and was recorded as a placeholder — verify the real date before issuing a permit off this study.');
  const ie = num(bus && bus.incidentEnergyCalCm2);
  const volts = parseVolts(bus && bus.nominalVoltage);
  if (ie == null && volts == null) reasons.push('No incident energy or system voltage on record for this bus.');
  const unreviewedDrift = !!(opts && opts.unreviewedDrift);
  if (unreviewedDrift) {
    reasons.push((opts && opts.driftReason) || 'A system change has been detected since the study date (unreviewed). The incident energy may no longer be valid — re-study or have a qualified person clear the drift before issuing.');
  }
  return { canIssue: reasons.length === 0, reasons, unreviewedDrift };
}

/**
 * Build the pre-filled energized-work permit (the data half — the crew fills the
 * task / justification / approvals). Pure.
 *
 * [AFX-8] energizedWorkJustification: caller-supplied, recorded in the permit as
 * a required attestation (why de-energizing is infeasible) rather than a future
 * fill-in item, per NFPA 70E §130.2(B)(1).
 * [AFX-10] riskAssessmentCompleted and safeWorkProcedureAvailable are required
 * pre-issuance attestations per NFPA 70E §130.2(B)(2) and §130.2(B)(3).
 */
export function buildEnergizedWorkPermit(ctx: {
  bus: any;
  study: any;
  asset?: any;
  asOf?: Date;
  userId?: any;
  accountId?: any;
  // [AFX-8] Required: statement of why energized work is necessary.
  energizedWorkJustification?: string;
  // [AFX-10] Required attestations per NFPA 70E §130.2(B).
  riskAssessmentCompleted?: boolean;
  safeWorkProcedureAvailable?: boolean;
  // [LEGAL-8-12] Optional: an unresolved system-change/drift signal for this asset.
  // When set, the gate downgrades canIssue (date-supersession can't detect a
  // physical change since the study). Omit to keep prior behavior.
  unreviewedDrift?: boolean;
  driftReason?: string;
}): any {
  const { bus, study, asset } = ctx;
  const justification = ctx.energizedWorkJustification || null;
  const riskAssessmentCompleted    = ctx.riskAssessmentCompleted    ?? null;
  const safeWorkProcedureAvailable = ctx.safeWorkProcedureAvailable ?? null;
  const asOf = ctx.asOf || new Date();
  const ie = num(bus && bus.incidentEnergyCalCm2);
  const volts = parseVolts(bus && bus.nominalVoltage);
  const validation = validatePermitIssuance(bus, study, asOf, { unreviewedDrift: ctx.unreviewedDrift, driftReason: ctx.driftReason });
  // [F-P3] Prefer the bus's own stored labelSeverity (the same value the
  // label/one-line/search surfaces show) over recomputing — the prior
  // recompute here (`ie > 40` only) was narrower than the canonical rule
  // (also DANGER above 600V) used everywhere else, so a bus could show
  // DANGER on its label but WARNING on its permit. Only falls back to
  // computing when nothing is stored (e.g. a v1 API caller that never
  // fetched labelSeverity).
  const storedSeverity = bus && bus.labelSeverity ? String(bus.labelSeverity).toLowerCase() : null;
  const hazardClass = storedSeverity === 'danger' ? 'DANGER'
    : storedSeverity === 'warning' ? 'WARNING'
    : ((ie != null && ie > 40) || (volts != null && volts > 600)) ? 'DANGER'
    : (ie != null || volts != null) ? 'WARNING'
    : null;

  const permit = {
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
      hazardClass,
    },
    study: {
      performedDate: study?.performedDate || null,
      expiresAt: study?.expiresAt || null,
      peName: study?.peName || null,
      method: study?.method || null,
      superseded: !!(study && study.supersededById),
    },
    // [AFX-8] Recorded input: justification for energized work (NFPA 70E §130.2(B)(1)).
    // Supplied by the requestor at permit generation; must not be blank before issuance.
    energizedWorkJustification: justification,
    // [AFX-10] Recorded attestations per NFPA 70E §130.2(B)(2) and §130.2(B)(3).
    // These are confirmed by the qualified person before permit issuance.
    attestations: {
      riskAssessmentCompleted:    riskAssessmentCompleted,
      safeWorkProcedureAvailable: safeWorkProcedureAvailable,
    },
    // The crew/manager completes these per the site program — listed so the
    // printed permit is ready to fill + sign.
    toComplete: [
      'Required PPE confirmed available and rated for the incident energy above',
      'Means to restrict access to the arc-flash and shock boundaries',
      'Qualified person(s) and evidence of job briefing',
      'Authorizing manager signature and date',
    ],
    validation,
    disclaimer: 'ServiceCycle verified this study has not been superseded or expired by date. Operational validity — including whether system changes since the study date affect these results — must be confirmed by a qualified person under NFPA 70E §130.5(G). ' + SC_DATA_LAYER_DISCLAIMER,
  };

  // INS-13: Audit log — fire-and-forget; do not block permit delivery on logging failure.
  if (ctx.userId || ctx.accountId) {
    writeActivityLog({
      accountId: ctx.accountId || null,
      userId: ctx.userId || null,
      assetId: asset?.id || null,
      action: 'arc_flash_permit_generated',
      details: {
        studyId: study?.id || null,
        studyVersion: study?.version || null,
        requestedBy: ctx.userId || null,
        incidentEnergyAtTime: ie,
        ppeCategoryAtTime: bus?.ppeCategory ?? null,
      },
    }).catch((bsErr: unknown) => { console.error('[arc-flash-permit] audit log failed:', bsErr); });
  }

  return permit;
}
