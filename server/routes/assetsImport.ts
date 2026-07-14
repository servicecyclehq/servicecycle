'use strict';

/**
 * /api/assets/import — bulk asset import from CSV or Excel (.xlsx/.xls).
 *
 * "Day 1" integration: facility managers arrive with equipment spreadsheets.
 * Two endpoints (mounted in index.ts BEFORE /api/assets so the assets
 * router's /:id param routes never swallow these paths):
 *
 *   POST /preview — multipart `file=<csv|xlsx>` (+ optional `columnMap` JSON
 *              to re-validate a user-edited mapping). Parse + auto-detect a
 *              column mapping + per-row validate. NO writes. Returns headers,
 *              suggested mapping, sample rows, per-row validation errors,
 *              duplicate-serial rows, and unknown site names so the UI can
 *              render the mapping/review step.
 *
 *   POST /commit  — multipart `file` plus form fields:
 *                columnMap          JSON object  file header -> schema field (required)
 *                createMissingSites 'true'|'false' (default 'false') — auto-create
 *                                   unknown sites AND building/area/position
 *                                   names under their site
 *                autoApplySchedules 'true'|'false' (default 'false') — after
 *                                   creation, create MaintenanceSchedules from
 *                                   the GLOBAL task-definition matrix matching
 *                                   each new asset's equipmentType (mirrors
 *                                   POST /api/schedules/bulk-apply)
 *              Re-parses (no server-side cache), applies the mapping, and
 *              inserts within a single Prisma transaction. Rows with
 *              validation errors are reported individually and never reach
 *              the DB; rows whose (accountId, serialNumber) already exists
 *              (or repeats within the file) are skipped and reported.
 *
 * Supported columns: siteName (required), equipmentType (required — accepts
 * enum values OR display labels like "Transformer (Liquid)", fuzzy/trimmed
 * case-insensitive), buildingName/areaName/positionName, manufacturer, model,
 * serialNumber, installDate (several formats), conditionPhysical/
 * Criticality/Environment (C1/C2/C3, default C2), inService (yes/no/true/
 * false), notes, plus the risk dimensions: criticalityScore (1-5),
 * repairCostEstimate ($/commas/k-m suffixes accepted), spareLeadTimeWeeks,
 * redundancyStatus (N / N+1 / 2N), requiresPredictiveMaintenance (yes/no).
 * governingCondition is computed as the worst axis, same rule as
 * routes/assets.ts.
 *
 * Caps: 500 data rows / 5MB file per request. Manager+ only. Every query
 * scoped accountId = req.user.accountId. Activity log: ONE `assets_imported`
 * row per call with counts — no per-row rows (would dilute asset timelines).
 *
 * Hardening inherited from the retired contracts importer: multer memory
 * storage + size cap + extension filter, exceljs for .xlsx (a PATCHED SheetJS
 * >= 0.20.2 handles the legacy .xls path only, where CVE-2023-30533 and
 * CVE-2024-22363 are both already fixed — see lib/xlsParse.ts), formula-
 * injection sanitization on every free-text column on the way IN, per-row error
 * collection with 1-indexed+header row numbers.
 */

const router = require('express').Router();
const multer = require('multer');
const Papa = require('papaparse');
// exceljs reads .xlsx (already a dependency, export path); the legacy .xls
// branch uses SheetJS lazily via lib/xlsParse — see header.
const ExcelJS = require('exceljs');

const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const prisma = require('../lib/prisma').default;
const { fireImportWebhook } = require('../lib/webhookImport');

const MAX_IMPORT_ROWS  = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_IMPORT_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname || '';
    const isCsv  = /\.csv$/i.test(name);
    const isXlsx = /\.(xlsx|xls)$/i.test(name);
    if (!isCsv && !isXlsx) return cb(new Error('Only .csv or .xlsx files are accepted'));
    return cb(null, true);
  },
});

// ─── File parsing (CSV via papaparse, XLSX via exceljs) ──────────────────────

/**
 * Cell-value normalizer for exceljs — every cell becomes a string.
 * Hyperlinks return their text label; rich-text cells return concatenated
 * runs; formula cells return the cached result; dates render in ISO;
 * everything else gets String(). Empty/null → ''.
 */
function _cellToString(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;            // hyperlink
    if (Array.isArray(v.richText))  return v.richText.map(r => r.text || '').join('');
    if ('result' in v)              return _cellToString(v.result);
    if ('formula' in v && 'value' in v) return _cellToString(v.value);
    return String(v);
  }
  return String(v);
}

/**
 * Parse a multer-uploaded buffer into { headers: string[], rows: object[] }
 * where each row is a plain object keyed by header string (papaparse shape).
 */
async function parseUploadedFile(buffer, originalname) {
  const isXls  = /\.xls$/i.test(originalname || '');
  const isXlsx = /\.xlsx$/i.test(originalname || '');

  // Legacy .xls (BIFF8/OLE2) — ExcelJS reads only OOXML .xlsx and silently
  // fails on a real .xls. SheetJS (patched >= 0.20.2) reads it; see lib/xlsParse.
  if (isXls) {
    const { parseXlsBuffer } = require('../lib/xlsParse');
    return parseXlsBuffer(buffer);
  }

  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };

    let headers = [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values || []; // 1-indexed; index 0 always null
      if (rowNumber === 1) {
        headers = values.slice(1).map(h => _cellToString(h).trim());
        return;
      }
      const cells = values.slice(1);
      if (cells.every(c => c == null || c === '' || _cellToString(c) === '')) return;
      const obj: any = {};
      for (let j = 0; j < headers.length; j++) {
        const h = headers[j];
        if (!h) continue;
        obj[h] = _cellToString(cells[j]);
      }
      rows.push(obj);
    });
    return { headers, rows };
  }

  const text   = buffer.toString('utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, trimHeaders: true });
  const headers = parsed.meta.fields || [];
  const rows    = parsed.data || [];
  return { headers, rows };
}

// ─── Equipment-type vocabulary ────────────────────────────────────────────────
// Canonical enum values + display labels come from lib/equipmentTypes (the
// single source of truth mirroring the Prisma enum); this section owns only
// the IMPORT-side fuzzy matching on top of them.

const { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABELS } = require('../lib/equipmentTypes');

// Fuzzy-match key: lowercase, strip everything non-alphanumeric so
// "Transformer (Liquid)", "transformer liquid", and "TRANSFORMER_LIQUID"
// all collapse to "transformerliquid".
function normToken(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const EQUIPMENT_TYPE_LOOKUP = (() => {
  const m = new Map();
  for (const [val, label] of Object.entries<any>(EQUIPMENT_TYPE_LABELS)) {
    m.set(normToken(val), val);
    m.set(normToken(label), val);
  }
  // Conservative real-world aliases seen on facility spreadsheets. Exact
  // (normalized) matches only — fuzzier contains-style rules live in
  // matchEquipmentType below so their precedence is explicit.
  const aliases: any = {
    TRANSFORMER_LIQUID:      ['liquid transformer', 'liquid-filled transformer', 'oil transformer', 'oil-filled transformer', 'wet transformer'],
    TRANSFORMER_DRY:         ['dry transformer', 'dry-type transformer', 'cast coil transformer'],
    SWITCHGEAR:              ['swgr', 'switch gear'],
    SWITCHBOARD:             ['swbd', 'switch board', 'main switchboard', 'distribution switchboard'],
    PANELBOARD:              ['panel', 'panel board', 'pnl', 'distribution panel', 'lighting panel', 'branch panel'],
    BUSWAY:                  ['busway', 'bus duct', 'busduct', 'bus way', 'bus bar duct'],
    GENERATOR:               ['genset', 'gen set', 'emergency generator', 'standby generator'],
    MCC:                     ['motor control center', 'motor control centre'],
    UPS_BATTERY:             ['ups', 'ups system', 'ups battery', 'uninterruptible power supply'],
    BATTERY_SYSTEM:          ['battery', 'battery string', 'battery bank', 'station battery', 'stationary battery', 'battery charger', 'dc system'],
    CIRCUIT_BREAKER:         ['breaker', 'circuit brkr'],
    FUSE_GEAR:               ['fuse', 'fuses', 'fusible switch', 'fuse cabinet', 'fused switch'],
    DISCONNECT_SWITCH:       ['disconnect', 'load break switch', 'load-break switch', 'safety switch', 'air switch', 'isolation switch'],
    TRANSFER_SWITCH:         ['ats', 'transfer switch', 'automatic transfer switch', 'auto transfer switch', 'manual transfer switch'],
    PROTECTION_RELAY:        ['relay', 'protective relay', 'protection relays', 'sel relay'],
    GROUND_FAULT_PROTECTION: ['ground fault', 'ground fault protection', 'gfp', 'gf protection', 'ground fault relay'],
    SURGE_ARRESTER:          ['surge arrestor', 'lightning arrester', 'lightning arrestor', 'tvss', 'spd', 'surge protective device'],
    CABLE_LV:                ['lv cable', 'low voltage cable', 'lv feeder', '600v cable', 'cable lv'],
    CABLE_MV_HV:             ['mv cable', 'hv cable', 'medium voltage cable', 'high voltage cable', 'mv feeder', 'cable mv', 'cable hv'],
    CABLE_TRAY:              ['tray', 'cable trays', 'cable ladder'],
    GROUNDING_SYSTEM:        ['ground', 'grounding', 'ground grid', 'grounding grid', 'ground system', 'earthing system', 'ground electrode'],
    EMERGENCY_LIGHTING:      ['emergency light', 'emergency lights', 'egress', 'egress lighting', 'exit light', 'exit lighting', 'exit sign', 'em lighting'],
    ARC_FLASH_PANEL:         ['arc flash'],
    VFD:                     ['variable frequency drive', 'adjustable speed drive', 'vsd'],
    FIRE_PUMP_CONTROLLER:    ['fire pump', 'fire pump ctrl'],
  };
  for (const [val, list] of Object.entries<any>(aliases)) {
    for (const a of list) {
      const k = normToken(a);
      if (!m.has(k)) m.set(k, val);
    }
  }
  return m;
})();

// Heuristic fallback when the exact (normalized) lookup misses — handles
// compound cell values like "Battery string — switchgear control" or
// "15 kV MV feeder cable run 4". Rule ORDER is load-bearing:
//   - 'arc flash' wins before the bare 'panel' rule
//   - 'ground fault' wins before the bare 'ground' rule (GROUNDING_SYSTEM)
//   - 'cable tray' wins before the cable LV-vs-MV/HV voltage split
//   - 'transfer'/'disconnect' win before the bare switchboard/switchgear words
//   - 'ups' wins over 'battery' (a UPS battery string is the UPS asset)
function matchEquipmentType(rawCell) {
  const exact = EQUIPMENT_TYPE_LOOKUP.get(normToken(rawCell));
  if (exact) return exact;

  const s = String(rawCell || '').toLowerCase();
  const has = (...words) => words.some(w => s.includes(w));

  if (has('arc flash'))                          return 'ARC_FLASH_PANEL';
  if (has('fire pump'))                          return 'FIRE_PUMP_CONTROLLER';
  if (/\bground\s*fault\b/.test(s) || /\bgfp\b/.test(s)) return 'GROUND_FAULT_PROTECTION';
  // Word-boundary so "underground feeder cable" falls through to the cable rule.
  if (/\bground(ing)?\b/.test(s) || has('earthing'))     return 'GROUNDING_SYSTEM';
  if (has('emergency light', 'egress', 'exit light', 'exit sign')) return 'EMERGENCY_LIGHTING';
  if (has('transfer switch') || /\bats\b/.test(s)) return 'TRANSFER_SWITCH';
  if (has('busway', 'bus duct', 'busduct'))      return 'BUSWAY';
  if (has('cable tray'))                         return 'CABLE_TRAY';
  if (has('cable', 'feeder')) {
    // Voltage hints decide LV vs MV/HV: explicit class words, or a kV figure
    // (>0.6 kV ⇒ MV/HV), or a volt figure (>600 V ⇒ MV/HV). Default LV — the
    // overwhelmingly common case on facility sheets.
    if (has('mv', 'hv', 'medium voltage', 'high voltage')) return 'CABLE_MV_HV';
    const kv = s.match(/(\d+(?:\.\d+)?)\s*kv\b/);
    if (kv && parseFloat(kv[1]) > 0.6) return 'CABLE_MV_HV';
    const v = s.match(/(\d+)\s*v(?:olts?)?\b/);
    if (v && parseInt(v[1], 10) > 600) return 'CABLE_MV_HV';
    return 'CABLE_LV';
  }
  if (has('relay'))                              return 'PROTECTION_RELAY';
  if (has('disconnect', 'load break', 'load-break', 'safety switch')) return 'DISCONNECT_SWITCH';
  if (has('switchboard', 'switch board'))        return 'SWITCHBOARD';
  if (has('switchgear', 'switch gear'))          return 'SWITCHGEAR';
  if (has('panelboard', 'panel'))                return 'PANELBOARD';
  if (has('ups', 'uninterruptible'))             return 'UPS_BATTERY';
  if (has('battery'))                            return 'BATTERY_SYSTEM';
  if (has('surge', 'lightning arrest'))          return 'SURGE_ARRESTER';
  if (has('fuse'))                               return 'FUSE_GEAR';

  return null;
}

// ─── Column mapping: header aliases -> internal field keys ──────────────────

const HEADER_TO_FIELD: any = {
  'site':                  'siteName',
  'site name':             'siteName',
  'facility':              'siteName',
  'facility name':         'siteName',
  'location':              'siteName',
  'plant':                 'siteName',
  'equipment type':        'equipmentType',
  'equipment':             'equipmentType',
  'type':                  'equipmentType',
  'asset type':            'equipmentType',
  'category':              'equipmentType',
  'building':              'buildingName',
  'building name':         'buildingName',
  'area':                  'areaName',
  'area name':             'areaName',
  'room':                  'areaName',
  'position':              'positionName',
  'position name':         'positionName',
  'cubicle':               'positionName',
  'designation':           'positionName',
  'manufacturer':          'manufacturer',
  'make':                  'manufacturer',
  'mfr':                   'manufacturer',
  'mfg':                   'manufacturer',
  'brand':                 'manufacturer',
  'model':                 'model',
  'model number':          'model',
  'model #':               'model',
  'model no':              'model',
  'serial':                'serialNumber',
  'serial number':         'serialNumber',
  'serial #':              'serialNumber',
  'serial no':             'serialNumber',
  'sn':                    'serialNumber',
  's/n':                   'serialNumber',
  'install date':          'installDate',
  'installed':             'installDate',
  'installation date':     'installDate',
  'date installed':        'installDate',
  'in service date':       'installDate',
  'commissioned':          'installDate',
  'physical':              'conditionPhysical',
  'physical condition':    'conditionPhysical',
  'condition physical':    'conditionPhysical',
  'condition':             'conditionPhysical',
  'criticality':           'conditionCriticality',
  'condition criticality': 'conditionCriticality',
  'environment':           'conditionEnvironment',
  'environmental':         'conditionEnvironment',
  'condition environment': 'conditionEnvironment',
  'environment condition': 'conditionEnvironment',
  'in service':            'inService',
  'in-service':            'inService',
  'service status':        'inService',
  'status':                'inService',
  // Risk dimensions. NOTE: the bare 'criticality' header keeps its historical
  // mapping to the NFPA 70B conditionCriticality C-axis above — the 1-5
  // infrastructure score needs an explicit "score"-flavored header.
  'criticality score':     'criticalityScore',
  'criticality (1-5)':     'criticalityScore',
  'crit score':            'criticalityScore',
  'risk score':            'criticalityScore',
  'infrastructure criticality': 'criticalityScore',
  // Condition (degradation) score 1-5 — pairs with criticalityScore to form the
  // stored DPS (priorityScore = conditionScore × criticalityScore) on import.
  'condition score':       'conditionScore',
  'condition (1-5)':       'conditionScore',
  'cond score':            'conditionScore',
  'degradation score':     'conditionScore',
  'physical condition score': 'conditionScore',
  'repair cost':           'repairCostEstimate',
  'repair cost estimate':  'repairCostEstimate',
  'estimated repair cost': 'repairCostEstimate',
  'cost to repair':        'repairCostEstimate',
  'replacement cost':      'repairCostEstimate',
  'repair $':              'repairCostEstimate',
  'lead time':             'spareLeadTimeWeeks',
  'lead time (weeks)':     'spareLeadTimeWeeks',
  'lead time weeks':       'spareLeadTimeWeeks',
  'spare lead time':       'spareLeadTimeWeeks',
  'spares lead time':      'spareLeadTimeWeeks',
  'spare parts lead time': 'spareLeadTimeWeeks',
  'redundancy':            'redundancyStatus',
  'redundancy status':     'redundancyStatus',
  'predictive':            'requiresPredictiveMaintenance',
  'predictive maintenance': 'requiresPredictiveMaintenance',
  'requires predictive maintenance': 'requiresPredictiveMaintenance',
  'pdm':                   'requiresPredictiveMaintenance',
  'condition monitoring':  'requiresPredictiveMaintenance',
  'notes':                 'notes',
  'comments':              'notes',
  'comment':               'notes',
  'description':           'notes',
  'remarks':               'notes',
};

// Surfaced to the client for the mapping dropdown UI.
const SCHEMA_FIELDS = [
  { key: 'siteName',             label: 'Site (lookup by name)',  type: 'siteName', required: true },
  { key: 'equipmentType',        label: 'Equipment Type',         type: 'enum',     required: true, options: EQUIPMENT_TYPES },
  { key: 'buildingName',         label: 'Building',               type: 'string' },
  { key: 'areaName',             label: 'Area',                   type: 'string' },
  { key: 'positionName',         label: 'Position',               type: 'string' },
  { key: 'manufacturer',         label: 'Manufacturer',           type: 'string' },
  { key: 'model',                label: 'Model',                  type: 'string' },
  { key: 'serialNumber',         label: 'Serial Number',          type: 'string' },
  { key: 'installDate',          label: 'Install Date',           type: 'date' },
  { key: 'conditionPhysical',    label: 'Condition — Physical',   type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'conditionCriticality', label: 'Condition — Criticality', type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'conditionEnvironment', label: 'Condition — Environment', type: 'enum', options: ['C1', 'C2', 'C3'] },
  { key: 'inService',            label: 'In Service',             type: 'boolean' },
  { key: 'criticalityScore',     label: 'Criticality Score (1-5)', type: 'number' },
  { key: 'conditionScore',       label: 'Condition Score (1-5)',  type: 'number' },
  { key: 'repairCostEstimate',   label: 'Repair Cost Estimate',   type: 'number' },
  { key: 'spareLeadTimeWeeks',   label: 'Spare Lead Time (weeks)', type: 'number' },
  { key: 'redundancyStatus',     label: 'Redundancy Status',      type: 'enum', options: ['N', 'N_PLUS_1', 'TWO_N'] },
  { key: 'requiresPredictiveMaintenance', label: 'Predictive Maintenance Required', type: 'boolean' },
  { key: 'notes',                label: 'Notes',                  type: 'string' },
];
const VALID_FIELD_KEYS = new Set(SCHEMA_FIELDS.map(f => f.key));

function suggestMapping(headers) {
  const m: any = {};
  for (const h of headers) {
    const key = String(h || '').trim().toLowerCase();
    m[h] = (key && HEADER_TO_FIELD[key] !== undefined) ? HEADER_TO_FIELD[key] : null;
  }
  return m;
}

// ─── Coercion / validation helpers ───────────────────────────────────────────

// Governing condition = worst of the three axes (C3 wins) — same rule as
// routes/assets.ts.
const worstCondition = (a, b, c) =>
  ['C3', 'C2', 'C1'].find(v => [a, b, c].includes(v)) || 'C2';

// Defense-in-depth formula-injection guard for free-text columns (inherited
// from the contracts importer, audit Cluster A P2): sanitize on the way IN so
// the stored value is never dangerous regardless of which tool re-exports it.
function sanitizeFormulaPrefix(v) {
  if (v == null) return v;
  if (typeof v !== 'string') return v;
  if (/^\s*[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

function parseDateCell(s) {
  let d = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    d = new Date(s);                                   // ISO / exceljs dates
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split('/');                 // m/d/yyyy (US)
    d = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`);
  } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split('-');                 // m-d-yyyy
    d = new Date(`${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`);
  } else {
    d = new Date(s);                                   // "Jan 5, 2026" etc.
  }
  if (Number.isNaN(d?.getTime?.())) return new Error(`Invalid date: "${s}"`);
  return d;
}

function parseConditionCell(s) {
  const v = String(s).trim().toUpperCase();
  if (['C1', 'C2', 'C3'].includes(v)) return v;
  if (v === '1' || v === 'GOOD') return 'C1';
  if (v === '2' || v === 'FAIR') return 'C2';
  if (v === '3' || v === 'POOR') return 'C3';
  return new Error(`Invalid condition rating: "${s}" (expected C1, C2, or C3)`);
}

// Coerce a raw cell into the JS shape the Asset model expects. Returns the
// coerced value, or an Error with a human-readable message. null/empty
// returns null (= "leave field blank / use default").
function coerce(field, raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;

  switch (field) {
    case 'installDate':
      return parseDateCell(s);
    case 'conditionPhysical':
    case 'conditionCriticality':
    case 'conditionEnvironment':
      return parseConditionCell(s);
    case 'inService': {
      const v = s.toLowerCase();
      if (['yes', 'true', 'y', '1', 'in service', 'in-service', 'active'].includes(v))  return true;
      if (['no', 'false', 'n', '0', 'out of service', 'out', 'inactive'].includes(v))  return false;
      return new Error(`Invalid in-service value: "${s}" (expected Yes/No)`);
    }
    case 'equipmentType': {
      const match = matchEquipmentType(s);
      if (!match) return new Error(`Unknown equipment type: "${s}"`);
      return match;
    }
    case 'criticalityScore': {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return new Error(`Invalid criticality score: "${s}" (expected an integer 1-5)`);
      }
      return n;
    }
    case 'conditionScore': {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return new Error(`Invalid condition score: "${s}" (expected an integer 1-5)`);
      }
      return n;
    }
    case 'repairCostEstimate': {
      // Money cells arrive as "$850,000", "850000.00", "850k" — strip the
      // currency dressing, expand a trailing k/m multiplier, require >= 0.
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
      // Accept "12", "12 weeks", "12 wk".
      const t = s.toLowerCase().replace(/\s*(weeks?|wks?)\.?$/, '').trim();
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0) {
        return new Error(`Invalid spare lead time: "${s}" (expected a non-negative whole number of weeks)`);
      }
      return n;
    }
    case 'redundancyStatus': {
      const v = s.toUpperCase().replace(/\s+/g, '');
      if (['N', 'NONE'].includes(v))                              return 'N';
      if (['N+1', 'N_PLUS_1', 'NPLUS1'].includes(v))              return 'N_PLUS_1';
      if (['2N', 'TWO_N', 'TWON', 'N+N'].includes(v))             return 'TWO_N';
      return new Error(`Invalid redundancy status: "${s}" (expected N, N+1, or 2N)`);
    }
    case 'requiresPredictiveMaintenance': {
      const v = s.toLowerCase();
      if (['yes', 'true', 'y', '1', 'required', 'x'].includes(v)) return true;
      if (['no', 'false', 'n', '0', 'not required', ''].includes(v)) return false;
      return new Error(`Invalid predictive-maintenance value: "${s}" (expected Yes/No)`);
    }
    case 'notes': {
      if (s.length > 2000) return new Error(`Notes exceeds 2000 characters`);
      return s;
    }
    default: {
      // Free-text short strings (names, manufacturer, model, serial).
      if (s.length > 500) return new Error(`Value exceeds 500 characters`);
      return s;
    }
  }
}

const lc = (s) => String(s || '').trim().toLowerCase();

// ─── Shared preview/commit pipeline ──────────────────────────────────────────
// Parses the upload, resolves the mapping (client-supplied or suggested),
// normalizes + validates every row, and computes unknown sites + duplicate
// serials. Returns { error: { status, body } } or the full context object.
async function prepareImport(req): Promise<any> {
  if (!req.file || !req.file.buffer) {
    return { error: { status: 400, body: { success: false, error: 'No file uploaded' } } };
  }

  let parsed;
  try {
    parsed = await parseUploadedFile(req.file.buffer, req.file.originalname);
  } catch (parseErr) {
    return { error: { status: 400, body: { success: false, error: `File parse error: ${parseErr.message}` } } };
  }
  const { headers, rows } = parsed;

  if (headers.length === 0) {
    return { error: { status: 400, body: { success: false, error: 'File has no header row' } } };
  }
  if (rows.length === 0) {
    return { error: { status: 400, body: { success: false, error: 'File contained no data rows' } } };
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return { error: { status: 400, body: { success: false, error: `Import exceeds ${MAX_IMPORT_ROWS}-row cap (${rows.length} rows)` } } };
  }

  // Mapping — client-supplied columnMap (commit always; preview optionally,
  // so the UI can re-validate after the user edits the dropdowns) or suggested.
  let mapping;
  if (req.body && req.body.columnMap) {
    try { mapping = JSON.parse(req.body.columnMap); }
    catch { return { error: { status: 400, body: { success: false, error: 'columnMap must be valid JSON' } } }; }
    if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
      return { error: { status: 400, body: { success: false, error: 'columnMap must be a JSON object' } } };
    }
    // Drop unknown target keys defensively — a stale client can't write to
    // arbitrary asset columns.
    for (const [h, f] of Object.entries<any>(mapping)) {
      if (f != null && !VALID_FIELD_KEYS.has(f)) mapping[h] = null;
    }
  } else {
    mapping = suggestMapping(headers);
  }

  // Required columns must be mapped before any row work makes sense.
  const targetFields = Object.values<any>(mapping).filter(Boolean);
  const missingRequired = [];
  if (!targetFields.includes('siteName'))      missingRequired.push('Site');
  if (!targetFields.includes('equipmentType')) missingRequired.push('Equipment Type');
  if (missingRequired.length > 0) {
    return {
      error: {
        status: 400,
        body: {
          success: false,
          error:   `Missing required column(s): ${missingRequired.join(', ')}. Map an existing column to each.`,
          data:    { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS },
        },
      },
    };
  }

  // Per-row normalize + validate.
  const normalizedRows   = [];
  const validationErrors = [];
  const siteNamesByLc    = new Map(); // lc -> original casing (first seen)

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const data: any = {};
    const rowErrors = [];

    for (const [header, fieldKey] of Object.entries<any>(mapping)) {
      if (!fieldKey) continue;
      const coerced = coerce(fieldKey, r[header]);
      if (coerced instanceof Error) {
        rowErrors.push({ field: fieldKey, error: coerced.message });
        continue;
      }
      data[fieldKey] = coerced;
    }

    if (!data.siteName) {
      rowErrors.push({ field: 'siteName', error: 'Site name is required' });
    } else {
      const k = lc(data.siteName);
      if (!siteNamesByLc.has(k)) siteNamesByLc.set(k, data.siteName);
    }
    if (!data.equipmentType && !rowErrors.some(e => e.field === 'equipmentType')) {
      rowErrors.push({ field: 'equipmentType', error: 'Equipment type is required' });
    }

    normalizedRows.push(data);
    if (rowErrors.length > 0) {
      validationErrors.push({ row: i + 2, errors: rowErrors }); // +2 = 1-indexed + header row
    }
  }

  // Existing sites — case-insensitive match by trimmed name. Archived sites
  // still match (assets keep their siteId on archive; re-importing under an
  // archived site name should attach, not duplicate).
  //
  // COMP-8-12: scope to the file's distinct site names rather than every site
  // in the account. Bounded by the import (<=500 rows => at most a few hundred
  // distinct site names). We only need existing sites that the file references —
  // unknownSites is derived from siteNamesByLc minus what we find here, so a
  // file-scoped lookup gives the identical result.
  //
  // REGRESS-9-1: match case-insensitively. A Postgres `in` is case-SENSITIVE, so
  // generating original/lower/UPPER variants misses any site stored in mixed case
  // (e.g. file "Riverside Plant" vs stored "Riverside plant") and creates a
  // duplicate. Use `mode: 'insensitive'` per distinct name so the DB folds case
  // for us, while still scoping the query to ONLY the file's names (no full-table
  // load); the result map is keyed by lc() exactly as before.
  const siteNameLookups = [...siteNamesByLc.values()]
    .map((orig) => String(orig).trim())
    .filter((t) => t.length > 0);
  const siteRecords = siteNameLookups.length === 0 ? [] : await prisma.site.findMany({
    where:  { accountId: req.user.accountId, OR: siteNameLookups.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })) },
    select: { id: true, name: true },
  });
  const siteByLc = new Map(siteRecords.map((s: any) => [lc(s.name), s]));
  const unknownSites = [...siteNamesByLc.keys()]
    .filter(k => !siteByLc.has(k))
    .map(k => siteNamesByLc.get(k));

  // Dedupe — (accountId, serialNumber), case-insensitive trim, plus repeats
  // within the file itself. Rows that fail validation are excluded (they're
  // "failed", not "skipped").
  //
  // COMP-8-12: scope the existing-serial lookup to THIS FILE's serials instead
  // of pulling every asset-with-a-serial in the account into memory. The import
  // is capped at 500 rows, so the lookup set is tiny; the previous full-table
  // findMany made every preview/commit scale with the whole catalog (a 50k-asset
  // tenant re-read 50k rows for a 10-row import).
  //
  // REGRESS-9-1: match case-insensitively. A Postgres `in` is case-SENSITIVE, so
  // original/lower/UPPER variants miss an existing serial stored in mixed case
  // (e.g. file "Ab123" vs stored "aB123") and bypass the dedupe, inserting a
  // duplicate asset. Use `mode: 'insensitive'` per distinct file serial so the DB
  // folds case, while keeping the query scoped to ONLY the file's serials (no
  // full-table load); the map is keyed by lc() exactly as before.
  const fileSerialLookups = new Set<string>();
  for (const data of normalizedRows) {
    const sn = (data as any).serialNumber;
    if (!sn) continue;
    const trimmed = String(sn).trim();
    if (!trimmed) continue;
    fileSerialLookups.add(trimmed);
  }
  const existingAssets = fileSerialLookups.size === 0 ? [] : await prisma.asset.findMany({
    where:  { accountId: req.user.accountId, OR: [...fileSerialLookups].map((sn) => ({ serialNumber: { equals: sn, mode: 'insensitive' as const } })) },
    select: { id: true, serialNumber: true },
  });
  const existingBySerial = new Map();
  for (const a of existingAssets) {
    const k = lc(a.serialNumber);
    if (k && !existingBySerial.has(k)) existingBySerial.set(k, a.id);
  }

  const errorRowSet = new Set(validationErrors.map(e => e.row));
  const duplicates  = [];
  const dupRowSet   = new Set();
  const seenInFile  = new Set();
  for (let i = 0; i < normalizedRows.length; i++) {
    const rowNum = i + 2;
    if (errorRowSet.has(rowNum)) continue;
    const serial = normalizedRows[i].serialNumber;
    if (!serial) continue;
    const k = lc(serial);
    const existingId = existingBySerial.get(k);
    if (existingId) {
      duplicates.push({ row: rowNum, serialNumber: serial, existingAssetId: existingId, reason: 'Serial number already exists in this account' });
      dupRowSet.add(rowNum);
    } else if (seenInFile.has(k)) {
      duplicates.push({ row: rowNum, serialNumber: serial, existingAssetId: null, reason: 'Serial number repeats earlier in this file' });
      dupRowSet.add(rowNum);
    } else {
      seenInFile.add(k);
    }
  }

  return {
    headers, rows, mapping,
    normalizedRows, validationErrors, errorRowSet,
    siteByLc, unknownSites,
    duplicates, dupRowSet,
  };
}

// Multer wrapper shared by both endpoints — converts the size-cap error to a
// 413 and any other upload error to a 400 instead of the default handler.
function handleUpload(req, res, next) {
  importUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: `File exceeds ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB cap` });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    return next();
  });
}

// ─── POST /api/assets/import/preview ─────────────────────────────────────────
router.post('/preview', requireManager, handleUpload, async (req, res) => {
  try {
    const ctx = await prepareImport(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    return res.json({
      success: true,
      data: {
        step:             'preview',
        totalRows:        ctx.rows.length,
        headers:          ctx.headers,
        suggestedMapping: ctx.mapping,
        schemaFields:     SCHEMA_FIELDS,
        sampleRows:       ctx.rows.slice(0, 10),     // raw rows keyed by header
        validationErrors: ctx.validationErrors,
        duplicates:       ctx.duplicates,
        unknownSites:     ctx.unknownSites,
        maxRows:          MAX_IMPORT_ROWS,
      },
    });
  } catch (err) {
    console.error('POST /api/assets/import/preview error:', err);
    return res.status(500).json({ success: false, error: 'Import preview failed' });
  }
});

// ─── POST /api/assets/import/commit ──────────────────────────────────────────
router.post('/commit', requireManager, handleUpload, async (req, res) => {
  try {
    if (!req.body || !req.body.columnMap) {
      return res.status(400).json({ success: false, error: 'columnMap is required on commit' });
    }
    const ctx = await prepareImport(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    const createMissingSites = String(req.body.createMissingSites || '').toLowerCase() === 'true';
    // N5: default ON — a freshly imported asset with no maintenance program is
    // invisible to compliance. Opt OUT explicitly with autoApplySchedules='false'.
    const autoApplySchedules = String(req.body.autoApplySchedules ?? 'true').toLowerCase() !== 'false';

    if (!createMissingSites && ctx.unknownSites.length > 0) {
      return res.status(400).json({
        success: false,
        error:   `Unknown sites: ${ctx.unknownSites.slice(0, 5).join(', ')}${ctx.unknownSites.length > 5 ? '…' : ''}. Enable "create missing sites" to auto-create.`,
        data:    { unknownSites: ctx.unknownSites },
      });
    }

    const { normalizedRows, validationErrors, errorRowSet, dupRowSet, siteByLc } = ctx;
    const accountId = req.user.accountId;

    // Preload hierarchy lookups once — caches are keyed `${siteId}|${lc(name)}`
    // and shared across rows so duplicate names in the file resolve to one
    // created row. COMP-8-12: bound the preload to the sites the file actually
    // references (those that already exist — siteByLc). Sites created during
    // this import are brand-new and have no buildings/areas/positions to
    // preload, so scoping to known siteIds is complete. Empty set => skip the
    // queries entirely. This stops the import re-reading the whole account
    // hierarchy for a handful of rows.
    const knownSiteIds = [...new Set([...siteByLc.values()].map((s: any) => s.id))];
    const [allBuildings, allAreas, allPositions] = knownSiteIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          prisma.building.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, name: true } }),
          prisma.area.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, buildingId: true, name: true } }),
          prisma.equipmentPosition.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, areaId: true, name: true } }),
        ]);
    const buildingCache = new Map(allBuildings.map(b => [`${b.siteId}|${lc(b.name)}`, b]));
    const areaCache     = new Map(allAreas.map(a => [`${a.siteId}|${lc(a.name)}`, a]));
    const positionCache = new Map(allPositions.map(p => [`${p.siteId}|${lc(p.name)}`, p]));

    const errorRows   = [];   // rows that failed validation or hierarchy linking
    const skippedRows = ctx.duplicates.map(d => ({ row: d.row, serialNumber: d.serialNumber, reason: d.reason }));

    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        // Auto-create unknown sites (gated by flag; we 400'd above otherwise).
        let sitesCreated = 0;
        if (createMissingSites) {
          for (const name of ctx.unknownSites) {
            const site = await tx.site.create({
              data:   { accountId, name: sanitizeFormulaPrefix(String(name).trim()) },
              select: { id: true, name: true },
            });
            siteByLc.set(lc(name), site);
            sitesCreated++;
          }
        }

        let created = 0;
        const createdAssets = []; // { id, equipmentType } for schedule auto-apply

        for (let i = 0; i < normalizedRows.length; i++) {
          const rowNum = i + 2;
          if (errorRowSet.has(rowNum)) {
            const ve = validationErrors.find(e => e.row === rowNum);
            errorRows.push({ row: rowNum, errors: ve ? ve.errors : [{ field: '', error: 'Validation failed' }] });
            continue;
          }
          if (dupRowSet.has(rowNum)) continue; // already in skippedRows

          const r = normalizedRows[i];
          const site: any = siteByLc.get(lc(r.siteName));
          if (!site) {
            // Shouldn't happen — either bailed above or created in this tx.
            errorRows.push({ row: rowNum, errors: [{ field: 'siteName', error: 'Site not found in account' }] });
            continue;
          }

          // Hierarchy resolution — match case-insensitively under the site;
          // create when createMissingSites. Chain consistency mirrors
          // routes/assets.ts resolveHierarchy: an area created directly under
          // the site (buildingId null) pairs with anything; when both sides
          // carry a building they must agree.
          let buildingId = null, areaId = null, positionId = null;
          let linkError = null;

          if (r.buildingName) {
            const bKey = `${site.id}|${lc(r.buildingName)}`;
            let b: any = buildingCache.get(bKey);
            if (!b && createMissingSites) {
              b = await tx.building.create({
                data:   { accountId, siteId: site.id, name: sanitizeFormulaPrefix(String(r.buildingName).trim()) },
                select: { id: true, siteId: true, name: true },
              });
              buildingCache.set(bKey, b);
            }
            if (b) buildingId = b.id;
            // No match + flag off → leave null (the site link is the only
            // hard requirement; we don't fail the row over an optional level).
          }

          if (r.areaName) {
            const aKey = `${site.id}|${lc(r.areaName)}`;
            let a: any = areaCache.get(aKey);
            if (!a && createMissingSites) {
              a = await tx.area.create({
                data: {
                  accountId, siteId: site.id,
                  buildingId: buildingId || null,
                  name: sanitizeFormulaPrefix(String(r.areaName).trim()),
                },
                select: { id: true, siteId: true, buildingId: true, name: true },
              });
              areaCache.set(aKey, a);
            }
            if (a) {
              if (buildingId && a.buildingId && a.buildingId !== buildingId) {
                linkError = { field: 'areaName', error: `Area "${r.areaName}" belongs to a different building at this site` };
              } else {
                areaId = a.id;
                if (!buildingId && a.buildingId) buildingId = a.buildingId; // inherit for chain consistency
              }
            }
          }

          if (!linkError && r.positionName) {
            const pKey = `${site.id}|${lc(r.positionName)}`;
            let p: any = positionCache.get(pKey);
            if (!p && createMissingSites) {
              p = await tx.equipmentPosition.create({
                data: {
                  accountId, siteId: site.id,
                  areaId: areaId || null,
                  name: sanitizeFormulaPrefix(String(r.positionName).trim()),
                },
                select: { id: true, siteId: true, areaId: true, name: true },
              });
              positionCache.set(pKey, p);
            }
            if (p) {
              if (areaId && p.areaId && p.areaId !== areaId) {
                linkError = { field: 'positionName', error: `Position "${r.positionName}" belongs to a different area at this site` };
              } else {
                positionId = p.id;
              }
            }
          }

          if (linkError) {
            errorRows.push({ row: rowNum, errors: [linkError] });
            continue;
          }

          // Default each unset axis to C2 (base interval) per NFPA 70B.
          const physical    = r.conditionPhysical    || 'C2';
          const criticality = r.conditionCriticality || 'C2';
          const environment = r.conditionEnvironment || 'C2';

          const conditionScore  = r.conditionScore  ?? null;
          const criticalityScore = r.criticalityScore ?? null;
          const priorityScore = (conditionScore != null && criticalityScore != null)
            ? conditionScore * criticalityScore
            : null;

          const asset = await tx.asset.create({
            data: {
              accountId,
              siteId:               site.id,
              buildingId,
              areaId,
              positionId,
              equipmentType:        r.equipmentType,
              manufacturer:         sanitizeFormulaPrefix(r.manufacturer) || null,
              model:                sanitizeFormulaPrefix(r.model) || null,
              serialNumber:         sanitizeFormulaPrefix(r.serialNumber) || null,
              installDate:          r.installDate || null,
              conditionPhysical:    physical,
              conditionCriticality: criticality,
              conditionEnvironment: environment,
              governingCondition:   worstCondition(physical, criticality, environment) as any,
              inService:            r.inService === null || r.inService === undefined ? true : r.inService,
              notes:                sanitizeFormulaPrefix(r.notes) || null,
              // Risk dimensions — coerce() already validated/normalized.
              conditionScore,
              criticalityScore,
              priorityScore,
              repairCostEstimate:            r.repairCostEstimate ?? null,
              spareLeadTimeWeeks:            r.spareLeadTimeWeeks ?? null,
              redundancyStatus:              r.redundancyStatus ?? null,
              requiresPredictiveMaintenance: r.requiresPredictiveMaintenance === true,
            },
            select: { id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true, siteId: true },
          });
          createdAssets.push(asset);
          created++;
        }

        // Auto-apply the global NFPA 70B task matrix to the new assets —
        // GLOBAL definitions only (accountId NULL). V3 evidence-grade: the
        // schedules land UNBASELINED (nextDueDate = null) — we have no proof
        // any maintenance was done on freshly-imported gear, so they must not
        // read as compliant. They show on Path-to-100 as "needs baseline";
        // recording the real last-service date (manual or via report ingest)
        // is what makes them current. skipDuplicates keeps it idempotent.
        let schedulesCreated = 0;
        const assetsWithProgram = new Set();
        if (autoApplySchedules && createdAssets.length > 0) {
          const types = [...new Set(createdAssets.map(a => a.equipmentType))];
          const taskDefs = await tx.maintenanceTaskDefinition.findMany({
            where:  { accountId: null, archivedAt: null, equipmentType: { in: types } },
            select: { id: true, equipmentType: true },
          });
          const defsByType = new Map();
          for (const d of taskDefs) {
            if (!defsByType.has(d.equipmentType)) defsByType.set(d.equipmentType, []);
            defsByType.get(d.equipmentType).push(d);
          }
          const scheduleRows = [];
          for (const a of createdAssets) {
            const defs = defsByType.get(a.equipmentType) || [];
            if (defs.length > 0) assetsWithProgram.add(a.id);
            for (const def of defs) {
              scheduleRows.push({ accountId, assetId: a.id, taskDefinitionId: def.id }); // unbaselined
            }
          }
          if (scheduleRows.length > 0) {
            const result = await tx.maintenanceSchedule.createMany({
              data: scheduleRows,
              skipDuplicates: true,
            });
            schedulesCreated = result.count;
          }
        }

        return { created, sitesCreated, schedulesCreated, createdAssets,
                 assetsWithProgramCount: assetsWithProgram.size };
      }, { timeout: 60000 });
    } catch (txErr) {
      console.error('POST /api/assets/import/commit — transaction failed:', txErr);
      return res.status(500).json({ success: false, error: `Import failed: ${txErr.message}` });
    }

    const { created, sitesCreated, schedulesCreated, createdAssets, assetsWithProgramCount } = txResult;
    const skipped = skippedRows.length;
    const failed  = errorRows.length;
    // N4: an import's payoff is the work it surfaces, not the row count. Report
    // how many assets now carry a maintenance program vs. landed without one.
    const assetsWithoutProgram = Math.max(0, created - (assetsWithProgramCount ?? 0));

    // Fire import webhook — fire-and-forget, never blocks the response.
    if (created > 0) {
      const assetSummaries = createdAssets.map((a: any) => ({
        id:           a.id,
        name:         [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset',
        serialNumber: a.serialNumber ?? null,
        siteId:       a.siteId,
      }));
      fireImportWebhook(req.user.accountId, {
        event:         'assets.imported',
        accountId:     req.user.accountId,
        importedCount: created,
        failedCount:   failed,
        timestamp:     new Date().toISOString(),
        assets:        assetSummaries,
      }).catch(() => {}); // swallow — already handled inside fireImportWebhook
    }

    return res.json({
      success: true,
      data: {
        step: 'commit',
        created, skipped, failed,
        sitesCreated, schedulesCreated,
        assetsWithProgram: assetsWithProgramCount ?? 0,
        assetsWithoutProgram,
        skippedRows,
        errors: errorRows,
        createMissingSites, autoApplySchedules,
      },
    });
  } catch (err) {
    console.error('POST /api/assets/import/commit error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;

export {};
