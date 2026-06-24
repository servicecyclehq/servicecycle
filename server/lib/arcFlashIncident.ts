'use strict';

/**
 * arcFlashIncident.ts - the arc-flash incident / near-miss register.
 *
 * A MANUAL event log the customer creates (SC detects nothing). When an incident
 * is logged, SC snapshots the bus's CURRENT arc-flash data state so the record is
 * self-contextualizing - "what did the label/study say at the moment this
 * happened?" - which is what makes it useful later for the risk score and the
 * audit/insurer bundle. SC never decides whether an event was preventable or who
 * is at fault; it stores the customer's record.
 */

const INCIDENT_TYPES = ['near_miss', 'arc_flash', 'shock', 'equipment_failure', 'other'];
const WORK_TYPES = ['energized', 'de_energized', 'inspection', 'other'];
const STATUSES = ['open', 'reviewed', 'closed'];

function normEnum(v: any, allow: string[], dflt: string): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return allow.includes(s) ? s : dflt;
}

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Snapshot the arc-flash data state at log time. Pure.
 * `current` = the current study-asset/label row (studyAssetOut shape) or null.
 */
function buildStudyStateSnapshot(current: any, asOf: Date = new Date()): any {
  if (!current) return null;
  const study = current.study || {};
  const expiresAt = study.expiresAt || null;
  const studyExpired = expiresAt ? new Date(expiresAt).getTime() < asOf.getTime() : null;
  return {
    capturedAt: asOf.toISOString(),
    busName: current.busName ?? null,
    nominalVoltage: current.nominalVoltage ?? null,
    incidentEnergyCalCm2: num(current.incidentEnergyCalCm2),
    arcFlashBoundaryIn: num(current.arcFlashBoundaryIn),
    ppeCategory: current.ppeCategory ?? null,
    requiredArcRatingCalCm2: num(current.requiredArcRatingCalCm2),
    labelSeverity: current.labelSeverity ?? null,
    studyPerformedDate: study.performedDate ?? null,
    studyExpiresAt: expiresAt,
    studyExpired,
    studySuperseded: !!study.superseded,
    confidenceScore: current.confidence?.score ?? null,
    confidenceBand: current.confidence?.band ?? null,
  };
}

function incidentOut(r: any): any {
  return {
    id: r.id,
    assetId: r.assetId,
    siteId: r.siteId,
    busName: r.busName,
    incidentType: r.incidentType,
    occurredAt: r.occurredAt,
    description: r.description,
    injury: r.injury,
    injuryDetail: r.injuryDetail,
    ppeWorn: r.ppeWorn,
    workType: r.workType,
    oshaRecordable: r.oshaRecordable,
    correctiveAction: r.correctiveAction,
    studyStateSnapshot: r.studyStateSnapshot,
    reportUrl: r.reportUrl,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Roll up incidents per site for the fleet attention view. Pure.
 * A logged incident/near-miss is the strongest real-world signal that a site
 * needs eyes — so the fleet surfaces it alongside DANGER%. SC counts the
 * customer's records; it makes no preventability or fault judgment.
 * @returns Map siteId -> { recent, open, injury, lastOccurredAt }
 *   recent = occurred within windowDays (by occurredAt, else createdAt)
 */
function rollupIncidentsBySite(incidents: any[], nowMs: number, windowDays: number): Map<string, any> {
  const out = new Map<string, any>();
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  for (const inc of (incidents || [])) {
    const siteId = inc.siteId || 'unassigned';
    let s = out.get(siteId);
    if (!s) { s = { recent: 0, open: 0, injury: 0, lastOccurredAt: null }; out.set(siteId, s); }
    const when = inc.occurredAt || inc.createdAt;
    const t = when ? new Date(when).getTime() : null;
    if (t != null && t >= cutoff) s.recent++;
    if (inc.status !== 'closed') s.open++;
    if (inc.injury) s.injury++;
    if (t != null && (s.lastOccurredAt == null || t > s.lastOccurredAt)) s.lastOccurredAt = t;
  }
  return out;
}

module.exports = { INCIDENT_TYPES, WORK_TYPES, STATUSES, normEnum, buildStudyStateSnapshot, incidentOut, rollupIncidentsBySite };

export {};
