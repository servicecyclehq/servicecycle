'use strict';

/**
 * lib/importMapping.ts -- pure column-mapping + row-validation engine for the
 * SMART asset importer (routes/importAssets.ts).
 *
 * "Frictionless data-in": a contractor uploads whatever spreadsheet they
 * already have; this module figures out which column is which. Three tiers:
 *
 *   exact    normalized header equals a target field key or display label
 *            (confidence 1.0)
 *   synonym  normalized header hits the curated alias table -- "mfr" ->
 *            manufacturer, "s/n" -> serialNumber, "facility" -> siteName ...
 *            (confidence 0.85; content-boosted equipment-type columns 0.9)
 *   ai       unresolved headers go to lib/ai (task 'classify') with 3 sample
 *            values each; the model returns { field, confidence } per header.
 *            MUST fail soft: AI_ENABLED=false, a missing key, a provider
 *            outage, or malformed JSON all degrade to deterministic-only.
 *            AI NEVER blocks an import.
 *
 * Everything in here is PURE (no prisma, no express): parsing, guessing,
 * per-row coercion/validation. The route owns tenancy, duplicate lookups,
 * site resolution, and persistence. Field keys deliberately mirror
 * routes/assetsImport.ts (the template importer) so the two vocabularies
 * stay mergeable; equipment-type fuzzy matching is a compact re-derivation
 * on top of lib/equipmentTypes (assetsImport's table is not exported from
 * that router module).
 *
 * Custom fields: targets with key `cf:<definitionId>` map a column onto an
 * EXISTING active CustomFieldDefinition. Value validation for those is
 * injected by the route (validateValueForDefinition from routes/customFields)
 * so the import can never drift from the Settings CRUD rules.
 */

const Papa = require('papaparse');
const { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABELS } = require('./equipmentTypes');

// Caps shared with the route (and mirrored by routes/assetsImport.ts).
const MAX_IMPORT_ROWS  = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const SAMPLES_PER_COLUMN = 3;
const AI_MIN_CONFIDENCE  = 0.4;  // proposals below this stay unmapped
const AI_MAX_COLUMNS     = 40;   // never ship a monster prompt

// ---------------------------------------------------------------------------
// Target field vocabulary
// ---------------------------------------------------------------------------
// Keys mirror routes/assetsImport.ts SCHEMA_FIELDS, plus two nameplate
// passthrough fields (voltage / kva land in Asset.nameplateData -- facility
// sheets almost always carry them and dropping them loses trust).
const TARGET_FIELDS: any[] = [
  { key: 'siteName',             label: 'Site (lookup by name)',   type: 'siteName', required: true },
  { key: 'equipmentType',        label: 'Equipment Type',          type: 'enum',     required: true, options: EQUIPMENT_TYPES },
  { key: 'buildingName',         label: 'Building',                type: 'string' },
  { key: 'areaName',             label: 'Area',                    type: 'string' },
  { key: 'positionName',         label: 'Position',                type: 'string' },
  { key: 'manufacturer',         label: 'Manufacturer',            type: 'string' },
  { key: 'model',                label: 'Model',                   type: 'string' },
  { key: 'serialNumber',         label: 'Serial Number',           type: 'string' },
  { key: 'installDate',          label: 'Install Date',            type: 'date' },
  { key: 'conditionPhysical',    label: 'Condition - Physical',    type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'conditionCriticality', label: 'Condition - Criticality', type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'conditionEnvironment', label: 'Condition - Environment', type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'inService',            label: 'In Service',              type: 'boolean' },
  { key: 'criticalityScore',     label: 'Criticality Score (1-5)', type: 'number' },
  { key: 'conditionScore',       label: 'Condition Score (1-5)',   type: 'number' },
  { key: 'repairCostEstimate',   label: 'Repair Cost Estimate',    type: 'number' },
  { key: 'spareLeadTimeWeeks',   label: 'Spare Lead Time (weeks)', type: 'number' },
  { key: 'redundancyStatus',     label: 'Redundancy Status',       type: 'enum', options: ['N', 'N_PLUS_1', 'TWO_N'] },
  { key: 'requiresPredictiveMaintenance', label: 'Predictive Maintenance Required', type: 'boolean' },
  { key: 'voltage',              label: 'Voltage (nameplate)',     type: 'string' },
  { key: 'kva',                  label: 'kVA Rating (nameplate)',  type: 'string' },
  { key: 'notes',                label: 'Notes',                   type: 'string' },
];
const CORE_TARGET_KEYS = new Set(TARGET_FIELDS.map((f) => f.key));

/** Shape active CustomFieldDefinitions into mapping targets (key cf:<id>). */
function customFieldTargets(defs: any[]): any[] {
  return (defs || [])
    .filter((d) => d && d.id && !d.archivedAt)
    .map((d) => ({
      key:      `cf:${d.id}`,
      label:    `Custom: ${d.name}`,
      type:     `custom_${d.type}`,
      options:  d.type === 'select' && Array.isArray(d.options) ? d.options.map((o) => o.value) : undefined,
      required: false,
    }));
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/** Fold a header for matching: lowercase, strip everything non-alphanumeric. */
function normToken(s: any): string {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Canonical serial form for duplicate matching. Mirrors
 * lib/assetIdentity.normalizeSerial exactly (uppercase, strip separators,
 * O->0, I->1); re-derived here so this module stays prisma-free.
 * Intentionally conservative -- no B/8, S/5, Z/2 folds.
 */
function normalizeSerial(raw: any): string {
  if (raw == null) return '';
  return String(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/I/g, '1');
}

/**
 * Formula-injection guard for free-text values on the way IN (audit Cluster A
 * P2 convention shared with routes/assetsImport.ts): a leading = + - @ tab or
 * CR gets a literal apostrophe prefix so re-exported CSVs are inert.
 */
function sanitizeFormulaPrefix(v: any): any {
  if (v == null) return v;
  if (typeof v !== 'string') return v;
  if (/^\s*[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

// ---------------------------------------------------------------------------
// Equipment-type fuzzy matching (enum values + labels + aliases + heuristics)
// ---------------------------------------------------------------------------

const EQUIPMENT_ALIASES: any = {
  TRANSFORMER_LIQUID:      ['liquid transformer', 'liquid-filled transformer', 'oil transformer', 'oil-filled transformer', 'wet transformer', 'xfmr liquid', 'oil xfmr'],
  TRANSFORMER_DRY:         ['dry transformer', 'dry-type transformer', 'cast coil transformer', 'dry xfmr'],
  SWITCHGEAR:              ['swgr', 'switch gear'],
  SWITCHBOARD:             ['swbd', 'switch board', 'main switchboard', 'distribution switchboard'],
  PANELBOARD:              ['panel', 'panel board', 'pnl', 'distribution panel', 'lighting panel', 'branch panel'],
  BUSWAY:                  ['bus duct', 'busduct', 'bus way', 'bus bar duct'],
  GENERATOR:               ['genset', 'gen set', 'emergency generator', 'standby generator'],
  MCC:                     ['motor control center', 'motor control centre'],
  UPS_BATTERY:             ['ups', 'ups system', 'uninterruptible power supply'],
  BATTERY_SYSTEM:          ['battery', 'battery string', 'battery bank', 'station battery', 'battery charger', 'dc system'],
  CIRCUIT_BREAKER:         ['breaker', 'circuit brkr', 'cb'],
  FUSE_GEAR:               ['fuse', 'fuses', 'fusible switch', 'fused switch'],
  DISCONNECT_SWITCH:       ['disconnect', 'load break switch', 'safety switch', 'isolation switch'],
  TRANSFER_SWITCH:         ['ats', 'transfer switch', 'automatic transfer switch', 'manual transfer switch'],
  PROTECTION_RELAY:        ['relay', 'protective relay', 'protection relays', 'sel relay'],
  GROUND_FAULT_PROTECTION: ['ground fault', 'ground fault protection', 'gfp', 'ground fault relay'],
  SURGE_ARRESTER:          ['surge arrestor', 'lightning arrester', 'lightning arrestor', 'tvss', 'spd', 'surge protective device'],
  CABLE_LV:                ['lv cable', 'low voltage cable', 'lv feeder', '600v cable'],
  CABLE_MV_HV:             ['mv cable', 'hv cable', 'medium voltage cable', 'high voltage cable', 'mv feeder'],
  CABLE_TRAY:              ['tray', 'cable trays', 'cable ladder'],
  GROUNDING_SYSTEM:        ['ground', 'grounding', 'ground grid', 'earthing system', 'ground electrode'],
  EMERGENCY_LIGHTING:      ['emergency light', 'emergency lights', 'egress lighting', 'exit light', 'exit sign', 'em lighting'],
  ARC_FLASH_PANEL:         ['arc flash'],
  VFD:                     ['variable frequency drive', 'adjustable speed drive', 'vsd', 'drive'],
  FIRE_PUMP_CONTROLLER:    ['fire pump', 'fire pump ctrl'],
};

const EQUIPMENT_TYPE_LOOKUP: Map<string, string> = (() => {
  const m = new Map();
  for (const [val, label] of Object.entries<any>(EQUIPMENT_TYPE_LABELS)) {
    m.set(normToken(val), val);
    m.set(normToken(label), val);
  }
  for (const [val, list] of Object.entries<any>(EQUIPMENT_ALIASES)) {
    for (const a of list) {
      const k = normToken(a);
      if (!m.has(k)) m.set(k, val);
    }
  }
  return m;
})();

/**
 * Resolve a raw equipment-type cell to an enum value or null. Rule ORDER
 * mirrors routes/assetsImport.ts matchEquipmentType and is load-bearing
 * ('arc flash' before 'panel', 'ground fault' before 'ground', 'cable tray'
 * before the cable voltage split, 'ups' before 'battery').
 */
function matchEquipmentType(rawCell: any): string | null {
  const exact = EQUIPMENT_TYPE_LOOKUP.get(normToken(rawCell));
  if (exact) return exact;

  const s = String(rawCell == null ? '' : rawCell).toLowerCase();
  if (!s.trim()) return null;
  const has = (...words: string[]) => words.some((w) => s.includes(w));

  if (has('arc flash'))                                   return 'ARC_FLASH_PANEL';
  if (has('fire pump'))                                   return 'FIRE_PUMP_CONTROLLER';
  if (has('vfd', 'variable frequency', 'adjustable speed')) return 'VFD';
  if (has('motor control') || /\bmcc\b/.test(s))          return 'MCC';
  if (/\bground\s*fault\b/.test(s) || /\bgfp\b/.test(s))  return 'GROUND_FAULT_PROTECTION';
  if (/\bground(ing)?\b/.test(s) || has('earthing'))      return 'GROUNDING_SYSTEM';
  if (has('emergency light', 'egress', 'exit light', 'exit sign')) return 'EMERGENCY_LIGHTING';
  if (has('transfer switch') || /\bats\b/.test(s))        return 'TRANSFER_SWITCH';
  if (has('busway', 'bus duct', 'busduct'))               return 'BUSWAY';
  if (has('cable tray'))                                  return 'CABLE_TRAY';
  if (has('cable', 'feeder')) {
    if (has('mv', 'hv', 'medium voltage', 'high voltage')) return 'CABLE_MV_HV';
    const kv = s.match(/(\d+(?:\.\d+)?)\s*kv\b/);
    if (kv && parseFloat(kv[1]) > 0.6) return 'CABLE_MV_HV';
    const v = s.match(/(\d+)\s*v(?:olts?)?\b/);
    if (v && parseInt(v[1], 10) > 600) return 'CABLE_MV_HV';
    return 'CABLE_LV';
  }
  if (has('relay'))                                       return 'PROTECTION_RELAY';
  if (has('disconnect', 'load break', 'safety switch'))   return 'DISCONNECT_SWITCH';
  if (has('switchboard', 'switch board'))                 return 'SWITCHBOARD';
  if (has('switchgear', 'switch gear'))                   return 'SWITCHGEAR';
  if (has('panelboard', 'panel'))                         return 'PANELBOARD';
  if (has('transformer') || /\bxfmr\b/.test(s)) {
    return has('dry', 'cast coil') ? 'TRANSFORMER_DRY' : 'TRANSFORMER_LIQUID';
  }
  if (has('ups', 'uninterruptible'))                      return 'UPS_BATTERY';
  if (has('battery'))                                     return 'BATTERY_SYSTEM';
  if (has('generator', 'genset'))                         return 'GENERATOR';
  if (has('surge', 'lightning arrest'))                   return 'SURGE_ARRESTER';
  if (has('fuse'))                                        return 'FUSE_GEAR';
  if (has('breaker'))                                     return 'CIRCUIT_BREAKER';
  if (has('motor'))                                       return 'MOTOR';

  return null;
}

// ---------------------------------------------------------------------------
// Parsing: CSV text (papaparse) + uploaded buffer (CSV or XLSX via exceljs)
// ---------------------------------------------------------------------------

/** Parse CSV text into { headers, rows } (rows keyed by header string). */
function parseCsvText(text: string): { headers: string[]; rows: any[] } {
  const parsed = Papa.parse(String(text == null ? '' : text), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: any) => String(h == null ? '' : h).replace(/^\uFEFF/, '').trim(),
  });
  const headers = (parsed.meta && parsed.meta.fields ? parsed.meta.fields : []).filter((h: any) => h !== '');
  const rows    = parsed.data || [];
  return { headers, rows };
}

/** exceljs cell -> string (hyperlink text, rich-text runs, formula results, ISO dates). */
function _cellToString(v: any): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText))  return v.richText.map((r: any) => r.text || '').join('');
    if ('result' in v)              return _cellToString(v.result);
    if ('formula' in v && 'value' in v) return _cellToString(v.value);
    return String(v);
  }
  return String(v);
}

/**
 * Parse an uploaded buffer by filename extension. CSV -> papaparse; .xlsx/.xls
 * -> exceljs (lazy-required so CSV-only callers and unit tests never load it).
 * exceljs, not SheetJS -- CVE-2023-30533/CVE-2024-22363 posture inherited from
 * routes/assetsImport.ts; exceljs is already a server dependency.
 */
async function parseUploadBuffer(buffer: Buffer, originalname: string): Promise<{ headers: string[]; rows: any[] }> {
  const isXlsx = /\.(xlsx|xls)$/i.test(originalname || '');
  if (!isXlsx) return parseCsvText(buffer.toString('utf8'));

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  let headers: string[] = [];
  const rows: any[] = [];
  ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
    const values = row.values || []; // 1-indexed; index 0 always null
    if (rowNumber === 1) {
      headers = values.slice(1).map((h: any) => _cellToString(h).trim());
      return;
    }
    const cells = values.slice(1);
    if (cells.every((c: any) => c == null || c === '' || _cellToString(c) === '')) return;
    const obj: any = {};
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j];
      if (!h) continue;
      obj[h] = _cellToString(cells[j]);
    }
    rows.push(obj);
  });
  return { headers: headers.filter((h) => h !== ''), rows };
}

/** Up to n distinct non-empty sample values per column (each capped at 80 chars). */
function sampleColumns(headers: string[], rows: any[], n: number = SAMPLES_PER_COLUMN): any[] {
  return (headers || []).map((header) => {
    const samples: string[] = [];
    const seen = new Set();
    for (const r of rows || []) {
      const raw = r ? r[header] : null;
      const s = String(raw == null ? '' : raw).trim().slice(0, 80);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      samples.push(s);
      if (samples.length >= n) break;
    }
    return { header, samples };
  });
}

// ---------------------------------------------------------------------------
// Deterministic header -> field guessing
// ---------------------------------------------------------------------------
// SYNONYMS keys are normToken()-folded aliases. Exact key/label matches are
// computed from TARGET_FIELDS, so "Serial Number" and "serialNumber" are both
// tier-'exact' without being listed here.
const SYNONYMS: any = {
  // siteName
  site: 'siteName', sitename: 'siteName', facility: 'siteName', facilityname: 'siteName',
  location: 'siteName', plant: 'siteName', campus: 'siteName', property: 'siteName',
  // equipmentType
  equipmenttype: 'equipmentType', equipment: 'equipmentType', type: 'equipmentType',
  assettype: 'equipmentType', category: 'equipmentType', assetclass: 'equipmentType',
  equipmentclass: 'equipmentType', devicetype: 'equipmentType',
  // hierarchy
  building: 'buildingName', buildingname: 'buildingName',
  area: 'areaName', areaname: 'areaName', room: 'areaName', floor: 'areaName',
  position: 'positionName', positionname: 'positionName', cubicle: 'positionName',
  designation: 'positionName', bay: 'positionName', unitid: 'positionName', tag: 'positionName',
  assettag: 'positionName', equipmentid: 'positionName',
  // manufacturer
  manufacturer: 'manufacturer', make: 'manufacturer', mfr: 'manufacturer', mfg: 'manufacturer',
  brand: 'manufacturer', oem: 'manufacturer', vendor: 'manufacturer',
  // model
  model: 'model', modelnumber: 'model', modelno: 'model', modelnum: 'model',
  catalognumber: 'model', catno: 'model', style: 'model',
  // serialNumber
  serial: 'serialNumber', serialnumber: 'serialNumber', serialno: 'serialNumber',
  serialnum: 'serialNumber', sn: 'serialNumber', sernum: 'serialNumber', serno: 'serialNumber',
  // installDate
  installdate: 'installDate', installed: 'installDate', installationdate: 'installDate',
  dateinstalled: 'installDate', inservicedate: 'installDate', commissioned: 'installDate',
  commissiondate: 'installDate', installyear: 'installDate', yearinstalled: 'installDate',
  year: 'installDate', vintage: 'installDate', mfgdate: 'installDate', mfgyear: 'installDate',
  // condition axes
  physical: 'conditionPhysical', physicalcondition: 'conditionPhysical',
  conditionphysical: 'conditionPhysical', condition: 'conditionPhysical',
  criticality: 'conditionCriticality', conditioncriticality: 'conditionCriticality',
  environment: 'conditionEnvironment', environmental: 'conditionEnvironment',
  conditionenvironment: 'conditionEnvironment', environmentcondition: 'conditionEnvironment',
  // inService
  inservice: 'inService', servicestatus: 'inService', status: 'inService',
  operational: 'inService', energized: 'inService',
  // risk dimensions (bare 'criticality' keeps the NFPA 70B C-axis mapping above)
  criticalityscore: 'criticalityScore', criticality15: 'criticalityScore',
  critscore: 'criticalityScore', riskscore: 'criticalityScore',
  infrastructurecriticality: 'criticalityScore',
  conditionscore: 'conditionScore', condition15: 'conditionScore',
  condscore: 'conditionScore', degradationscore: 'conditionScore',
  repaircost: 'repairCostEstimate', repaircostestimate: 'repairCostEstimate',
  estimatedrepaircost: 'repairCostEstimate', costtorepair: 'repairCostEstimate',
  replacementcost: 'repairCostEstimate',
  leadtime: 'spareLeadTimeWeeks', leadtimeweeks: 'spareLeadTimeWeeks',
  spareleadtime: 'spareLeadTimeWeeks', sparesleadtime: 'spareLeadTimeWeeks',
  sparepartsleadtime: 'spareLeadTimeWeeks',
  redundancy: 'redundancyStatus', redundancystatus: 'redundancyStatus',
  predictive: 'requiresPredictiveMaintenance', predictivemaintenance: 'requiresPredictiveMaintenance',
  requirespredictivemaintenance: 'requiresPredictiveMaintenance', pdm: 'requiresPredictiveMaintenance',
  conditionmonitoring: 'requiresPredictiveMaintenance',
  // nameplate passthrough
  voltage: 'voltage', voltagerating: 'voltage', ratedvoltage: 'voltage', kv: 'voltage',
  voltageclass: 'voltage', primaryvoltage: 'voltage', nominalvoltage: 'voltage',
  kva: 'kva', kvarating: 'kva', ratedkva: 'kva', size: 'kva', capacity: 'kva',
  // notes
  notes: 'notes', comments: 'notes', comment: 'notes', description: 'notes',
  remarks: 'notes', desc: 'notes',
};

// Exact tier: field key itself + display label, normToken-folded.
const EXACT_LOOKUP: Map<string, string> = (() => {
  const m = new Map();
  for (const f of TARGET_FIELDS) {
    m.set(normToken(f.key), f.key);
    m.set(normToken(f.label), f.key);
  }
  return m;
})();

/**
 * Deterministic guess for every header. Returns
 *   { [header]: { field: string|null, confidence: number, source: 'exact'|'synonym'|null } }
 *
 * Content boost: a 'type'-flavored column whose sample values mostly resolve
 * via matchEquipmentType is upgraded to 0.9 -- and a header with NO name hit
 * whose samples ALL resolve is proposed as equipmentType at 0.6 (still shown
 * for review, never silently trusted). customFieldDefs (optional) adds
 * synonym-tier matches on the definition name -> cf:<id>.
 */
function guessMapping(headers: string[], rows: any[] = [], customFieldDefs: any[] = []): any {
  const cfByToken = new Map();
  for (const d of customFieldDefs || []) {
    if (d && d.id && !d.archivedAt) cfByToken.set(normToken(d.name), `cf:${d.id}`);
  }

  const out: any = {};
  for (const header of headers || []) {
    const tok = normToken(header);
    if (!tok) { out[header] = { field: null, confidence: 0, source: null }; continue; }

    const exact = EXACT_LOOKUP.get(tok);
    if (exact) { out[header] = { field: exact, confidence: 1, source: 'exact' }; continue; }

    const syn = SYNONYMS[tok];
    if (syn) {
      let confidence = 0.85;
      if (syn === 'equipmentType') {
        // Verify against content: "Type" could be anything; matching samples
        // raise confidence, zero matches lower it (still proposed for review).
        const rate = _equipmentSampleMatchRate(header, rows);
        confidence = rate >= 0.5 ? 0.9 : rate === 0 ? 0.5 : 0.7;
      }
      out[header] = { field: syn, confidence, source: 'synonym' };
      continue;
    }

    const cf = cfByToken.get(tok);
    if (cf) { out[header] = { field: cf, confidence: 0.8, source: 'synonym' }; continue; }

    // Content sniff: unnamed-but-obviously-equipment column.
    const rate = _equipmentSampleMatchRate(header, rows);
    if (rate === 1 && rows && rows.length > 0) {
      out[header] = { field: 'equipmentType', confidence: 0.6, source: 'synonym' };
      continue;
    }

    out[header] = { field: null, confidence: 0, source: null };
  }
  return out;
}

/** Fraction of (up to 5) non-empty sample values that resolve to an enum type. */
function _equipmentSampleMatchRate(header: string, rows: any[]): number {
  const vals: string[] = [];
  for (const r of rows || []) {
    const s = String(r && r[header] != null ? r[header] : '').trim();
    if (s) vals.push(s);
    if (vals.length >= 5) break;
  }
  if (vals.length === 0) return 0;
  const hits = vals.filter((v) => matchEquipmentType(v) !== null).length;
  return hits / vals.length;
}

/**
 * One column per target field: when two headers claim the same field, the
 * higher-confidence one keeps it and the loser drops to unmapped (custom
 * fields included). Ties keep the first (leftmost) column.
 */
function dedupeMapping(proposals: any): any {
  const bestByField = new Map();
  for (const [header, p] of Object.entries<any>(proposals || {})) {
    if (!p || !p.field) continue;
    const cur = bestByField.get(p.field);
    if (!cur || p.confidence > cur.confidence) bestByField.set(p.field, { header, confidence: p.confidence });
  }
  const out: any = {};
  for (const [header, p] of Object.entries<any>(proposals || {})) {
    if (p && p.field && bestByField.get(p.field)?.header !== header) {
      out[header] = { field: null, confidence: 0, source: null };
    } else {
      out[header] = { ...p };
    }
  }
  return out;
}

/** Target fields (from a plain {header: field} map) that appear more than once. */
function findDuplicateTargets(fieldByHeader: any): string[] {
  const counts = new Map();
  for (const f of Object.values<any>(fieldByHeader || {})) {
    if (!f) continue;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([f]) => f);
}

// ---------------------------------------------------------------------------
// AI-assisted mapping (fail-soft; never blocks the import)
// ---------------------------------------------------------------------------

function buildAiMappingPrompt(columns: any[], targetFields: any[]): { system: string; user: string } {
  const system = [
    'You map spreadsheet column headers to a FIXED list of target fields for an',
    'electrical-equipment maintenance system (transformers, switchgear, breakers, ...).',
    'Reply with ONLY a JSON object -- no prose, no markdown fences.',
  ].join(' ');

  const fieldLines = targetFields.map((f) => {
    const opts = Array.isArray(f.options) && f.options.length ? ` (options: ${f.options.slice(0, 30).join(', ')})` : '';
    return `- ${f.key} :: ${f.label} [${f.type}]${opts}`;
  });
  const colLines = columns.map((c) => `- ${JSON.stringify(c.header)} samples: ${JSON.stringify(c.samples || [])}`);

  const user = [
    'TARGET FIELDS (the only valid keys):',
    ...fieldLines,
    '',
    'UNRESOLVED SPREADSHEET COLUMNS:',
    ...colLines,
    '',
    'For each column header above, pick the single best target field key, or null',
    'when nothing fits. Judge by BOTH the header text and the sample values.',
    'Return JSON exactly like:',
    '{"mapping": {"<header>": {"field": "<target key or null>", "confidence": 0.0}}}',
    'confidence is 0-1 (your certainty). Never invent keys. Never map two columns',
    'to the same field. When unsure, use null.',
  ].join('\n');

  return { system, user };
}

/**
 * Parse + sanitize the model's response. Unknown headers, unknown field keys,
 * and out-of-range confidences are dropped/clamped; anything below
 * AI_MIN_CONFIDENCE is discarded. Returns {} on any structural problem.
 */
function parseAiMappingResponse(text: string, headers: string[], validKeys: Set<string>): any {
  let parsed: any;
  try {
    const ai = require('./ai');
    parsed = ai.parseJSON(String(text || ''), 'importMapping');
  } catch (_e) {
    return {};
  }
  const mapping = parsed && typeof parsed === 'object' ? (parsed.mapping || parsed) : null;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};

  const headerSet = new Set(headers || []);
  const out: any = {};
  for (const [header, v] of Object.entries<any>(mapping)) {
    if (!headerSet.has(header)) continue;
    if (!v || typeof v !== 'object') continue;
    const field = v.field;
    if (typeof field !== 'string' || !validKeys.has(field)) continue;
    let confidence = Number(v.confidence);
    if (!Number.isFinite(confidence)) confidence = AI_MIN_CONFIDENCE;
    confidence = Math.max(0, Math.min(1, confidence));
    if (confidence < AI_MIN_CONFIDENCE) continue;
    out[header] = { field, confidence, source: 'ai' };
  }
  return out;
}

/**
 * Ask the AI cascade to map unresolved columns. FAIL-SOFT BY CONTRACT:
 * AI_ENABLED=false, an empty column list, a provider error, a timeout, or
 * malformed JSON all return {} and the import proceeds deterministic-only.
 *
 * @param columns      [{ header, samples }] -- unresolved columns only
 * @param targetFields full target descriptor list (core + cf:*)
 * @returns { [header]: { field, confidence, source: 'ai' } }
 */
async function aiAssistMapping(columns: any[], targetFields: any[]): Promise<any> {
  try {
    if (String(process.env.AI_ENABLED || '').toLowerCase() === 'false') return {};
    if (!Array.isArray(columns) || columns.length === 0) return {};

    const capped = columns.slice(0, AI_MAX_COLUMNS);
    const { system, user } = buildAiMappingPrompt(capped, targetFields);
    const ai = require('./ai'); // lazy -- pure callers/tests never load providers
    const resp = await ai.complete({ system, user, maxTokens: 1500, task: 'classify' });
    const validKeys = new Set(targetFields.map((f: any) => f.key));
    return parseAiMappingResponse(resp && resp.text ? resp.text : '', capped.map((c) => c.header), validKeys);
  } catch (e: any) {
    console.warn('[importMapping] AI mapping unavailable (deterministic-only):',
      e && e.message ? e.message.slice(0, 200) : String(e));
    return {};
  }
}

// ---------------------------------------------------------------------------
// Row coercion + validation (pure -- writes nothing)
// ---------------------------------------------------------------------------

function _parseDateCell(s: string): Date | Error {
  let d: any = null;
  if (/^\d{4}$/.test(s)) {
    const y = parseInt(s, 10);                           // bare year ("2018")
    if (y < 1900 || y > 2100) return new Error(`Invalid year: "${s}"`);
    d = new Date(`${s}-01-01T00:00:00Z`);
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    d = new Date(s);                                     // ISO / exceljs dates
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split('/');                   // m/d/yyyy (US)
    d = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`);
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split('-');                   // m-d-yyyy
    d = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`);
  } else {
    d = new Date(s);                                     // "Jan 5, 2026" etc.
  }
  if (Number.isNaN(d?.getTime?.())) return new Error(`Invalid date: "${s}"`);
  const year = d.getUTCFullYear();
  if (year < 1900 || year > 2100) return new Error(`Date out of range: "${s}"`);
  return d;
}

function _parseConditionCell(s: string): string | Error {
  const v = String(s).trim().toUpperCase();
  if (['C1', 'C2', 'C3'].includes(v)) return v;
  if (v === '1' || v === 'GOOD') return 'C1';
  if (v === '2' || v === 'FAIR' || v === 'AVERAGE') return 'C2';
  if (v === '3' || v === 'POOR' || v === 'BAD') return 'C3';
  return new Error(`Invalid condition rating: "${s}" (expected C1, C2, or C3)`);
}

/**
 * Coerce one raw cell into the JS shape the Asset model expects. Returns the
 * coerced value, an Error with a human-readable message, or null for blank
 * ("leave field unset / use default"). cf:* fields pass through as trimmed
 * strings -- the route validates them against the stored definition.
 */
function coerceField(field: string, raw: any): any {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;

  if (field.startsWith('cf:')) {
    if (s.length > 2000) return new Error('Value exceeds 2000 characters');
    return s;
  }

  switch (field) {
    case 'installDate':
      return _parseDateCell(s);
    case 'conditionPhysical':
    case 'conditionCriticality':
    case 'conditionEnvironment':
      return _parseConditionCell(s);
    case 'inService': {
      const v = s.toLowerCase();
      if (['yes', 'true', 'y', '1', 'in service', 'in-service', 'active', 'energized'].includes(v)) return true;
      if (['no', 'false', 'n', '0', 'out of service', 'out', 'inactive', 'decommissioned'].includes(v)) return false;
      return new Error(`Invalid in-service value: "${s}" (expected Yes/No)`);
    }
    case 'equipmentType': {
      const match = matchEquipmentType(s);
      if (!match) return new Error(`Unknown equipment type: "${s}"`);
      return match;
    }
    case 'criticalityScore':
    case 'conditionScore': {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return new Error(`Invalid ${field === 'criticalityScore' ? 'criticality' : 'condition'} score: "${s}" (expected an integer 1-5)`);
      }
      return n;
    }
    case 'repairCostEstimate': {
      let t = s.replace(/[$,\s]/g, '').toLowerCase();
      let mult = 1;
      if (/k$/.test(t)) { mult = 1e3; t = t.slice(0, -1); }
      else if (/m$/.test(t)) { mult = 1e6; t = t.slice(0, -1); }
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) {
        return new Error(`Invalid repair cost: "${s}" (expected a non-negative amount)`);
      }
      return String(n * mult); // Prisma Decimal accepts the numeric string
    }
    case 'spareLeadTimeWeeks': {
      const t = s.toLowerCase().replace(/\s*(weeks?|wks?)\.?$/, '').trim();
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0) {
        return new Error(`Invalid spare lead time: "${s}" (expected a non-negative whole number of weeks)`);
      }
      return n;
    }
    case 'redundancyStatus': {
      const v = s.toUpperCase().replace(/\s+/g, '');
      if (['N', 'NONE'].includes(v))                  return 'N';
      if (['N+1', 'N_PLUS_1', 'NPLUS1'].includes(v))  return 'N_PLUS_1';
      if (['2N', 'TWO_N', 'TWON', 'N+N'].includes(v)) return 'TWO_N';
      return new Error(`Invalid redundancy status: "${s}" (expected N, N+1, or 2N)`);
    }
    case 'requiresPredictiveMaintenance': {
      const v = s.toLowerCase();
      if (['yes', 'true', 'y', '1', 'required', 'x'].includes(v))    return true;
      if (['no', 'false', 'n', '0', 'not required'].includes(v))     return false;
      return new Error(`Invalid predictive-maintenance value: "${s}" (expected Yes/No)`);
    }
    case 'notes': {
      if (s.length > 2000) return new Error('Notes exceeds 2000 characters');
      return s;
    }
    case 'voltage':
    case 'kva': {
      if (s.length > 60) return new Error('Value exceeds 60 characters');
      return s;
    }
    default: {
      if (s.length > 500) return new Error('Value exceeds 500 characters');
      return s;
    }
  }
}

/** Governing condition = worst of the three axes (C3 wins), as routes/assets.ts. */
function worstCondition(a: any, b: any, c: any): string {
  return ['C3', 'C2', 'C1'].find((v) => [a, b, c].includes(v)) || 'C2';
}

/**
 * Validate + normalize every row against a plain { header: fieldKey } map.
 * Pure -- writes nothing. Returns one result per input row:
 *   { row, ok, errors: [{ field, error }], normalized }
 * where `row` is the spreadsheet row number (1-indexed + header = i+2) and
 * `normalized` carries coerced core fields, `nameplate` (voltage/kva), and
 * `customFields` ({ definitionId: canonicalValue }).
 *
 * opts.customFieldById   Map<definitionId, definition> for cf:* targets
 * opts.validateCustomValue(definition, raw) -> canonical string | throws
 *   (inject routes/customFields.validateValueForDefinition; a cf:* column
 *    without a validator or a known definition errors the cell, not the app)
 */
function validateRows(rows: any[], fieldByHeader: any, opts: any = {}): any[] {
  const customFieldById   = opts.customFieldById || new Map();
  const validateCustom    = opts.validateCustomValue || null;
  const results: any[] = [];

  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i] || {};
    const rowNum = i + 2;
    const errors: any[] = [];
    const normalized: any = { nameplate: {}, customFields: {} };

    for (const [header, fieldKey] of Object.entries<any>(fieldByHeader || {})) {
      if (!fieldKey) continue;
      const coerced = coerceField(fieldKey, r[header]);
      if (coerced instanceof Error) {
        errors.push({ field: fieldKey, error: coerced.message });
        continue;
      }
      if (coerced === null) continue;

      if (fieldKey.startsWith('cf:')) {
        const defId = fieldKey.slice(3);
        const def = customFieldById.get(defId);
        if (!def || !validateCustom) {
          errors.push({ field: fieldKey, error: 'Unknown custom field' });
          continue;
        }
        try {
          const canonical = validateCustom(def, sanitizeFormulaPrefix(coerced));
          if (canonical !== null) normalized.customFields[defId] = canonical;
        } catch (e: any) {
          errors.push({ field: fieldKey, error: e && e.message ? e.message : 'Invalid value' });
        }
        continue;
      }

      if (fieldKey === 'voltage' || fieldKey === 'kva') {
        normalized.nameplate[fieldKey] = sanitizeFormulaPrefix(coerced);
        continue;
      }

      normalized[fieldKey] = typeof coerced === 'string' ? sanitizeFormulaPrefix(coerced) : coerced;
    }

    if (!normalized.siteName) {
      errors.push({ field: 'siteName', error: 'Site name is required' });
    }
    if (!normalized.equipmentType && !errors.some((e) => e.field === 'equipmentType')) {
      errors.push({ field: 'equipmentType', error: 'Equipment type is required' });
    }

    results.push({ row: rowNum, ok: errors.length === 0, errors, normalized });
  }
  return results;
}

module.exports = {
  // caps
  MAX_IMPORT_ROWS, MAX_IMPORT_BYTES, AI_MIN_CONFIDENCE, AI_MAX_COLUMNS, SAMPLES_PER_COLUMN,
  // vocabulary
  TARGET_FIELDS, CORE_TARGET_KEYS, customFieldTargets,
  // normalizers + matching
  normToken, normalizeSerial, sanitizeFormulaPrefix, matchEquipmentType, worstCondition,
  // parsing
  parseCsvText, parseUploadBuffer, sampleColumns,
  // mapping
  guessMapping, dedupeMapping, findDuplicateTargets,
  buildAiMappingPrompt, parseAiMappingResponse, aiAssistMapping,
  // validation
  coerceField, validateRows,
};

export {};
