'use strict';

/**
 * arcFlashAfxMultiTable.ts — AFX multi-table form (v1.2).
 *
 * Power-system tools (ETAP DataX, EasyPower, SKM) don't ingest one flat row per
 * bus — they ingest RELATED tables (Bus / Cable / Transformer / Device) where
 * branches reference bus rows by an exact string ID. This builds that shape from
 * SC's collected model: separate tables, each row a stable ID, cables/transformers
 * keyed to bus IDs via From/To. Per-tool header maps let the same tables export
 * with ETAP / EasyPower column names.
 *
 * Hard rule learned from the tools: connectivity is matched on EXACT string IDs —
 * a trailing space or casing drift silently drops the link. So IDs are sanitized
 * deterministically here (one place), never free-form.
 *
 * Honest scope: AFX-native columns are exact. The ETAP header map is a DRAFT
 * (structure confirmed; field names unverified until checked against a real
 * `File > Export > ETAP DataX` CSV). EasyPower/SKM headers come from EasyPower's
 * published SKM import-mapping templates. Pure + unit-tested.
 */

// Field -> per-tool header. Absent tool key = that tool doesn't carry the field.
const TABLES: Record<string, { sheet: string; fields: any[] }> = {
  buses: {
    sheet: 'Buses',
    fields: [
      { key: 'busId', afx: 'BusID', etap: 'BusID', easypower: 'Description' },
      { key: 'nominalVoltageV', afx: 'Nominal Voltage (V)', etap: 'NomkV', easypower: 'SystemNominalVoltage', etapUnit: 'kV' },
      { key: 'equipmentType', afx: 'Equipment Type', etap: 'Type', easypower: 'Type' },
      { key: 'incidentEnergyCalCm2', afx: 'Incident Energy (cal/cm2)' },
      { key: 'labelSeverity', afx: 'Label Severity' },
    ],
  },
  cables: {
    sheet: 'Cables',
    fields: [
      { key: 'cableId', afx: 'CableID', etap: 'Item_ID', easypower: 'Description' },
      { key: 'fromBusId', afx: 'From Bus', etap: 'From_ID', easypower: 'ConnectedComponent1' },
      { key: 'toBusId', afx: 'To Bus', etap: 'To_ID', easypower: 'ConnectedComponent2' },
      { key: 'cableLengthFt', afx: 'Length (ft)', etap: 'Length', easypower: 'Length' },
      { key: 'cableSize', afx: 'Size', etap: 'Size', easypower: 'CableSize' },
      { key: 'cableMaterial', afx: 'Material', etap: 'Material', easypower: 'ConductorMaterial' },
      { key: 'conductorsPerPhase', afx: 'Conductors/Phase', etap: 'No_Per_Phase', easypower: 'NumberPerPhase' },
    ],
  },
  transformers: {
    sheet: 'Transformers',
    fields: [
      { key: 'xfmrId', afx: 'XfmrID', etap: 'Item_ID', easypower: 'Description' },
      { key: 'fromBusId', afx: 'From Bus', etap: 'From_ID', easypower: 'ConnectedComponent1' },
      { key: 'toBusId', afx: 'To Bus', etap: 'To_ID', easypower: 'ConnectedComponent2' },
      { key: 'transformerKva', afx: 'Rating (kVA)', etap: 'kVAMVA', easypower: 'Nominal kVA' },
      { key: 'transformerPrimaryV', afx: 'Primary (V)', etap: 'PrimkV', easypower: 'SystemNominalVoltage', etapUnit: 'kV' },
      { key: 'transformerSecondaryV', afx: 'Secondary (V)', etap: 'SeckV', easypower: 'SystemNominalVoltageSecondary', etapUnit: 'kV' },
      { key: 'transformerImpedancePct', afx: '%Z', etap: 'Z%', easypower: 'Z%' },
    ],
  },
  devices: {
    sheet: 'Devices',
    fields: [
      { key: 'deviceId', afx: 'DeviceID', easypower: 'Description' },
      { key: 'protectsBusId', afx: 'Protects Bus' },
      { key: 'deviceType', afx: 'Type', easypower: 'EZPType' },
      { key: 'deviceManufacturer', afx: 'Mfr', easypower: 'EZPMfr' },
      { key: 'deviceModel', afx: 'Model' },
      { key: 'deviceRatingA', afx: 'Rating (A)', easypower: 'EZPTripSensorFrame' },
      { key: 'deviceSettings', afx: 'Settings (JSON)', easypower: 'EZPLTPUSetting' },
    ],
  },
};

const TOOLS = ['afx', 'etap', 'easypower'];

// Deterministic, exact-match-safe ID: trim, collapse internal whitespace to '_',
// drop anything outside [A-Za-z0-9_-]. Empty -> fallback.
function sanitizeId(raw: any, fallback: string): string {
  const s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return s || fallback;
}

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

/**
 * Build the related tables from normalized SC rows. Pure.
 * @param rows [{ busName, assetId, fedFromAssetId, nominalVoltage, equipmentType,
 *   incidentEnergyCalCm2, labelSeverity, cableLengthFt, cableSize, cableMaterial,
 *   conductorsPerPhase, sourceModel:{transformerKva,transformerPrimaryV,
 *   transformerSecondaryV,transformerImpedancePct}, devices:[{...}] }]
 */
function buildMultiTable(rows: any[]): any {
  const list = Array.isArray(rows) ? rows : [];
  // assetId -> busId, with collision-safe sanitized IDs.
  const busIdByAsset = new Map<string, string>();
  const usedIds = new Set<string>();
  function uniqueId(base: string): string {
    let id = base; let n = 2;
    while (usedIds.has(id)) { id = `${base}_${n++}`; }
    usedIds.add(id); return id;
  }

  const buses: any[] = [];
  list.forEach((r, i) => {
    const busId = uniqueId(sanitizeId(r.busName, `BUS_${i + 1}`));
    if (r.assetId) busIdByAsset.set(r.assetId, busId);
    r.__busId = busId;
    buses.push({
      busId,
      nominalVoltageV: voltsOf(r.nominalVoltage),
      equipmentType: r.equipmentType || '',
      incidentEnergyCalCm2: num(r.incidentEnergyCalCm2),
      labelSeverity: r.labelSeverity || '',
    });
  });

  const cables: any[] = [];
  const transformers: any[] = [];
  const devices: any[] = [];
  list.forEach((r, i) => {
    const toBusId = r.__busId;
    const fromBusId = r.fedFromAssetId ? (busIdByAsset.get(r.fedFromAssetId) || '') : '';
    if (num(r.cableLengthFt) != null || r.cableSize) {
      cables.push({
        cableId: uniqueId(sanitizeId(`CBL_${r.busName || i + 1}`, `CBL_${i + 1}`)),
        fromBusId, toBusId,
        cableLengthFt: num(r.cableLengthFt), cableSize: r.cableSize || '',
        cableMaterial: r.cableMaterial || '', conductorsPerPhase: num(r.conductorsPerPhase),
      });
    }
    const sm = r.sourceModel || {};
    if (num(sm.transformerKva) != null) {
      transformers.push({
        xfmrId: uniqueId(sanitizeId(`XFMR_${r.busName || i + 1}`, `XFMR_${i + 1}`)),
        fromBusId, toBusId,
        transformerKva: num(sm.transformerKva),
        transformerPrimaryV: voltsOf(sm.transformerPrimaryV),
        transformerSecondaryV: voltsOf(sm.transformerSecondaryV),
        transformerImpedancePct: num(sm.transformerImpedancePct),
      });
    }
    for (const d of (r.devices || [])) {
      devices.push({
        deviceId: uniqueId(sanitizeId(d.label || `DEV_${r.busName || i + 1}`, `DEV_${devices.length + 1}`)),
        protectsBusId: toBusId,
        deviceType: d.deviceType || '', deviceManufacturer: d.manufacturer || '',
        deviceModel: d.model || '', deviceRatingA: num(d.sensorRatingA ?? d.frameRatingA),
        deviceSettings: d.settings && typeof d.settings === 'object' ? JSON.stringify(d.settings) : '',
      });
    }
  });

  return { buses, cables, transformers, devices };
}

// Resolve a value for a tool, applying the documented unit hint (ETAP wants kV).
function toolValue(field: any, tool: string, raw: any): any {
  if (raw == null || raw === '') return '';
  if (tool === 'etap' && field.etapUnit === 'kV' && typeof raw === 'number') return raw / 1000;
  return raw;
}

// Render { tableKey: rows[] } for a tool: header row (that tool's names) + values,
// dropping fields the tool doesn't carry. Returns { sheet, headers, rows }[].
function renderForTool(tables: any, tool: string): any[] {
  const t = TOOLS.includes(tool) ? tool : 'afx';
  return Object.entries(TABLES).map(([tableKey, def]: any) => {
    const cols = def.fields.filter((f: any) => f[t]);
    const headers = cols.map((f: any) => f[t]);
    const rows = (tables[tableKey] || []).map((row: any) => cols.map((f: any) => toolValue(f, t, row[f.key])));
    return { sheet: def.sheet, headers, rows };
  });
}

// ── Validation (conformance checker for an AFX multi-table set) ─────────────────
// A spec is only a standard if you can check conformance. This catches the exact
// failures that silently break a tool import: orphan From/To references, duplicate
// IDs, and whitespace/casing drift (an ID that *looks* matched but isn't byte-equal).

// AFX header -> field key, per table (reverse of the renderForTool 'afx' map).
function afxHeaderToKey(tableKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of TABLES[tableKey].fields) if (f.afx) out[f.afx] = f.key;
  return out;
}

// Map a parsed sheet (headers[] + rows[][]) to objects keyed by AFX field key.
function parseSheetRows(tableKey: string, headers: any[], rows: any[][]): any[] {
  const h2k = afxHeaderToKey(tableKey);
  const idx = headers.map((h) => h2k[String(h).trim()] || null);
  return rows.map((r) => {
    const o: any = {};
    idx.forEach((key, i) => { if (key) o[key] = r[i]; });
    return o;
  });
}

const ID_FIELD: Record<string, string> = { buses: 'busId', cables: 'cableId', transformers: 'xfmrId', devices: 'deviceId' };
// (table, field) pairs that must resolve to a bus ID.
const REFS: Array<[string, string]> = [
  ['cables', 'fromBusId'], ['cables', 'toBusId'],
  ['transformers', 'fromBusId'], ['transformers', 'toBusId'],
  ['devices', 'protectsBusId'],
];

/**
 * Validate an AFX multi-table set. Pure. Returns { ok, errors, warnings, stats }.
 * errors = will-break-import; warnings = drift/empties worth a human look.
 */
function validateMultiTable(tables: any): any {
  const t = tables || {};
  const errors: any[] = [];
  const warnings: any[] = [];

  // Bus ID set (exact) + normalized lookup for drift detection.
  const busIds = new Set<string>();
  const normToBus = new Map<string, string>(); // sanitized -> first exact ID seen
  for (const b of (t.buses || [])) {
    const id = b.busId == null ? '' : String(b.busId);
    if (id.trim() === '') { errors.push({ table: 'buses', issue: 'empty BusID' }); continue; }
    if (busIds.has(id)) errors.push({ table: 'buses', id, issue: 'duplicate BusID' });
    if (id !== id.trim()) warnings.push({ table: 'buses', id, issue: 'BusID has leading/trailing whitespace (silently breaks exact-match imports)' });
    busIds.add(id);
    const norm = sanitizeId(id, '').toUpperCase();
    if (norm && normToBus.has(norm) && normToBus.get(norm) !== id) {
      warnings.push({ table: 'buses', id, issue: `BusID may collide with "${normToBus.get(norm)}" after whitespace/case normalization` });
    } else if (norm && !normToBus.has(norm)) normToBus.set(norm, id);
  }

  // Per-table duplicate IDs.
  for (const tk of ['cables', 'transformers', 'devices']) {
    const seen = new Set<string>();
    for (const row of (t[tk] || [])) {
      const id = row[ID_FIELD[tk]] == null ? '' : String(row[ID_FIELD[tk]]);
      if (id.trim() === '') { warnings.push({ table: tk, issue: `empty ${ID_FIELD[tk]}` }); continue; }
      if (seen.has(id)) errors.push({ table: tk, id, issue: `duplicate ${ID_FIELD[tk]}` });
      seen.add(id);
    }
  }

  // Referential integrity: every From/To/protects must resolve to a bus.
  for (const [tk, field] of REFS) {
    for (const row of (t[tk] || [])) {
      const raw = row[field];
      if (raw == null || String(raw).trim() === '') continue; // blank ref = unknown topology, not an error
      const val = String(raw);
      if (busIds.has(val)) continue; // exact match — good
      const norm = sanitizeId(val, '').toUpperCase();
      const near = norm && normToBus.get(norm);
      if (near) warnings.push({ table: tk, id: row[ID_FIELD[tk]], field, value: val, issue: `references "${val}" — no exact bus, but matches "${near}" after normalization (likely whitespace/case drift)` });
      else errors.push({ table: tk, id: row[ID_FIELD[tk]], field, value: val, issue: `references bus "${val}" which does not exist (orphan reference)` });
    }
  }

  const stats = {
    buses: (t.buses || []).length, cables: (t.cables || []).length,
    transformers: (t.transformers || []).length, devices: (t.devices || []).length,
  };
  return { ok: errors.length === 0, errors, warnings, stats };
}

/**
 * Build a per-field merge-conflict preview for overwrite mode. Pure, no writes.
 * For each matched bus, returns the fields that WOULD be overwritten with their
 * old → new values. Companion to buildFillUpdates — call this in the preview
 * endpoint when overwrite:true so the customer can see exactly what would change
 * before applying.
 * @param tables AFX-keyed { buses, cables, ... }
 * @param existingRows [{ id, busName, nominalVoltage, cableLengthFt, cableSize, cableMaterial, conductorsPerPhase }]
 * @returns { conflicts:[{busName, busId, changes:{field:{old,new}}}], totalConflicts }
 */
function buildMergeConflictPreview(tables: any, existingRows: any[]): any {
  const t = tables || {};
  const byKey = new Map<string, any>();
  for (const r of (existingRows || [])) { const k = normKey(r.busName); if (k && !byKey.has(k)) byKey.set(k, r); }
  const cableByTo = new Map<string, any>();
  for (const c of (t.cables || [])) { const k = normKey(c.toBusId); if (k && !cableByTo.has(k)) cableByTo.set(k, c); }

  const numOr = (v: any) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const intOr = (v: any) => { const n = numOr(v); return n == null ? null : Math.round(n); };
  const blank = (v: any) => v == null || v === '';
  const eq = (a: any, b: any) => String(a) === String(b);

  const conflicts: any[] = [];
  for (const b of (t.buses || [])) {
    const k = normKey(b.busId);
    const ex = k ? byKey.get(k) : null;
    if (!ex) continue; // new bus — no conflict
    const cable = cableByTo.get(k) || {};
    const changes: Record<string, { old: any; new: any }> = {};
    const check = (field: string, val: any) => {
      if (val == null || val === '') return;
      if (!blank(ex[field]) && !eq(ex[field], val)) changes[field] = { old: ex[field], new: val };
    };
    check('nominalVoltage', b.nominalVoltageV != null && b.nominalVoltageV !== '' ? `${b.nominalVoltageV}V` : null);
    check('cableLengthFt', numOr(cable.cableLengthFt));
    check('cableSize', cable.cableSize);
    check('cableMaterial', cable.cableMaterial);
    check('conductorsPerPhase', intOr(cable.conductorsPerPhase));
    if (Object.keys(changes).length) conflicts.push({ busName: ex.busName, busId: b.busId, changes });
  }
  return { conflicts, totalConflicts: conflicts.length };
}

// ── Import planning (DRY-RUN — computes what an import WOULD do; writes nothing) ─
// Round-tripping a tool's model back INTO SC is a write operation, so it's gated
// behind a preview: the customer sees exactly what would be created vs. updated
// before anything is applied. This planner is pure; the apply step is separate and
// confirm-gated.

const normKey = (s: any) => sanitizeId(s, '').toUpperCase();

/**
 * Plan a multi-table import against the account's existing buses. Pure, no writes.
 * @param tables { buses, cables, transformers, devices } (AFX-keyed rows)
 * @param existingBusNames string[] of the account's current bus names
 * @returns { summary, createBuses, updateBuses, matchedByName }
 */
function planMultiTableImport(tables: any, existingBusNames: string[]): any {
  const t = tables || {};
  const existing = new Map<string, string>(); // normKey -> the existing name it matched
  for (const n of (existingBusNames || [])) { const k = normKey(n); if (k && !existing.has(k)) existing.set(k, n); }

  const createBuses: string[] = [];
  const updateBuses: string[] = [];
  const matchedByName: Array<{ incoming: string; existing: string }> = [];
  for (const b of (t.buses || [])) {
    const id = b.busId == null ? '' : String(b.busId);
    const k = normKey(id);
    if (k && existing.has(k)) { updateBuses.push(id); matchedByName.push({ incoming: id, existing: existing.get(k)! }); }
    else createBuses.push(id);
  }

  return {
    summary: {
      incomingBuses: (t.buses || []).length,
      newBuses: createBuses.length,
      matchedBuses: updateBuses.length,
      incomingCables: (t.cables || []).length,
      incomingTransformers: (t.transformers || []).length,
      incomingDevices: (t.devices || []).length,
    },
    createBuses, updateBuses, matchedByName,
  };
}

/**
 * Compute FILL-ONLY updates for matched buses. Pure, no writes. Conservative by
 * design: a field is set ONLY when the incoming value is present AND the existing
 * value is blank — it never overwrites data already in SC (so it can't clobber a
 * PE's stamped values). New buses are reported, not created. Idempotent: re-running
 * fills nothing once values are set.
 * @param tables AFX-keyed { buses, cables, ... }
 * @param existingRows [{ id, busName, nominalVoltage, cableLengthFt, cableSize, cableMaterial, conductorsPerPhase }]
 * @returns { updates:[{id,set}], summary }
 */
function buildFillUpdates(tables: any, existingRows: any[], opts: any = {}): any {
  const t = tables || {};
  const overwrite = !!(opts && opts.overwrite);
  const byKey = new Map<string, any>();
  for (const r of (existingRows || [])) { const k = normKey(r.busName); if (k && !byKey.has(k)) byKey.set(k, r); }
  const cableByTo = new Map<string, any>();
  for (const c of (t.cables || [])) { const k = normKey(c.toBusId); if (k && !cableByTo.has(k)) cableByTo.set(k, c); }

  const numOr = (v: any) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const intOr = (v: any) => { const n = numOr(v); return n == null ? null : Math.round(n); };
  const blank = (v: any) => v == null || v === '';
  const eq = (a: any, b: any) => String(a) === String(b);

  const updates: any[] = [];
  let matched = 0, skippedNew = 0, skippedNoChange = 0, overwritten = 0;
  for (const b of (t.buses || [])) {
    const k = normKey(b.busId);
    const ex = k ? byKey.get(k) : null;
    if (!ex) { skippedNew++; continue; }
    matched++;
    const cable = cableByTo.get(k) || {};
    const set: any = {};
    // fill-only: write a present incoming value into a BLANK field. overwrite:
    // also replace a non-blank existing value, but only when it actually differs
    // (and never clobber an existing value WITH a blank — imports add, never erase).
    const fill = (field: string, val: any) => {
      if (val == null || val === '') return;
      if (blank(ex[field])) { set[field] = val; }
      else if (overwrite && !eq(ex[field], val)) { set[field] = val; overwritten++; }
    };
    fill('nominalVoltage', b.nominalVoltageV != null && b.nominalVoltageV !== '' ? `${b.nominalVoltageV}V` : null);
    fill('cableLengthFt', numOr(cable.cableLengthFt));
    fill('cableSize', cable.cableSize);
    fill('cableMaterial', cable.cableMaterial);
    fill('conductorsPerPhase', intOr(cable.conductorsPerPhase));
    if (Object.keys(set).length) updates.push({ id: ex.id, set }); else skippedNoChange++;
  }
  const fieldsSet = updates.reduce((a, u) => a + Object.keys(u.set).length, 0);
  return { updates, summary: { matched, willUpdate: updates.length, fieldsSet, overwritten, skippedNew, skippedNoChange, mode: overwrite ? 'overwrite' : 'fill_only' } };
}

// Map an incoming equipment-type string to a valid Prisma EquipmentType. Pure.
// Keep EQUIPMENT_TYPES in sync with schema.prisma enum EquipmentType. Unknown or
// blank -> PANELBOARD (neutral LV default); the raw string is preserved by the
// caller in nameplateData so nothing is lost.
const EQUIPMENT_TYPES = new Set([
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD', 'BUSWAY',
  'GENERATOR', 'MOTOR', 'MCC', 'VFD', 'UPS_BATTERY', 'BATTERY_SYSTEM', 'CIRCUIT_BREAKER', 'FUSE_GEAR',
  'DISCONNECT_SWITCH', 'TRANSFER_SWITCH', 'PROTECTION_RELAY', 'GROUND_FAULT_PROTECTION', 'SURGE_ARRESTER',
  'CABLE_LV', 'CABLE_MV_HV', 'CABLE_TRAY', 'GROUNDING_SYSTEM', 'EMERGENCY_LIGHTING', 'ARC_FLASH_PANEL', 'FIRE_PUMP_CONTROLLER',
]);
function mapEquipmentType(raw: any): string {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return EQUIPMENT_TYPES.has(s) ? s : 'PANELBOARD';
}

module.exports = { TABLES, TOOLS, sanitizeId, buildMultiTable, renderForTool, parseSheetRows, validateMultiTable, planMultiTableImport, buildFillUpdates, buildMergeConflictPreview, mapEquipmentType, EQUIPMENT_TYPES };

export {};
