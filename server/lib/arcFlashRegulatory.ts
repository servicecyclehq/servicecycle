/**
 * lib/arcFlashRegulatory.ts — Slice 12: regulatory-change matching.
 *
 * A study can go stale without anything PHYSICAL changing: when the governing
 * standard is revised, labels produced under the prior edition may need review.
 * The two that matter for arc flash:
 *   - NFPA 70E (labeling + risk-assessment review cadence) — current 2024 edition.
 *   - IEEE 1584 (the incident-energy MODEL) — 2018 edition replaced the 2002 model
 *     wholesale (new equations, electrode configs, enclosure-size correction), so a
 *     study still on 1584-2002 is on an outdated calculation basis.
 *
 * Deterministic: a small editions table + a per-study assessment. SC flags the
 * studies to review; a PE decides whether a recalculation is actually required.
 */

'use strict';

// Current governing editions + the effective date used for the "predates" check.
export const STANDARD_EDITIONS = {
  nfpa70e: { current: '2024', currentEffective: '2023-09-01' },
  ieee1584: { current: '2018', currentEffective: '2018-11-30', supersededModel: '2002' },
};

function yearFromMethod(method: any): string | null {
  const m = String(method || '').match(/1584[\s-]*(20\d{2})/);
  return m ? m[1] : null;
}

export interface RegulatoryStatus {
  outdated: boolean;
  ieeeEdition: string | null;
  reasons: string[];
  // [R1] True when the study's performedDate is an unverified confirm-day
  // placeholder (studyDateSource === 'unverified_default'), not a value read
  // from the source document — the NFPA 70E currency check below can't be
  // trusted either way until the real date is confirmed.
  dateUnverified: boolean;
  // [R3] True when there's no calc-basis signal at all (no calcMethod, no
  // method text) to assess against IEEE 1584 edition — distinct from a KNOWN
  // non-1584 basis (lee_method/manufacturer_test), which is a real, current
  // answer, not a gap. An indeterminate basis must not silently read the same
  // as "confirmed current."
  indeterminate: boolean;
}

/**
 * Assess one study's regulatory basis. `study` = { performedDate, method,
 * calcMethod, studyDateSource }. Pure.
 */
export function assessRegulatoryStatus(study: any, asOf: Date = new Date()): RegulatoryStatus {
  const reasons: string[] = [];

  // IEEE 1584 edition: prefer the structured calcMethod, fall back to the method text.
  let ieeeEdition: string | null = null;
  const cm = String(study?.calcMethod || '');
  const knownNon1584Basis = cm === 'lee_method' || cm === 'manufacturer_test';
  if (cm === 'ieee_1584_2018') ieeeEdition = '2018';
  else if (knownNon1584Basis) ieeeEdition = null; // not 1584-equation based
  else ieeeEdition = yearFromMethod(study?.method);

  if (ieeeEdition && ieeeEdition < STANDARD_EDITIONS.ieee1584.current) {
    reasons.push(`Calculated on IEEE 1584-${ieeeEdition}; the ${STANDARD_EDITIONS.ieee1584.current} edition replaced that model — review for recalculation.`);
  }

  // NFPA 70E: a study performed before the current edition's effective date
  // predates the latest labeling / risk-assessment requirements.
  const perf = study?.performedDate ? new Date(study.performedDate) : null;
  if (perf && Number.isFinite(perf.getTime()) && perf.getTime() < new Date(STANDARD_EDITIONS.nfpa70e.currentEffective).getTime()) {
    reasons.push(`Performed before NFPA 70E-${STANDARD_EDITIONS.nfpa70e.current} took effect — review the label/assessment against the current edition.`);
  }

  // [R1] An unverified placeholder date makes the NFPA 70E check above
  // unreliable in EITHER direction (could be an old study masquerading as
  // fresh, or vice versa) — surface it rather than trusting the placeholder.
  const dateUnverified = study?.studyDateSource === 'unverified_default';
  if (dateUnverified) {
    reasons.push('Study performed-date could not be read from the source document at confirm time — a placeholder date was used. Verify the real date before trusting the NFPA 70E currency check above.');
  }

  // [R3] No calc-basis signal at all (not even free-text method, and not a
  // known non-1584 basis) — don't let this read as "confirmed current."
  const indeterminate = !ieeeEdition && !knownNon1584Basis && !study?.method;
  if (indeterminate) {
    reasons.push('No calculation method recorded — unable to confirm this study reflects the current IEEE 1584 edition. Verify the method against the source report.');
  }

  return { outdated: reasons.length > 0, ieeeEdition, reasons, dateUnverified, indeterminate };
}
