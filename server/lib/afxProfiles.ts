'use strict';

/**
 * afxProfiles.ts — per-tool crosswalk for AFX (v1.1).
 *
 * Maps AFX field keys to the REAL column names used by the major tools, grounded
 * in vendor artifacts:
 *   - ARCAD "Arc Flash Data Collection Form" (flat IEEE 1584 input list)
 *   - EasyPower's published SKM import-mapping templates, which expose BOTH the
 *     SKM `<Column>` source names and the EasyPower field names.
 *
 * Powers two things: (1) the ingest engine "pre-understands" a vendor file (its
 * headers are recognized via the alias index), and (2) downloadable per-tool
 * templates so a customer can hand the PE a tool-shaped file without re-keying.
 * Where units differ (e.g. ARCAD working distance is mm; AFX uses inches), the
 * crosswalk records a `note` rather than silently converting.
 */

const { AFX_FIELDS } = require('./arcFlashAfx');

// AFX key -> { arcad, skm, easypower } header + optional note. Only real
// correspondences are listed (honest: blank where a tool computes it / lacks it).
const CROSSWALK: Record<string, any> = {
  busName: { skm: '<Component Name>', easypower: 'Description' },
  equipmentType: { skm: '<Component Type>', easypower: 'Type' },
  nominalVoltageV: { arcad: 'System voltage, V', skm: '<SystemNominalVoltage>', easypower: 'SystemNominalVoltage' },
  boltedFaultCurrentKA: { arcad: 'Available 3-phase short circuit current (ASCC), kA' },
  arcingCurrentKA: { arcad: 'Part of ASCC through upstream protection device, kA' },
  electrodeConfig: { arcad: 'Electrode configuration (VCB | VCCB | HCB | VOA | HOA)', note: 'ARCAD writes VCCB for the standard VCBB.' },
  conductorGapMm: { arcad: 'Gap between exposed conductors, mm.' },
  workingDistanceIn: { arcad: 'Working distance, mm.', note: 'ARCAD uses mm; AFX uses inches — convert (1 in = 25.4 mm).' },
  enclosureType: { arcad: 'Enclosure dimensions HxWxD, mm.', easypower: 'Enclosure', note: 'ARCAD gives H x W x D dimensions; AFX/EasyPower use an enclosure class.' },
  incidentEnergyCalCm2: { arcad: 'Incident energy @ AFB, cal/cm2' },
  deviceModel: { arcad: 'Upstream protection device', skm: '<Frame/Model>', easypower: 'EZPType' },
  deviceManufacturer: { skm: '<Manufacturer>', easypower: 'EZPMfr' },
  deviceRatingA: { skm: '<Frame/Rating>', easypower: 'EZPTripSensorFrame' },
  deviceSettings: { skm: '<Settings>', easypower: 'EZPLTPUSetting', note: 'EasyPower splits settings across EZPLTPU/STPU/Inst/Gnd columns; AFX keeps one JSON.' },
  cableLengthFt: { skm: '<Length>', easypower: 'Length' },
  cableSize: { skm: '<CableSize>', easypower: 'CableSize' },
  cableMaterial: { skm: '<ConductorType>', easypower: 'ConductorMaterial', note: 'EasyPower uses C/A; AFX uses Cu/Al.' },
  conductorsPerPhase: { skm: '<QtyPerPhase>', easypower: 'NumberPerPhase' },
  conduitType: { skm: '<RacewayType>', easypower: 'RacewayType' },
  transformerKva: { skm: '<Nominal kVA>', easypower: 'Nominal kVA' },
  transformerSecondaryV: { skm: '<SystemNominalVoltageSecondary>', easypower: 'SystemNominalVoltageSecondary' },
};

const TOOLS = ['arcad', 'skm', 'easypower'];
const TOOL_LABEL: Record<string, string> = { arcad: 'ARCAD Arc Flash Analytic', skm: 'SKM Power*Tools (PTW)', easypower: 'EasyPower' };

// Lowercased alias header -> AFX key. Lets the validator/ingest recognize a
// vendor file's columns in addition to AFX's own headers + keys.
function buildAliasIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [key, m] of Object.entries(CROSSWALK)) {
    for (const tool of TOOLS) {
      if (m[tool]) idx.set(String(m[tool]).trim().toLowerCase(), key);
    }
  }
  return idx;
}

// Per-tool template = the AFX fields that tool covers, with its header names.
function buildToolTemplate(tool: string): any {
  const t = String(tool || '').toLowerCase();
  if (!TOOLS.includes(t)) return null;
  const fields = AFX_FIELDS
    .filter((f: any) => CROSSWALK[f.key] && CROSSWALK[f.key][t])
    .map((f: any) => ({ afxKey: f.key, header: CROSSWALK[f.key][t], unit: f.unit || null, note: CROSSWALK[f.key].note || null }));
  return { tool: t, label: TOOL_LABEL[t], fieldCount: fields.length, fields };
}

// 2026-07-13 (pre-go-live review N3 follow-up): not currently reachable with
// attacker data -- toolTemplateCsv() only ever renders static CROSSWALK
// labels, never account/user data -- but align with the shared, H6-guarded
// csvCell (exportHelpers.ts) anyway so this local copy can't become an
// exploitable gap if a future change starts feeding it real data.
const { csvCell } = require('./exportHelpers');

// A header row of the tool's column names + one blank sample row.
function toolTemplateCsv(tool: string): string | null {
  const t = buildToolTemplate(tool);
  if (!t) return null;
  const header = t.fields.map((f: any) => csvCell(f.header)).join(',');
  const blank = t.fields.map(() => '').join(',');
  return [header, blank].join('\r\n');
}

module.exports = { CROSSWALK, TOOLS, TOOL_LABEL, buildAliasIndex, buildToolTemplate, toolTemplateCsv };

export {};
