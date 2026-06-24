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

module.exports = { TABLES, TOOLS, sanitizeId, buildMultiTable, renderForTool };

export {};
