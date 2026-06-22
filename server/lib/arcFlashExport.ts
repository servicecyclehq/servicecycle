/**
 * lib/arcFlashExport.ts — Slice 3.5a: export the collected arc-flash model in a
 * neutral CSV/JSON the PE can re-key-free import into SKM / ETAP / EasyPower.
 *
 * SC is the DATA layer: it captures the IEEE 1584 inputs (and any computed label
 * outputs) but does not run the study. This export hands the collected model to
 * whatever tool the PE stamps in, so the field-collected data isn't typed twice.
 * Pure + deterministic; column order is stable so downstream mappings don't break.
 */

'use strict';

function voltsOf(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

function num(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Stable export columns: [key, header]. One row per bound bus.
export const EXPORT_COLUMNS: Array<[string, string]> = [
  ['site', 'Site'],
  ['busName', 'Bus'],
  ['equipmentType', 'Equipment Type'],
  ['nominalVoltageV', 'Nominal Voltage (V)'],
  ['boltedFaultCurrentKA', 'Bolted Fault (kA)'],
  ['arcingCurrentKA', 'Arcing Current (kA)'],
  ['electrodeConfig', 'Electrode Config'],
  ['conductorGapMm', 'Gap (mm)'],
  ['workingDistanceIn', 'Working Distance (in)'],
  ['clearingTimeMs', 'Clearing Time (ms)'],
  ['deviceType', 'Upstream Device'],
  ['tripUnitType', 'Trip Unit'],
  ['fuseClass', 'Fuse Class'],
  ['deviceManufacturer', 'Device Mfr'],
  ['deviceModel', 'Device Model'],
  ['deviceRatingA', 'Device Rating (A)'],
  ['deviceSettings', 'Trip Settings (JSON)'],
  ['cableLengthFt', 'Cable Length (ft)'],
  ['cableSize', 'Cable Size'],
  ['cableMaterial', 'Cable Material'],
  ['conductorsPerPhase', 'Conductors / Phase'],
  ['conduitType', 'Conduit'],
  ['enclosureType', 'Enclosure'],
  ['utilityMaxFaultKA', 'Utility Max Fault (kA)'],
  ['utilityMinFaultKA', 'Utility Min Fault (kA)'],
  ['utilityXr', 'Utility X/R'],
  ['transformerKva', 'Transformer (kVA)'],
  ['transformerImpedancePct', 'Transformer %Z'],
  ['transformerPrimaryV', 'Transformer Primary (V)'],
  ['transformerSecondaryV', 'Transformer Secondary (V)'],
  ['incidentEnergyCalCm2', 'Incident Energy (cal/cm2)'],
  ['arcFlashBoundaryIn', 'Arc Flash Boundary (in)'],
  ['ppeCategory', 'PPE Category'],
  ['requiredArcRatingCalCm2', 'Required Arc Rating (cal/cm2)'],
];

/**
 * Flatten bound study-asset rows (each with .asset.site.name + .study.sourceModel)
 * into stable export records. Pure.
 */
export function buildExportRows(rows: any[]): any[] {
  return (rows || []).map((s: any) => {
    const sm = s.study?.sourceModel || {};
    const settings = s.deviceSettings && typeof s.deviceSettings === 'object' ? JSON.stringify(s.deviceSettings) : '';
    return {
      site: s.asset?.site?.name || '',
      busName: s.busName || '',
      equipmentType: s.asset?.equipmentType || '',
      nominalVoltageV: voltsOf(s.nominalVoltage),
      boltedFaultCurrentKA: num(s.boltedFaultCurrentKA),
      arcingCurrentKA: num(s.arcingCurrentKA),
      electrodeConfig: s.electrodeConfig || '',
      conductorGapMm: num(s.conductorGapMm),
      workingDistanceIn: num(s.workingDistanceIn),
      clearingTimeMs: num(s.clearingTimeMs),
      deviceType: s.deviceType || '',
      tripUnitType: s.tripUnitType || '',
      fuseClass: s.fuseClass || '',
      deviceManufacturer: s.deviceManufacturer || '',
      deviceModel: s.deviceModel || '',
      deviceRatingA: num(s.deviceRatingA),
      deviceSettings: settings,
      cableLengthFt: num(s.cableLengthFt),
      cableSize: s.cableSize || '',
      cableMaterial: s.cableMaterial || '',
      conductorsPerPhase: s.conductorsPerPhase ?? '',
      conduitType: s.conduitType || '',
      enclosureType: s.enclosureType || '',
      utilityMaxFaultKA: num(sm.utilityMaxFaultKA),
      utilityMinFaultKA: num(sm.utilityMinFaultKA),
      utilityXr: num(sm.utilityXr),
      transformerKva: num(sm.transformerKva),
      transformerImpedancePct: num(sm.transformerImpedancePct),
      transformerPrimaryV: sm.transformerPrimaryV ?? '',
      transformerSecondaryV: sm.transformerSecondaryV ?? '',
      incidentEnergyCalCm2: num(s.incidentEnergyCalCm2),
      arcFlashBoundaryIn: num(s.arcFlashBoundaryIn),
      ppeCategory: s.ppeCategory ?? '',
      requiredArcRatingCalCm2: num(s.requiredArcRatingCalCm2),
    };
  });
}

// RFC-4180-ish CSV cell: quote when the value contains a comma, quote, or newline;
// double embedded quotes.
function csvCell(v: any): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render export records as CSV using the stable column order. Pure.
 */
export function toCsv(records: any[], columns: Array<[string, string]> = EXPORT_COLUMNS): string {
  const header = columns.map(([, label]) => csvCell(label)).join(',');
  const lines = (records || []).map((r) => columns.map(([key]) => csvCell(r[key])).join(','));
  return [header, ...lines].join('\r\n');
}
