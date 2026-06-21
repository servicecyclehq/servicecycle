/**
 * lib/arcFlashGap.ts — the arc-flash "what's missing per bus to run IEEE 1584"
 * gap-analysis engine (Slice 2 centerpiece / easy-button moat).
 *
 * Given a bus extracted from a one-line or study report, this DETERMINISTICALLY
 * decides, per IEEE 1584-2018, which calculation inputs are present, which can
 * be pre-populated with the standard's typical-by-equipment-class values
 * (flagged "confirm"), and which must be obtained from field/utility/coordination
 * data before a PE can run the study. The output is the per-bus punch list +
 * confidence band the Review Package is built from.
 *
 * IMPORTANT (engineering-guidelines #7): confidence here is derived from the
 * deterministic presence/plausibility of inputs — NOT from any LLM's
 * self-reported confidence (LLM confidence is systematically overconfident).
 *
 * SC is the DATA layer. These typical values are IEEE 1584-2018 Table-9-class
 * guidance to pre-populate a draft; a licensed PE still runs and stamps the
 * actual study. Every defaulted value is surfaced as "typical — confirm".
 */

'use strict';

// ── IEEE 1584-2018 required calculation inputs ───────────────────────────────
// Two categories:
//   must_obtain — site/utility/coordination facts that cannot be safely assumed
//                 (a wrong assumption changes the answer materially).
//   typical     — pre-populated from the standard's by-equipment-class values
//                 (electrode config, conductor gap, working distance), shown for
//                 confirmation. Missing typicals don't block a draft calc.
export const MUST_OBTAIN = ['nominalVoltage', 'boltedFaultCurrentKA', 'clearingTimeMs'];
export const TYPICAL = ['electrodeConfig', 'conductorGapMm', 'workingDistanceIn'];

const FIELD_LABEL: Record<string, string> = {
  nominalVoltage:       'System voltage',
  boltedFaultCurrentKA: 'Bolted fault current',
  clearingTimeMs:       'Protective-device clearing time',
  electrodeConfig:      'Electrode configuration',
  conductorGapMm:       'Conductor gap',
  workingDistanceIn:    'Working distance',
};

const MUST_OBTAIN_NOTE: Record<string, string> = {
  nominalVoltage:       'Read the system voltage at this bus off the one-line.',
  boltedFaultCurrentKA: 'Obtain from the short-circuit study or the utility available-fault-current letter.',
  clearingTimeMs:       'Derive from the upstream protective device clearing time at the arcing current (coordination / TCC data).',
};

// Parse a nominal-voltage label ("480V", "13.8kV", "208") to volts.
function parseVolts(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

// A field "counts" as present only if it carries a usable, plausible value.
function present(v: any): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0;
  return true;
}

// Map our EquipmentType enum to an IEEE-1584 equipment family for default lookup.
function equipFamily(equipmentType: any): string {
  const t = String(equipmentType || '').toUpperCase();
  if (t === 'SWITCHGEAR' || t === 'SWITCHBOARD') return 'switchgear';
  if (t === 'MCC' || t === 'PANELBOARD' || t === 'VFD' || t === 'BUSWAY') return 'mcc_panel';
  if (t === 'CABLE_LV' || t === 'CABLE_MV_HV') return 'cable';
  return 'other';
}

// Voltage class buckets used by the typical-value table.
function voltageClass(volts: number | null): string | null {
  if (volts == null) return null;
  if (volts <= 600) return 'lv';
  if (volts <= 5000) return 'mv5';
  return 'mv15'; // 1584-2018 model tops out at 15 kV; >15 kV flagged elsewhere
}

// IEEE 1584-2018 typical electrode config / conductor gap / working distance by
// equipment class. Values are the standard's representative figures used to
// pre-populate a draft; always confirmed by the engineer.
export function ieee1584Defaults(equipmentType: any, nominalVoltage: any): any {
  const fam = equipFamily(equipmentType);
  const vc = voltageClass(parseVolts(nominalVoltage));

  if (fam === 'cable') {
    return { available: true, className: 'Cable', electrodeConfig: 'VCB', conductorGapMm: 13, workingDistanceIn: 18,
      note: 'IEEE 1584-2018 typical for cable — confirm.' };
  }
  if (fam === 'switchgear') {
    if (vc === 'lv')   return { available: true, className: 'LV switchgear (<=600 V)', electrodeConfig: 'VCB', conductorGapMm: 32,  workingDistanceIn: 24, note: 'IEEE 1584-2018 typical for LV switchgear — confirm (electrode VCB; VCBB if barriered).' };
    if (vc === 'mv5')  return { available: true, className: 'MV switchgear (<=5 kV)',  electrodeConfig: 'VCB', conductorGapMm: 104, workingDistanceIn: 36, note: 'IEEE 1584-2018 typical for 5 kV switchgear — confirm (electrode VCB/VCBB).' };
    if (vc === 'mv15') return { available: true, className: 'MV switchgear (<=15 kV)', electrodeConfig: 'VCB', conductorGapMm: 152, workingDistanceIn: 36, note: 'IEEE 1584-2018 typical for 15 kV switchgear — confirm (electrode VCB/VCBB).' };
  }
  if (fam === 'mcc_panel') {
    if (vc === 'lv')   return { available: true, className: 'LV MCC / panelboard (<=600 V)', electrodeConfig: 'VCB', conductorGapMm: 25,  workingDistanceIn: 18, note: 'IEEE 1584-2018 typical for LV MCC/panelboard — confirm.' };
    if (vc === 'mv5')  return { available: true, className: 'MV MCC (<=5 kV)',  electrodeConfig: 'VCB', conductorGapMm: 104, workingDistanceIn: 36, note: 'IEEE 1584-2018 typical for 5 kV equipment — confirm.' };
    if (vc === 'mv15') return { available: true, className: 'MV MCC (<=15 kV)', electrodeConfig: 'VCB', conductorGapMm: 152, workingDistanceIn: 36, note: 'IEEE 1584-2018 typical for 15 kV equipment — confirm.' };
  }
  return { available: false, className: 'Unknown equipment class',
    note: vc == null
      ? 'Confirm equipment type and system voltage to pre-fill typical gap / working distance.'
      : 'Confirm equipment type to pre-fill typical gap / working distance.' };
}

// Analyze one bus: classify every required IEEE 1584 input, apply typical
// defaults where the equipment class allows, and roll up readiness + a
// deterministic confidence band.
export function analyzeBusGaps(bus: any): any {
  const defaults = ieee1584Defaults(bus.equipmentTypeGuess, bus.nominalVoltage);
  const equipmentKnown = equipFamily(bus.equipmentTypeGuess) !== 'other';
  const fields: any[] = [];
  const missingRequired: string[] = [];
  const defaultsApplied: string[] = [];

  // Must-obtain inputs: present or missing (never defaulted).
  for (const f of MUST_OBTAIN) {
    const has = present(bus[f]);
    fields.push({
      field: f, label: FIELD_LABEL[f], category: 'must_obtain',
      status: has ? 'present' : 'missing',
      value: has ? bus[f] : null,
      note: has ? 'Provided.' : MUST_OBTAIN_NOTE[f],
    });
    if (!has) missingRequired.push(f);
  }

  // Typical inputs: present, else defaulted from the equipment class, else missing.
  const defaultFor: Record<string, any> = {
    electrodeConfig:   defaults.electrodeConfig,
    conductorGapMm:    defaults.conductorGapMm,
    workingDistanceIn: defaults.workingDistanceIn,
  };
  for (const f of TYPICAL) {
    const has = present(bus[f]);
    if (has) {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'present', value: bus[f], note: 'Provided.' });
    } else if (defaults.available && defaultFor[f] != null) {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'defaulted', value: null, defaultValue: defaultFor[f], note: defaults.note });
      defaultsApplied.push(f);
    } else {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'missing', value: null, note: defaults.note });
      missingRequired.push(f);
    }
  }

  // Readiness: blocked if any must-obtain missing OR a typical can't even be
  // defaulted; ready if everything is present; otherwise defaultable.
  const mustMissing = MUST_OBTAIN.some((f) => !present(bus[f]));
  const typicalUndefaultable = TYPICAL.some((f) => !present(bus[f]) && !(defaults.available && defaultFor[f] != null));
  const allPresent = MUST_OBTAIN.concat(TYPICAL).every((f) => present(bus[f]));

  let readiness: string;
  if (mustMissing || typicalUndefaultable) readiness = 'blocked';
  else if (allPresent) readiness = 'ready';
  else readiness = 'defaultable';

  // Deterministic confidence band.
  let confidence: string;
  if (readiness === 'blocked') confidence = 'red';
  else if (readiness === 'ready' && equipmentKnown) confidence = 'green';
  else confidence = 'yellow';

  const summary = buildSummary(bus, readiness, missingRequired, defaultsApplied, equipmentKnown);
  return { readiness, confidence, equipmentKnown, defaultsClass: defaults.className, fields, missingRequired, defaultsApplied, summary };
}

function buildSummary(bus: any, readiness: string, missingRequired: string[], defaultsApplied: string[], equipmentKnown: boolean): string {
  const name = bus.busName || 'This bus';
  if (readiness === 'ready') return `${name}: all IEEE 1584 inputs present — ready for the engineer to run.`;
  const parts: string[] = [];
  const obtain = missingRequired.filter((f) => MUST_OBTAIN.includes(f)).map((f) => FIELD_LABEL[f]);
  const noDefault = missingRequired.filter((f) => TYPICAL.includes(f)).map((f) => FIELD_LABEL[f]);
  if (obtain.length) parts.push(`needs ${obtain.join(', ')}`);
  if (noDefault.length) parts.push(`needs ${noDefault.join(', ')} (no typical — confirm equipment type)`);
  if (defaultsApplied.length) parts.push(`pre-filled typical ${defaultsApplied.map((f) => FIELD_LABEL[f]).join(', ')}`);
  if (!equipmentKnown) parts.push('equipment type unconfirmed');
  return `${name}: ${parts.join('; ')}.`;
}

// Roll up per-bus bands into the ingest-level summary (worst band wins).
export function summarizeIngestBands(results: any[]): any {
  let overall = 'green';
  let ready = 0;
  for (const r of results) {
    if (r.readiness === 'ready') ready++;
    if (r.confidence === 'red') overall = 'red';
    else if (r.confidence === 'yellow' && overall !== 'red') overall = 'yellow';
  }
  return { overallBand: results.length ? overall : 'red', readyBusCount: ready, totalBusCount: results.length };
}
