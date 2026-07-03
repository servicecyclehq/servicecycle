'use strict';

/**
 * afxToolTemplates.ts — data-driven per-tool AFX IMPORT templates (SKM / ETAP /
 * EasyPower arc-flash RESULT exports → AFX records).
 *
 * A study engineer exports the arc-flash results table from their tool, picks the
 * tool in ServiceCycle, and this module pre-maps the vendor columns onto AFX field
 * keys BEFORE the standard AFX validation/import pipeline runs (which remains the
 * source of truth). Templates live as JSON in server/data/afx/tool-templates/ and
 * are zod-validated on load, with per-mapping confidence labels
 * (verified | probable | assumed) and source notes, because the SKM/EasyPower
 * captions were researched from real artifacts while ETAP captions are drafts.
 *
 * LIABILITY POSTURE (recorded product policy): SC stores PE-stamped study RESULTS,
 * never computes incident energy, and never asserts PPE categories. Templates map
 * fields only; every tool's computed PPE/hazard-category column is mapped to
 * NOTHING (schema-enforced below — a template that targets ppeCategory fails
 * validation). Unit conversions are mechanical only (kV→V, s/cycles→ms with a
 * declared frequency assumption, ft/mm→in, J/cm2→cal/cm2); engineering
 * derivations (e.g. summing trip + opening time) are refused by design.
 *
 * Pure functions; no DB, no network. The route owns persistence.
 */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { AFX_FIELDS, parseDelimited } = require('./arcFlashAfx');

const TEMPLATE_DIR = path.join(__dirname, '..', 'data', 'afx', 'tool-templates');

const AFX_KEYS: Set<string> = new Set(AFX_FIELDS.map((f: any) => f.key));
const AFX_FIELD_BY_KEY: Map<string, any> = new Map(AFX_FIELDS.map((f: any) => [f.key, f]));
const REQUIRED_AFX_KEYS: string[] = AFX_FIELDS.filter((f: any) => f.required).map((f: any) => f.key);

// AFX fields a template may NEVER target (policy: SC does not assert PPE).
const POLICY_FORBIDDEN_TARGETS = new Set(['ppeCategory']);

// ── Mechanical unit conversions (the ONLY transforms templates may declare) ─────
// Each is a pure scale; cyclesToMs additionally reads the template's DECLARED
// frequency assumption. Results are rounded to 9 decimals to keep IEEE-754 noise
// (e.g. 13.8 * 1000 = 13800.000000000002) out of stored values.
const CONVERSIONS: Record<string, { from: string; to: string; apply: (n: number, tpl?: any) => number }> = {
  kvToV: { from: 'kV', to: 'V', apply: (n: number) => n * 1000 },
  sToMs: { from: 's', to: 'ms', apply: (n: number) => n * 1000 },
  cyclesToMs: { from: 'cycles', to: 'ms', apply: (n: number, tpl: any) => n * (1000 / ((tpl && Number(tpl.frequencyAssumptionHz)) || 60)) },
  ftToIn: { from: 'ft', to: 'in', apply: (n: number) => n * 12 },
  mmToIn: { from: 'mm', to: 'in', apply: (n: number) => n / 25.4 },
  jPerCm2ToCalPerCm2: { from: 'J/cm2', to: 'cal/cm2', apply: (n: number) => n / 4.184 },
};

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

// ── Template schema ──────────────────────────────────────────────────────────────
const ConvertSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
});

const MappingSchema = z.strictObject({
  afxField: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  confidence: z.enum(['verified', 'probable', 'assumed']),
  source: z.string().min(1),
  convert: z.union([ConvertSchema, z.null()]),
  note: z.union([z.string().min(1), z.null()]),
});

const PolicyDropSchema = z.strictObject({
  aliases: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  note: z.string().min(1),
});

const UnmappedSchema = z.strictObject({
  aliases: z.array(z.string().min(1)).min(1),
  note: z.string().min(1),
});

const RowCheckSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('warn_if_positive'),
  aliases: z.array(z.string().min(1)).min(1),
  message: z.string().min(1),
});

const ToolTemplateSchema = z.strictObject({
  templateFormatVersion: z.literal('1.0'),
  afxVersion: z.literal('1.0'),
  tool: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  toolVersionRange: z.string().min(1),
  policyNote: z.string().min(10),
  frequencyAssumptionHz: z.number().positive(),
  sourceNotes: z.array(z.string().min(1)).min(1),
  mappings: z.array(MappingSchema).min(1),
  ignoredByPolicy: z.array(PolicyDropSchema).min(1),
  knownUnmapped: z.array(UnmappedSchema),
  rowChecks: z.array(RowCheckSchema),
}).superRefine((tpl: any, ctx: any) => {
  // Every mapping targets a real AFX field — and never a policy-forbidden one.
  tpl.mappings.forEach((m: any, i: number) => {
    if (!AFX_KEYS.has(m.afxField)) {
      ctx.addIssue({ code: 'custom', path: ['mappings', i, 'afxField'], message: `unknown AFX field "${m.afxField}"` });
    }
    if (POLICY_FORBIDDEN_TARGETS.has(m.afxField)) {
      ctx.addIssue({ code: 'custom', path: ['mappings', i, 'afxField'], message: `policy: templates must not map tool PPE/hazard columns to "${m.afxField}"` });
    }
    if (m.convert) {
      const c = CONVERSIONS[m.convert.id];
      if (!c) ctx.addIssue({ code: 'custom', path: ['mappings', i, 'convert'], message: `unknown conversion "${m.convert.id}"` });
      else if (c.from !== m.convert.from || c.to !== m.convert.to) {
        ctx.addIssue({ code: 'custom', path: ['mappings', i, 'convert'], message: `conversion "${m.convert.id}" is ${c.from}→${c.to}, template declares ${m.convert.from}→${m.convert.to}` });
      }
    }
  });
  // An alias may appear in exactly ONE classification bucket (case-insensitive).
  // rowChecks are excluded: they WATCH columns that are classified elsewhere.
  const seen = new Map<string, string>();
  const claim = (alias: string, where: string) => {
    const k = String(alias).trim().toLowerCase();
    if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `alias "${alias}" appears in both ${seen.get(k)} and ${where}` });
    else seen.set(k, where);
  };
  tpl.mappings.forEach((m: any) => m.aliases.forEach((a: string) => claim(a, `mappings(${m.afxField})`)));
  tpl.ignoredByPolicy.forEach((d: any) => d.aliases.forEach((a: string) => claim(a, 'ignoredByPolicy')));
  tpl.knownUnmapped.forEach((u: any) => u.aliases.forEach((a: string) => claim(a, 'knownUnmapped')));
});

// Validate a raw (already-parsed) template object. Returns the typed template or
// throws with a readable message. Exposed for tests.
function validateTemplateObject(raw: any, sourceName: string = 'template'): any {
  const r = ToolTemplateSchema.safeParse(raw);
  if (!r.success) {
    const details = r.error.issues.slice(0, 6).map((i: any) => `${(i.path || []).join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid AFX tool template (${sourceName}): ${details}`);
  }
  return r.data;
}

// ── Loading ─────────────────────────────────────────────────────────────────────
let _cache: any[] | null = null;

function loadToolTemplates(opts: any = {}): any[] {
  if (_cache && !opts.reload) return _cache;
  const dir = opts.dir || TEMPLATE_DIR;
  const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json')).sort();
  const out: any[] = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const tpl = validateTemplateObject(raw, f);
    if (`${tpl.tool}.json` !== f) throw new Error(`Invalid AFX tool template (${f}): tool id "${tpl.tool}" must match the file name`);
    out.push(tpl);
  }
  if (!opts.dir) _cache = out;
  return out;
}

function listToolTemplates(): any[] {
  return loadToolTemplates().map((t: any) => ({
    tool: t.tool,
    label: t.label,
    toolVersionRange: t.toolVersionRange,
    afxVersion: t.afxVersion,
    mappedFieldCount: new Set(t.mappings.map((m: any) => m.afxField)).size,
    aliasCount: t.mappings.reduce((a: number, m: any) => a + m.aliases.length, 0),
    confidence: t.mappings.reduce((acc: any, m: any) => { acc[m.confidence] = (acc[m.confidence] || 0) + 1; return acc; }, {}),
    ignoredByPolicyCount: t.ignoredByPolicy.reduce((a: number, d: any) => a + d.aliases.length, 0),
    policyNote: t.policyNote,
  }));
}

function getToolTemplate(tool: string): any | null {
  const t = String(tool || '').trim().toLowerCase();
  return loadToolTemplates().find((x: any) => x.tool === t) || null;
}

// ── CSV → rows ──────────────────────────────────────────────────────────────────
// Reuses AFX's RFC-4180-ish parser so tool CSVs and AFX CSVs read identically.
function rowsFromCsv(text: string): { headers: string[]; rows: any[] } {
  const table = parseDelimited(String(text || ''));
  if (!table.length) return { headers: [], rows: [] };
  const headers = table[0].map((h: any) => String(h).trim());
  const rows = table.slice(1).map((cells: any[]) => {
    const o: any = {};
    headers.forEach((h: string, i: number) => { o[h] = cells[i]; });
    return o;
  });
  return { headers, rows };
}

// ── applyTemplate ───────────────────────────────────────────────────────────────
// Map parsed tool rows (objects keyed by the tool's headers) onto AFX records.
// Pure. Returns { records, issues, columnReport, summary }. Records carry ONLY
// clean values; every dropped/suspect cell becomes a per-row issue. Downstream
// AFX validation remains the source of truth — this is a pre-mapper, not a gate.
function applyTemplate(rows: any[], template: any, opts: any = {}): any {
  const tpl = template;
  const list = Array.isArray(rows) ? rows : [];
  const maxIssues = opts.maxIssues || 500;

  // Header universe: caller-supplied or first-seen union across rows.
  let headers: string[] = Array.isArray(opts.headers) && opts.headers.length ? opts.headers.map((h: any) => String(h)) : [];
  if (!headers.length) {
    const seen = new Set<string>();
    for (const r of list) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  }

  // Alias index: lowercased alias -> classification.
  const aliasIndex = new Map<string, any>();
  tpl.mappings.forEach((m: any, order: number) => m.aliases.forEach((a: string) => aliasIndex.set(a.trim().toLowerCase(), { kind: 'mapped', mapping: m, order })));
  tpl.ignoredByPolicy.forEach((d: any) => d.aliases.forEach((a: string) => aliasIndex.set(a.trim().toLowerCase(), { kind: 'policy', entry: d })));
  tpl.knownUnmapped.forEach((u: any) => u.aliases.forEach((a: string) => aliasIndex.set(a.trim().toLowerCase(), { kind: 'unmapped', entry: u })));
  const watchIndex = new Map<string, any>();
  (tpl.rowChecks || []).forEach((c: any) => c.aliases.forEach((a: string) => watchIndex.set(a.trim().toLowerCase(), c)));

  const issues: any[] = [];
  const pushIssue = (i: any) => { if (issues.length < maxIssues) issues.push(i); };

  // Classify each header. First template-order mapping wins a contested AFX field.
  const mappedCols: Array<{ header: string; mapping: any }> = [];
  const columnReport: any = { mapped: [], ignoredByPolicy: [], knownUnmapped: [], unknown: [], watched: [] };
  const fieldOwner = new Map<string, string>(); // afxField -> owning header
  for (const h of headers) {
    const hit = aliasIndex.get(String(h).trim().toLowerCase());
    const watcher = watchIndex.get(String(h).trim().toLowerCase());
    if (watcher) columnReport.watched.push({ header: h, checkId: watcher.id });
    if (!hit) { columnReport.unknown.push(h); continue; }
    if (hit.kind === 'policy') { columnReport.ignoredByPolicy.push({ header: h, reason: hit.entry.reason, note: hit.entry.note }); continue; }
    if (hit.kind === 'unmapped') { columnReport.knownUnmapped.push({ header: h, note: hit.entry.note }); continue; }
    const field = hit.mapping.afxField;
    if (fieldOwner.has(field)) {
      pushIssue({ row: null, column: h, kind: 'warning', issue: `duplicate source for ${field}: already mapped from "${fieldOwner.get(field)}"; this column was ignored` });
      columnReport.unknown.push(h);
      continue;
    }
    fieldOwner.set(field, h);
    mappedCols.push({ header: h, mapping: hit.mapping });
    columnReport.mapped.push({
      header: h, afxField: field, confidence: hit.mapping.confidence,
      convert: hit.mapping.convert ? { ...hit.mapping.convert } : null, source: hit.mapping.source,
    });
  }

  const missingRequired = REQUIRED_AFX_KEYS.filter((k) => !fieldOwner.has(k));
  for (const k of missingRequired) {
    const f = AFX_FIELD_BY_KEY.get(k) || { header: k };
    pushIssue({ row: null, column: null, kind: 'error', issue: `no column maps to required AFX field ${k} (${f.header}) — add the tool's column or use AFX headers` });
  }

  // Watched columns present in the file (for warn_if_positive row checks).
  const watchedCols: Array<{ header: string; check: any }> = [];
  for (const h of headers) {
    const c = watchIndex.get(String(h).trim().toLowerCase());
    if (c) watchedCols.push({ header: h, check: c });
  }

  const records: any[] = [];
  list.forEach((row: any, idx: number) => {
    const rec: any = {};
    for (const { header, mapping } of mappedCols) {
      const raw = row ? row[header] : undefined;
      if (raw == null || String(raw).trim() === '') continue;
      const field = AFX_FIELD_BY_KEY.get(mapping.afxField) || {};
      if (mapping.convert) {
        const n = Number(String(raw).trim());
        if (!Number.isFinite(n)) {
          pushIssue({ row: idx + 1, column: header, kind: 'error', value: String(raw).slice(0, 40), issue: `not a number (expected ${mapping.convert.from}, converts to ${mapping.convert.to})` });
          continue;
        }
        rec[mapping.afxField] = round9(CONVERSIONS[mapping.convert.id].apply(n, tpl));
      } else if (field.type === 'number') {
        const n = Number(String(raw).trim());
        if (!Number.isFinite(n)) {
          pushIssue({ row: idx + 1, column: header, kind: 'error', value: String(raw).slice(0, 40), issue: 'not a number — left blank for engineer review' });
          continue;
        }
        rec[mapping.afxField] = n;
      } else {
        rec[mapping.afxField] = String(raw).trim();
      }
    }
    for (const k of REQUIRED_AFX_KEYS) {
      if (fieldOwner.has(k) && (rec[k] == null || rec[k] === '')) {
        pushIssue({ row: idx + 1, column: fieldOwner.get(k), kind: 'error', issue: `missing ${k}` });
      }
    }
    for (const { header, check } of watchedCols) {
      const raw = row ? row[header] : undefined;
      if (raw == null || String(raw).trim() === '') continue;
      const n = Number(String(raw).trim());
      if (Number.isFinite(n) && n > 0) pushIssue({ row: idx + 1, column: header, kind: 'warning', checkId: check.id, issue: check.message });
    }
    records.push(rec);
  });

  const summary = {
    tool: tpl.tool,
    rowCount: list.length,
    recordCount: records.length,
    mappedColumns: mappedCols.length,
    ignoredByPolicyColumns: columnReport.ignoredByPolicy.length,
    knownUnmappedColumns: columnReport.knownUnmapped.length,
    unknownColumns: columnReport.unknown.length,
    missingRequired,
    errorCount: issues.filter((i) => i.kind === 'error').length,
    warningCount: issues.filter((i) => i.kind === 'warning').length,
    truncatedIssues: issues.length >= maxIssues,
  };
  return { records, issues, columnReport, summary };
}

// ── AFX records → multi-table shape ────────────────────────────────────────────
// Adapt flat AFX records to the { buses, cables, transformers, devices } shape the
// existing /afx/import-multi pipeline validates and plans against (that pipeline
// stays the source of truth — duplicate/empty bus IDs etc. are ITS verdict).
function afxRecordsToTables(records: any[]): any {
  const list = Array.isArray(records) ? records : [];
  const buses: any[] = [];
  const cables: any[] = [];
  const transformers: any[] = [];
  const devices: any[] = [];
  const used = new Set<string>();
  const uniqueId = (base: string) => {
    let id = base; let n = 2;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id); return id;
  };

  list.forEach((r: any, i: number) => {
    const busId = r.busName == null ? '' : String(r.busName).trim();
    buses.push({
      busId,
      nominalVoltageV: r.nominalVoltageV != null ? r.nominalVoltageV : undefined,
      equipmentType: r.equipmentType || '',
      incidentEnergyCalCm2: r.incidentEnergyCalCm2 != null ? r.incidentEnergyCalCm2 : undefined,
      labelSeverity: '',
    });
    if (r.cableLengthFt != null || r.cableSize) {
      cables.push({
        cableId: uniqueId(`CBL_${busId || i + 1}`), fromBusId: '', toBusId: busId,
        cableLengthFt: r.cableLengthFt != null ? r.cableLengthFt : undefined,
        cableSize: r.cableSize || '', cableMaterial: r.cableMaterial || '',
        conductorsPerPhase: r.conductorsPerPhase != null ? r.conductorsPerPhase : undefined,
      });
    }
    if (r.transformerKva != null) {
      transformers.push({
        xfmrId: uniqueId(`XFMR_${busId || i + 1}`), fromBusId: '', toBusId: busId,
        transformerKva: r.transformerKva,
        transformerPrimaryV: r.transformerPrimaryV != null ? r.transformerPrimaryV : undefined,
        transformerSecondaryV: r.transformerSecondaryV != null ? r.transformerSecondaryV : undefined,
        transformerImpedancePct: r.transformerImpedancePct != null ? r.transformerImpedancePct : undefined,
      });
    }
    if (r.deviceModel || r.deviceManufacturer || r.deviceType || r.deviceRatingA != null) {
      devices.push({
        deviceId: uniqueId(String(r.deviceModel || `DEV_${busId || i + 1}`).trim()),
        protectsBusId: busId,
        deviceType: r.deviceType || '', deviceManufacturer: r.deviceManufacturer || '',
        deviceModel: r.deviceModel || '', deviceRatingA: r.deviceRatingA != null ? r.deviceRatingA : undefined,
        deviceSettings: r.deviceSettings || '',
      });
    }
  });

  return { buses, cables, transformers, devices };
}

module.exports = {
  TEMPLATE_DIR,
  CONVERSIONS,
  POLICY_FORBIDDEN_TARGETS,
  ToolTemplateSchema,
  validateTemplateObject,
  loadToolTemplates,
  listToolTemplates,
  getToolTemplate,
  rowsFromCsv,
  applyTemplate,
  afxRecordsToTables,
};

export {};
