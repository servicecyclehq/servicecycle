/**
 * thermographyEvaluate.ts — #29 IR thermography hot-spot severity.
 *
 * Maps a temperature rise (deltaT, degrees C) to the NETA Table 100.18
 * thermographic severity bands and a ServiceCycle deficiency severity. Default
 * reference is "between similar components under similar loading" (the most
 * common electrical IR comparison); the over-ambient bands are also provided.
 *
 * NETA Table 100.18 (similar-component delta):
 *   1-3 C   -> possible deficiency; investigate            (priority 4 / ADVISORY)
 *   4-15 C  -> probable deficiency; repair as time permits (priority 2 / RECOMMENDED)
 *   >15 C   -> major discrepancy; repair immediately       (priority 1 / IMMEDIATE)
 *
 * NETA Table 100.18 (over-ambient bands). NOTE: NETA's literal action for the 21-40 C
 * over-ambient row is "monitor until corrective measures can be accomplished."
 * ServiceCycle deliberately escalates that row to RECOMMENDED (immediate investigation)
 * per HSB/Zurich insurer guidance — a house override that is MORE conservative than the
 * NETA table, not a restatement of it:
 *   1-10 C  possible deficiency; investigate                  (priority 4 / ADVISORY)
 *   11-20 C probable deficiency; repair as time permits       (priority 2 / RECOMMENDED)
 *   21-40 C NETA: "monitor" → SC override: investigate now    (priority 2 / RECOMMENDED)
 *   >40 C   major discrepancy; repair immediately             (priority 1 / IMMEDIATE)
 */

export type DeltaReference = 'similar' | 'ambient';

export interface HotspotSeverity {
  priority: number;                                  // NETA 1 (worst) .. 4
  severity: 'IMMEDIATE' | 'RECOMMENDED' | 'ADVISORY' | null; // null = below threshold
  label: string;
}

export function severityForDeltaT(deltaT: number, reference: DeltaReference = 'similar'): HotspotSeverity {
  const d = Number(deltaT);
  if (!Number.isFinite(d) || d <= 0) return { priority: 4, severity: null, label: 'No measurable rise' };

  if (reference === 'ambient') {
    // NETA Table 100.18 over-ambient-air bands. The 21-40 C row's literal NETA action is
    // "monitor until corrective measures can be accomplished"; SC deliberately escalates it
    // to RECOMMENDED (investigate now) as a more-conservative HSB/Zurich-insurer house rule:
    //   1-10 C  possible deficiency, investigate            (ADVISORY)
    //   11-20 C probable deficiency, repair as time permits (RECOMMENDED)
    //   21-40 C NETA "monitor" → SC override: investigate now (RECOMMENDED)
    //   >40 C   major discrepancy, repair immediately       (IMMEDIATE)
    if (d > 40) return { priority: 1, severity: 'IMMEDIATE', label: 'Major discrepancy — repair immediately' };
    if (d >= 21) return { priority: 2, severity: 'RECOMMENDED', label: 'Probable deficiency — immediate investigation required' };
    if (d >= 11) return { priority: 2, severity: 'RECOMMENDED', label: 'Probable deficiency — repair as time permits' };
    if (d >= 1) return { priority: 4, severity: 'ADVISORY', label: 'Possible deficiency — investigate' };
    return { priority: 4, severity: null, label: 'Within normal range' };
  }

  // similar-component delta (default)
  if (d > 15) return { priority: 1, severity: 'IMMEDIATE', label: 'Major discrepancy — repair immediately' };
  if (d >= 4) return { priority: 2, severity: 'RECOMMENDED', label: 'Probable deficiency — repair as time permits' };
  if (d >= 1) return { priority: 4, severity: 'ADVISORY', label: 'Possible deficiency — investigate' };
  return { priority: 4, severity: null, label: 'Within normal range' };
}
