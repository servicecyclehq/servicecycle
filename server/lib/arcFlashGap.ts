/**
 * lib/arcFlashGap.ts — the arc-flash "what's missing per bus to run IEEE 1584"
 * gap-analysis engine (Slice 2 centerpiece, reworked in 2.6 for how studies are
 * ACTUALLY data-collected, per the field-PE review).
 *
 * Per-bus required inputs, framed as a field collector gathers them:
 *   nominalVoltage   — system voltage at the bus.
 *   faultCurrent     — available fault current at the bus (from the short-circuit
 *                      study / utility), OR the feeder CABLE length + size to
 *                      compute it from the upstream source.
 *   protectiveDevice — the upstream device's rating + trip SETTINGS (breaker
 *                      frame/sensor + LSIG, or fuse class/rating). Clearing time
 *                      is DERIVED from these via the device TCC, so an explicit
 *                      clearing time also satisfies it.
 * These are must-obtain (collected down to 480V panels; a tech opens the door to
 * read the device). The TYPICAL set — electrode config, conductor gap, working
 * distance — is pre-populated from IEEE 1584-2018 by equipment class.
 *
 * IMPORTANT (engineering-guidelines #7): confidence is DETERMINISTIC from input
 * presence/plausibility — never an LLM's self-reported confidence.
 *
 * SC is the DATA layer; a licensed PE runs + stamps the study (in SKM/ETAP/
 * EasyPower). Every defaulted value is surfaced as "typical — confirm".
 */

'use strict';

export const MUST_OBTAIN = ['nominalVoltage', 'faultCurrent', 'protectiveDevice'];
export const TYPICAL = ['electrodeConfig', 'conductorGapMm', 'workingDistanceIn'];

const FIELD_LABEL: Record<string, string> = {
  nominalVoltage:    'System voltage',
  faultCurrent:      'Available fault current',
  protectiveDevice:  'Upstream device + trip settings',
  electrodeConfig:   'Electrode configuration',
  conductorGapMm:    'Conductor gap',
  workingDistanceIn: 'Working distance',
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

// A value "counts" as present only if usable: a finite non-negative number, a
// non-empty object (e.g. device settings JSON), or a non-empty string.
function present(v: any): boolean {
  if (v == null || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

function equipFamily(equipmentType: any): string {
  const t = String(equipmentType || '').toUpperCase();
  if (t === 'SWITCHGEAR' || t === 'SWITCHBOARD') return 'switchgear';
  if (t === 'MCC' || t === 'PANELBOARD' || t === 'VFD' || t === 'BUSWAY') return 'mcc_panel';
  if (t === 'CABLE_LV' || t === 'CABLE_MV_HV') return 'cable';
  return 'other';
}

function voltageClass(volts: number | null): string | null {
  if (volts == null) return null;
  if (volts <= 600) return 'lv';
  if (volts <= 5000) return 'mv5';
  return 'mv15';
}

// IEEE 1584-2018 typical electrode config / conductor gap / working distance by
// equipment class — representative figures used to pre-populate a draft; always
// confirmed by the engineer.
export function ieee1584Defaults(equipmentType: any, nominalVoltage: any): any {
  const fam = equipFamily(equipmentType);
  const vc = voltageClass(parseVolts(nominalVoltage));
  if (fam === 'cable') {
    return { available: true, className: 'Cable', electrodeConfig: 'VCB', conductorGapMm: 13, workingDistanceIn: 18, note: 'IEEE 1584-2018 typical for cable — confirm.' };
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
  return { available: false, className: 'Unknown equipment class', note: vc == null ? 'Confirm equipment type and system voltage to pre-fill typical gap / working distance.' : 'Confirm equipment type to pre-fill typical gap / working distance.' };
}

// Evaluate the three composite must-obtain inputs for a bus.
function evalMusts(bus: any) {
  const voltageOk = present(bus.nominalVoltage);

  const faultDirect = present(bus.boltedFaultCurrentKA);
  const cableOk = present(bus.cableLengthFt) && present(bus.cableSize);
  const faultOk = faultDirect || cableOk;

  // protectiveDevice: clearing time can be given directly, computed from
  // adjustable trip SETTINGS, or — for a FUSE or a fixed-trip (thermal-magnetic)
  // breaker — derived from the device's published TCC once type + frame/rating
  // are known. Recorded settings are only obtainable (and required) for an
  // ADJUSTABLE electronic trip unit or a protective relay; a field tech can't
  // read "settings" off a molded-case thermal-mag breaker or a fuse — type +
  // rating IS the complete field record there.
  const devType = String(bus.deviceType || '').toLowerCase();
  const hasSettings = present(bus.deviceSettings);
  const hasDeviceRating = present(bus.deviceRatingA);
  const clearingDirect = present(bus.clearingTimeMs);
  const fixedTrip = devType === 'fuse' || devType === 'breaker' || devType === 'switch';
  let deviceOk: boolean;
  let deviceVia: string | null;
  let deviceNote: string;
  if (clearingDirect) {
    deviceOk = true; deviceVia = 'explicit clearing time'; deviceNote = 'Clearing time provided directly.';
  } else if (hasSettings && present(bus.deviceType) && hasDeviceRating) {
    deviceOk = true; deviceVia = 'device + settings'; deviceNote = 'Device rating + trip settings provided.';
  } else if (devType === 'relay') {
    deviceOk = false; deviceVia = null; deviceNote = 'Record the protective relay settings (pickup / time-dial / curve).';
  } else if (fixedTrip && hasDeviceRating) {
    deviceOk = true; deviceVia = 'device identified (TCC)';
    deviceNote = 'Device identified (type + frame/rating); clearing time derives from its published TCC. Confirm trip settings only if it is an adjustable electronic trip unit.';
  } else {
    deviceOk = false; deviceVia = null;
    deviceNote = 'Record the upstream protective device: type + frame/sensor rating (plus trip settings if it has an adjustable electronic trip unit), or fuse class + rating.';
  }

  return {
    nominalVoltage: { ok: voltageOk, via: voltageOk ? 'provided' : null,
      note: voltageOk ? 'Provided.' : 'Read the system voltage at this bus off the one-line.' },
    faultCurrent: { ok: faultOk, via: faultDirect ? 'study/utility value' : cableOk ? 'computable from feeder cable' : null,
      note: faultOk ? (faultDirect ? 'Provided (study/utility).' : 'Will be computed from the feeder cable + upstream source.')
        : 'Obtain the available fault current (short-circuit study / utility), OR record the feeder cable length + size so it can be computed from upstream.' },
    protectiveDevice: { ok: deviceOk, via: deviceVia, note: deviceNote },
  };
}

// Analyze one bus: classify required inputs, apply typical defaults where the
// equipment class allows, roll up readiness + a deterministic confidence band.
export function analyzeBusGaps(bus: any): any {
  const defaults = ieee1584Defaults(bus.equipmentTypeGuess, bus.nominalVoltage);
  const equipmentKnown = equipFamily(bus.equipmentTypeGuess) !== 'other';
  const musts = evalMusts(bus);

  const fields: any[] = [];
  const missingRequired: string[] = [];
  const defaultsApplied: string[] = [];

  for (const key of MUST_OBTAIN) {
    const m = (musts as any)[key];
    fields.push({ field: key, label: FIELD_LABEL[key], category: 'must_obtain', status: m.ok ? 'present' : 'missing', via: m.via, note: m.note });
    if (!m.ok) missingRequired.push(key);
  }

  const defaultFor: Record<string, any> = { electrodeConfig: defaults.electrodeConfig, conductorGapMm: defaults.conductorGapMm, workingDistanceIn: defaults.workingDistanceIn };
  for (const f of TYPICAL) {
    if (present(bus[f])) {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'present', value: bus[f], note: 'Provided.' });
    } else if (defaults.available && defaultFor[f] != null) {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'defaulted', value: null, defaultValue: defaultFor[f], note: defaults.note });
      defaultsApplied.push(f);
    } else {
      fields.push({ field: f, label: FIELD_LABEL[f], category: 'typical', status: 'missing', value: null, note: defaults.note });
      missingRequired.push(f);
    }
  }

  const mustMissing = MUST_OBTAIN.some((k) => !(musts as any)[k].ok);
  const typicalUndefaultable = TYPICAL.some((f) => !present(bus[f]) && !(defaults.available && defaultFor[f] != null));
  const allPresent = !mustMissing && TYPICAL.every((f) => present(bus[f]));

  let readiness: string;
  if (mustMissing || typicalUndefaultable) readiness = 'blocked';
  else if (allPresent) readiness = 'ready';
  else readiness = 'defaultable';

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

// System/utility-level gaps: the utility available fault current (max + min) and
// X/R at the point of common coupling are the source of the whole fault tree.
export function analyzeSystemGaps(systemMeta: any): any {
  const sm = systemMeta || {};
  const u = sm.utility || {};
  const items = [
    { field: 'utilityMaxFaultKA', label: 'Utility max available fault current (PCC)', ok: present(u.maxFaultKA), note: 'From the utility, at the point of common coupling (service entrance).' },
    { field: 'utilityMinFaultKA', label: 'Utility min available fault current (PCC)', ok: present(u.minFaultKA), note: 'Min case drives the worst arcing duration; request both from the utility.' },
    { field: 'utilityXR', label: 'Utility X/R ratio (PCC)', ok: present(u.xr), note: 'X/R at the service entrance, from the utility.' },
  ];
  return { items, missing: items.filter((i) => !i.ok).map((i) => i.field), complete: items.every((i) => i.ok) };
}

// Roll up per-bus bands into the ingest-level summary (worst band wins).
// readyBusCount = buses whose must-obtain field data is fully collected (not
// blocked) — typicals may still be IEEE-defaulted.
export function summarizeIngestBands(results: any[]): any {
  let overall = 'green';
  let ready = 0;
  for (const r of results) {
    if (r.readiness !== 'blocked') ready++;
    if (r.confidence === 'red') overall = 'red';
    else if (r.confidence === 'yellow' && overall !== 'red') overall = 'yellow';
  }
  return { overallBand: results.length ? overall : 'red', readyBusCount: ready, totalBusCount: results.length };
}
