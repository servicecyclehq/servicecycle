/**
 * lib/thermographyShape.ts — #29 §7.4 API serialization for IR surveys.
 *
 * Prisma returns Decimal columns as Decimal objects, which JSON.stringify
 * renders as strings ("22.5"). Every IR number the client charts or compares
 * (ΔT, load %, emissivity) would then be a string, so `dec()` normalizes them
 * to real numbers once, here, instead of at each call site.
 *
 * Shared by routes/thermographyIngest.ts (asset-scoped history) and
 * routes/thermography.ts (account-scoped detail / search / report).
 */

/** Decimal | number | null → number | null. Never throws. */
export function dec(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function shapeFinding(f: any) {
  return {
    id:               f.id,
    assetId:          f.assetId,
    surveyId:         f.surveyId,
    component:        f.component,
    deltaT:           dec(f.deltaT),
    referenceType:    f.referenceType,
    referenceDeltaT:  dec(f.referenceDeltaT),
    loadPercent:      dec(f.loadPercent),
    emissivity:       dec(f.emissivity),
    severity:         f.severity,
    severityLabel:    f.severityLabel,
    correctiveAction: f.correctiveAction,
    deficiencyId:     f.deficiencyId,
    resolvedAt:       f.resolvedAt,
    createdAt:        f.createdAt,
  };
}

export function shapeSurvey(s: any) {
  return {
    id:                s.id,
    assetId:           s.assetId,
    surveyDate:        s.surveyDate,
    thermographerName: s.thermographerName,
    thermographerQual: s.thermographerQual,
    cameraMake:        s.cameraMake,
    cameraModel:       s.cameraModel,
    ambientTempC:      dec(s.ambientTempC),
    humidityPct:       dec(s.humidityPct),
    emissivity:        dec(s.emissivity),
    reflectedTempC:    dec(s.reflectedTempC),
    loadPercent:       dec(s.loadPercent),
    notes:             s.notes,
    sourceDocumentId:  s.sourceDocumentId,
    sourceDocument:    s.sourceDocument ? { id: s.sourceDocument.id, filename: s.sourceDocument.filename } : null,
    createdBy:         s.createdBy ? { id: s.createdBy.id, name: s.createdBy.name } : null,
    createdAt:         s.createdAt,
    findings:          Array.isArray(s.findings) ? s.findings.map(shapeFinding) : undefined,
  };
}

/**
 * NETA MTS-2023 Table 100.18 legend, as ServiceCycle applies it. The
 * over-ambient 21-40 °C row is a deliberate ServiceCycle escalation of NETA's
 * literal "monitor" action per HSB/Zurich insurer guidance — kept in sync with
 * lib/thermographyEvaluate.ts, which is the grader of record.
 */
export const NETA_TABLE_100_18 = [
  { reference: 'Similar component', band: '1–3 °C',   action: 'Possible deficiency — investigate',            severity: 'ADVISORY' },
  { reference: 'Similar component', band: '4–15 °C',  action: 'Probable deficiency — repair as time permits', severity: 'RECOMMENDED' },
  { reference: 'Similar component', band: '>15 °C',   action: 'Major discrepancy — repair immediately',       severity: 'IMMEDIATE' },
  { reference: 'Over ambient air',  band: '1–10 °C',  action: 'Possible deficiency — investigate',            severity: 'ADVISORY' },
  { reference: 'Over ambient air',  band: '11–20 °C', action: 'Probable deficiency — repair as time permits', severity: 'RECOMMENDED' },
  { reference: 'Over ambient air',  band: '21–40 °C', action: 'NETA "monitor"; ServiceCycle escalates — investigate now', severity: 'RECOMMENDED' },
  { reference: 'Over ambient air',  band: '>40 °C',   action: 'Major discrepancy — repair immediately',       severity: 'IMMEDIATE' },
];
