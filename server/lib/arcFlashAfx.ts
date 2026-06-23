'use strict';

/**
 * arcFlashAfx.ts — AFX: the open Arc Flash Data Exchange standard (v1).
 *
 * A documented, versioned schema for moving arc-flash study + label data between
 * tools, anchored on the IEEE 1584-2018 INPUT set and the NFPA 70E 130.5(H) label
 * OUTPUT set (not on any one vendor's quirks). ServiceCycle exports this as its
 * default format and offers a conformance validator so a file can be checked
 * before anyone relies on it. The field KEYS align 1:1 with lib/arcFlashExport
 * EXPORT_COLUMNS, so the export IS AFX (a test asserts they stay in sync).
 *
 * SC is the data layer: AFX carries inputs + captured outputs; it does not imply
 * SC ran the IEEE 1584 calculation.
 */

const AFX_VERSION = '1.0';

const ENUMS: Record<string, string[]> = {
  electrodeConfig: ['VCB', 'VCBB', 'HCB', 'VOA', 'HOA'],
  tripUnitType: ['none', 'thermal_magnetic', 'electronic_lsi', 'electronic_lsig'],
  fuseClass: ['L', 'RK1', 'RK5', 'J', 'T', 'CC', 'G', 'CF', 'H', 'K', 'other'],
  enclosureType: ['panelboard', 'mcc', 'lv_switchgear', 'mv_switchgear', 'cable', 'open_air', 'other'],
  cableMaterial: ['Cu', 'Al'],
  deviceType: ['breaker', 'fuse', 'relay', 'switch'],
};

// AFX field catalog. type: string | number | enum | json. group + standard are
// documentation; required is the minimum to identify a usable bus row.
const AFX_FIELDS: any[] = [
  { key: 'site', header: 'Site', group: 'identity', type: 'string', standard: null, required: false },
  { key: 'busName', header: 'Bus', group: 'identity', type: 'string', standard: null, required: true },
  { key: 'equipmentType', header: 'Equipment Type', group: 'identity', type: 'string', standard: null, required: false },

  { key: 'nominalVoltageV', header: 'Nominal Voltage (V)', group: 'ieee1584_input', unit: 'V', type: 'number', standard: 'IEEE 1584-2018', required: true },
  { key: 'boltedFaultCurrentKA', header: 'Bolted Fault (kA)', group: 'ieee1584_input', unit: 'kA', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'arcingCurrentKA', header: 'Arcing Current (kA)', group: 'ieee1584_input', unit: 'kA', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'electrodeConfig', header: 'Electrode Config', group: 'ieee1584_input', type: 'enum', enum: ENUMS.electrodeConfig, standard: 'IEEE 1584-2018', required: false },
  { key: 'conductorGapMm', header: 'Gap (mm)', group: 'ieee1584_input', unit: 'mm', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'workingDistanceIn', header: 'Working Distance (in)', group: 'ieee1584_input', unit: 'in', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'clearingTimeMs', header: 'Clearing Time (ms)', group: 'ieee1584_input', unit: 'ms', type: 'number', standard: 'IEEE 1584-2018', required: false },

  { key: 'deviceType', header: 'Upstream Device', group: 'protective_device', type: 'enum', enum: ENUMS.deviceType, standard: null, required: false },
  { key: 'tripUnitType', header: 'Trip Unit', group: 'protective_device', type: 'enum', enum: ENUMS.tripUnitType, standard: null, required: false },
  { key: 'fuseClass', header: 'Fuse Class', group: 'protective_device', type: 'enum', enum: ENUMS.fuseClass, standard: null, required: false },
  { key: 'deviceManufacturer', header: 'Device Mfr', group: 'protective_device', type: 'string', standard: null, required: false },
  { key: 'deviceModel', header: 'Device Model', group: 'protective_device', type: 'string', standard: null, required: false },
  { key: 'deviceRatingA', header: 'Device Rating (A)', group: 'protective_device', unit: 'A', type: 'number', standard: null, required: false },
  { key: 'deviceSettings', header: 'Trip Settings (JSON)', group: 'protective_device', type: 'json', standard: null, required: false },

  { key: 'cableLengthFt', header: 'Cable Length (ft)', group: 'cable', unit: 'ft', type: 'number', standard: null, required: false },
  { key: 'cableSize', header: 'Cable Size', group: 'cable', type: 'string', standard: null, required: false },
  { key: 'cableMaterial', header: 'Cable Material', group: 'cable', type: 'enum', enum: ENUMS.cableMaterial, standard: null, required: false },
  { key: 'conductorsPerPhase', header: 'Conductors / Phase', group: 'cable', type: 'number', standard: null, required: false },
  { key: 'conduitType', header: 'Conduit', group: 'cable', type: 'string', standard: null, required: false },

  { key: 'enclosureType', header: 'Enclosure', group: 'ieee1584_input', type: 'enum', enum: ENUMS.enclosureType, standard: 'IEEE 1584-2018', required: false },

  { key: 'utilityMaxFaultKA', header: 'Utility Max Fault (kA)', group: 'source_model', unit: 'kA', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'utilityMinFaultKA', header: 'Utility Min Fault (kA)', group: 'source_model', unit: 'kA', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'utilityXr', header: 'Utility X/R', group: 'source_model', type: 'number', standard: 'IEEE 1584-2018', required: false },
  { key: 'transformerKva', header: 'Transformer (kVA)', group: 'source_model', unit: 'kVA', type: 'number', standard: null, required: false },
  { key: 'transformerImpedancePct', header: 'Transformer %Z', group: 'source_model', unit: '%', type: 'number', standard: null, required: false },
  { key: 'transformerPrimaryV', header: 'Transformer Primary (V)', group: 'source_model', unit: 'V', type: 'number', standard: null, required: false },
  { key: 'transformerSecondaryV', header: 'Transformer Secondary (V)', group: 'source_model', unit: 'V', type: 'number', standard: null, required: false },

  { key: 'incidentEnergyCalCm2', header: 'Incident Energy (cal/cm2)', group: 'label_output', unit: 'cal/cm2', type: 'number', standard: 'NFPA 70E 130.5(H)', required: false },
  { key: 'arcFlashBoundaryIn', header: 'Arc Flash Boundary (in)', group: 'label_output', unit: 'in', type: 'number', standard: 'NFPA 70E 130.5(H)', required: false },
  { key: 'ppeCategory', header: 'PPE Category', group: 'label_output', type: 'number', standard: 'NFPA 70E 130.5(H)', required: false },
  { key: 'requiredArcRatingCalCm2', header: 'Required Arc Rating (cal/cm2)', group: 'label_output', unit: 'cal/cm2', type: 'number', standard: 'NFPA 70E 130.5(H)', required: false },
];

const GROUPS: Record<string, string> = {
  identity: 'Identity — which equipment this row describes',
  ieee1584_input: 'IEEE 1584-2018 calculation inputs',
  protective_device: 'Upstream protective device (drives clearing time via its TCC)',
  cable: 'Feeder cable / conduit',
  source_model: 'Utility / transformer source model',
  label_output: 'NFPA 70E 130.5(H) label outputs (captured, not computed by SC)',
};

function buildAfxSpec(): any {
  return {
    afxVersion: AFX_VERSION,
    name: 'Arc Flash Data Exchange (AFX)',
    description: 'An open, versioned CSV/JSON schema for arc-flash study + label data, anchored on IEEE 1584-2018 inputs and NFPA 70E 130.5(H) label outputs.',
    standardsBasis: ['IEEE 1584-2018', 'NFPA 70E-2024 §130.5(H)'],
    disclaimer: 'AFX carries collected inputs and captured label outputs. It does not imply the exporting system ran or stamped the IEEE 1584 study — a licensed PE owns the calculation.',
    rowGranularity: 'one row per bus / equipment',
    groups: Object.entries(GROUPS).map(([id, label]) => ({ id, label })),
    fields: AFX_FIELDS.map((f) => ({
      key: f.key, header: f.header, group: f.group, type: f.type,
      unit: f.unit || null, standard: f.standard || null, required: !!f.required,
      ...(f.enum ? { enum: f.enum } : {}),
    })),
  };
}

function isFiniteNum(v: any): boolean {
  if (v == null || v === '') return false;
  return Number.isFinite(Number(v));
}

/**
 * Validate a parsed table against AFX. Pure + deterministic.
 * @param headers string[] (as found in the file)
 * @param rows    array of objects keyed by header (string values)
 * Returns recognized/unknown columns, missing required fields, and per-row type
 * issues (capped), plus a pass/fail.
 */
function validateAfxRows(headers: string[], rows: any[], opts: any = {}): any {
  const maxIssues = opts.maxIssues || 200;
  // Index AFX fields by lowercased header AND key for tolerant matching.
  const byHeader = new Map<string, any>();
  for (const f of AFX_FIELDS) {
    byHeader.set(f.header.toLowerCase(), f);
    byHeader.set(f.key.toLowerCase(), f);
  }
  const recognized: any[] = [];
  const unknown: string[] = [];
  const headerToField = new Map<string, any>();
  for (const h of headers || []) {
    const f = byHeader.get(String(h).trim().toLowerCase());
    if (f) { recognized.push({ header: h, key: f.key }); headerToField.set(h, f); }
    else unknown.push(h);
  }
  const presentKeys = new Set(recognized.map((r) => r.key));
  const missingRequired = AFX_FIELDS.filter((f) => f.required && !presentKeys.has(f.key)).map((f) => ({ key: f.key, header: f.header }));

  const rowIssues: any[] = [];
  const rowList = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < rowList.length && rowIssues.length < maxIssues; i++) {
    const row = rowList[i] || {};
    for (const [header, f] of headerToField.entries()) {
      const raw = row[header];
      if (raw == null || String(raw).trim() === '') continue; // empty is allowed
      if (f.type === 'number' && !isFiniteNum(raw)) {
        rowIssues.push({ row: i + 1, column: header, value: String(raw), issue: 'not a number' });
      } else if (f.type === 'enum' && f.enum) {
        const ok = f.enum.some((e: string) => e.toLowerCase() === String(raw).trim().toLowerCase());
        if (!ok) rowIssues.push({ row: i + 1, column: header, value: String(raw), issue: `not in {${f.enum.join('|')}}` });
      } else if (f.type === 'json') {
        try { JSON.parse(String(raw)); } catch { rowIssues.push({ row: i + 1, column: header, value: String(raw).slice(0, 40), issue: 'not valid JSON' }); }
      }
    }
  }

  const ok = missingRequired.length === 0 && rowIssues.length === 0;
  return {
    afxVersion: AFX_VERSION,
    ok,
    summary: {
      rowCount: rowList.length,
      recognizedColumns: recognized.length,
      unknownColumns: unknown.length,
      missingRequired: missingRequired.length,
      rowIssues: rowIssues.length,
      truncatedIssues: rowIssues.length >= maxIssues,
    },
    recognized,
    unknownColumns: unknown,
    missingRequired,
    rowIssues,
  };
}

// Minimal RFC-4180-ish parser → string[][] (quotes, commas, CRLF). Self-contained
// so the validator has no cross-lib dependency.
function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* swallow; \n handles the break */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}

/**
 * Parse a CSV string and validate it against AFX. Returns the same shape as
 * validateAfxRows plus the detected headers.
 */
function validateAfxCsv(text: string, opts: any = {}): any {
  const table = parseDelimited(text);
  if (table.length === 0) {
    return { afxVersion: AFX_VERSION, ok: false, error: 'empty file', summary: { rowCount: 0, recognizedColumns: 0, unknownColumns: 0, missingRequired: 0, rowIssues: 0 }, recognized: [], unknownColumns: [], missingRequired: [], rowIssues: [] };
  }
  const headers = table[0].map((h) => String(h).trim());
  const rows = table.slice(1).map((cells) => {
    const o: any = {};
    headers.forEach((h, idx) => { o[h] = cells[idx]; });
    return o;
  });
  return { headers, ...validateAfxRows(headers, rows, opts) };
}

module.exports = { AFX_VERSION, AFX_FIELDS, ENUMS, buildAfxSpec, validateAfxRows, parseDelimited, validateAfxCsv };

export {};
