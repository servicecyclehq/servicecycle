/**
 * lib/arcFlashTimeline.ts — Slice 11: time-machine / timeline playback of a bus's
 * arc-flash history.
 *
 * Assembles a single chronological event stream from the records SC already keeps
 * — study revisions (with incident energy), label issuances, NETA as-found/as-left
 * tests (with drift), and collected protective devices — so a bus's full story
 * (how the hazard, the settings, and the label changed over time) reads top to
 * bottom. Pure: the route loads the rows, this orders + shapes them.
 */

'use strict';

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function t(d: any): number { const x = d ? new Date(d).getTime() : NaN; return Number.isFinite(x) ? x : 0; }

export interface TimelineEvent { date: any; type: string; title: string; detail: string | null; severity?: string | null; }

/**
 * Build the descending (newest-first) event timeline. Inputs are already-loaded
 * rows. Pure.
 */
export function buildTimeline(input: { studyAssets?: any[]; deviceTests?: any[]; devices?: any[] }): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const s of input.studyAssets || []) {
    const performed = s.study?.performedDate;
    if (performed) {
      const ie = num(s.incidentEnergyCalCm2);
      events.push({
        date: performed, type: 'study', title: 'Arc-flash study performed',
        detail: [ie != null ? `${ie} cal/cm²` : null, s.busName ? `bus ${s.busName}` : null, s.study?.peName ? `by ${s.study.peName}` : null].filter(Boolean).join(' · ') || null,
        severity: s.labelSeverity || null,
      });
    }
    if (s.printedAt) {
      events.push({ date: s.printedAt, type: 'label_printed', title: 'Label issued / printed', detail: s.busName ? `bus ${s.busName}` : null });
    }
  }

  for (const test of input.deviceTests || []) {
    const date = test.testDate || test.createdAt;
    if (!date) continue;
    events.push({
      date, type: 'device_test', title: `Device test (${test.testType || 'test'})`,
      detail: [test.result ? `result ${test.result}` : null, test.driftFlagged ? 'DRIFT — settings changed' : 'no drift'].filter(Boolean).join(' · '),
      severity: test.driftFlagged ? 'danger' : null,
    });
  }

  for (const d of input.devices || []) {
    const date = d.settingsCollectedAt || d.createdAt;
    if (!date) continue;
    events.push({
      date, type: 'device_collected', title: `Protective device collected (${d.source || 'manual'})`,
      detail: [d.label, d.deviceType, d.sensorRatingA != null ? `${num(d.sensorRatingA)}A` : null].filter(Boolean).join(' · ') || null,
    });
  }

  events.sort((a, b) => t(b.date) - t(a.date));
  return events;
}
