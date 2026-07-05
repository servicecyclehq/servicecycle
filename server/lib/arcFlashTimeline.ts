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

export interface TimelineEvent {
  date: any; type: string; title: string; detail: string | null; severity?: string | null;
  // [F-T2] True when `date` above is a fallback to createdAt/entry-time
  // because the real source-document/collection date wasn't recorded — the
  // event still needs a position on the timeline, but callers must not treat
  // it as "this is when the test/collection actually happened."
  dateInferred?: boolean;
}

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
      // [F-T2 adjunct] The F1 fix can leave performedDate as an unverified
      // confirm-day placeholder (studyDateSource === 'unverified_default') —
      // surface that here too, not just at the study/regulatory/permit layers.
      const dateUnverified = s.study?.studyDateSource === 'unverified_default';
      events.push({
        date: performed, type: 'study', title: 'Arc-flash study performed',
        detail: [ie != null ? `${ie} cal/cm²` : null, s.busName ? `bus ${s.busName}` : null, s.study?.peName ? `by ${s.study.peName}` : null, dateUnverified ? '⚠️ date unverified (placeholder)' : null].filter(Boolean).join(' · ') || null,
        severity: s.labelSeverity || null,
        dateInferred: dateUnverified,
      });
    }
    if (s.printedAt) {
      events.push({ date: s.printedAt, type: 'label_printed', title: 'Label issued / printed', detail: s.busName ? `bus ${s.busName}` : null });
    }
  }

  for (const test of input.deviceTests || []) {
    const dateInferred = !test.testDate;
    const date = test.testDate || test.createdAt;
    if (!date) continue;
    // [F-T1] driftFlagged defaults false whenever drift was never actually
    // evaluated (no matchesStudy result and no as-found/as-left pair to diff),
    // not just when it was evaluated and found clean. Rendering both as a flat
    // "no drift" asserts a verified-clean outcome for a test that may never
    // have checked. Distinguish "not evaluated" from "confirmed no drift."
    const evaluated = test.matchesStudy != null || (test.asFoundSettings != null && test.asLeftSettings != null);
    const driftLabel = test.driftFlagged ? 'DRIFT — settings changed' : (evaluated ? 'no drift' : 'drift not evaluated');
    events.push({
      date, type: 'device_test', title: `Device test (${test.testType || 'test'})`,
      detail: [test.result ? `result ${test.result}` : null, driftLabel].filter(Boolean).join(' · '),
      severity: test.driftFlagged ? 'danger' : null,
      dateInferred,
    });
  }

  for (const d of input.devices || []) {
    const dateInferred = !d.settingsCollectedAt;
    const date = d.settingsCollectedAt || d.createdAt;
    if (!date) continue;
    events.push({
      date, type: 'device_collected', title: `Protective device collected (${d.source || 'manual'})`,
      detail: [d.label, d.deviceType, d.sensorRatingA != null ? `${num(d.sensorRatingA)}A` : null].filter(Boolean).join(' · ') || null,
      dateInferred,
    });
  }

  events.sort((a, b) => t(b.date) - t(a.date));
  return events;
}
