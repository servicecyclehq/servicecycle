'use strict';

/**
 * POST /api/contracts/import — bulk import from CSV or Excel (.xlsx/.xls)
 *   v0.6.0 added CSV; v0.16.0 adds XLSX via SheetJS (same pipeline, symmetric to /export)
 *
 * Two-step flow controlled by `?step=preview|commit`:
 *
 *   preview  — multipart `file=<csv|xlsx>`. Parse + per-row validate + suggest
 *              column mapping. Does NOT commit. Returns sample + errors +
 *              duplicates + unknown-vendor list so the UI can render a
 *              review modal.
 *
 *   commit   — multipart `file=<csv|xlsx>` plus optional form fields:
 *                mapping              JSON object  CSV header -> schema field
 *                dedupeStrategy       'skip'|'update'|'create' (default 'skip')
 *                createMissingVendors 'true'|'false'           (default 'false')
 *              Re-parses (no server-side cache), applies mapping, and inserts
 *              within a single Prisma transaction. Rolls back the entire
 *              batch on any DB-level failure (transaction guarantee). Rows
 *              with row-level validation errors are skipped and reported
 *              individually in the response; they never reach the DB.
 *
 * Caps: 1000 data rows / 5MB file per request. Manager+ only.
 *
 * Per-row validation reuses the same coercion rules as the create-contract
 * path so an export -> edit -> re-import round-trip is a no-op for the
 * supported column set.
 *
 * Dedupe key: (accountId, vendorId, endDate). Existing rows matched on this
 * tuple are handled per the chosen strategy.
 *
 * Activity log: one `bulk_contract_import` row per call with counts
 * (created / updated / skipped / failed). No per-row activity rows — that
 * would dilute the contract-level audit timeline.
 */

const router = require('express').Router();
const multer = require('multer');
const Papa = require('papaparse');
// W7 (audit Cluster A P1): migrated off xlsx@^0.18.5 to exceljs.
// xlsx (SheetJS Community) ships CVE-2023-30533 (prototype pollution via
// crafted spreadsheet) and CVE-2024-22363 (ReDoS) and SheetJS stopped
// publishing fixes to npm — the only supported channel is their CDN tarball.
// exceljs was already a dependency for the export path; reusing it here
// drops a vulnerable dep entirely.
const ExcelJS = require('exceljs');

const { requireManager } = require('../middleware/roles');
const { calculateEvaluationStartByDate, calculateCancelByDate } = require('../utils/dates');
import prisma from '../lib/prisma';

// #28: load this account configurable evaluation lead-time model. Returns the
// parsed config object or null (null => built-in defaults in utils/dates).
// Defensive: a missing row or bad JSON quietly falls back and never throws.
async function loadEvalLeadTimes(accountId) {
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'EVALUATION_LEAD_TIMES' } },
    });
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch { return null; }
}

const MAX_IMPORT_ROWS  = 1000;
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

/**
 * Cell-value normalizer for exceljs. Mirrors what xlsx@0.18 did with
 * `raw: false` — every cell becomes a string. Hyperlinks return their
 * text label; rich-text cells return concatenated runs; formula cells
 * return the cached result; dates render in ISO; everything else gets
 * String(). Empty/null → ''.
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
 * Parse a multer-uploaded file buffer into { headers: string[], rows: object[] }
 * where each row is a plain object keyed by header string (same shape papaparse gives us).
 * Supports .csv and .xlsx/.xls.
 *
 * W7: xlsx path migrated from xlsx@0.18 to exceljs. Async because
 * ExcelJS.Workbook.xlsx.load returns a promise.
 */
async function parseUploadedFile(buffer, originalname) {
  const isXlsx = /\.(xlsx|xls)$/i.test(originalname || '');

  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };

    // ExcelJS rows are 1-indexed. Row 1 = headers. eachRow walks every
    // populated row in order.
    let headers = [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      // Values is 1-indexed; index 0 is always null in eachRow output.
      const values = row.values || [];
      if (rowNumber === 1) {
        headers = values.slice(1).map(h => _cellToString(h).trim());
        return;
      }
      // Skip rows where every cell is empty.
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

  // CSV path (unchanged behaviour)
  const text   = buffer.toString('utf8');
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, trimHeaders: true });
  const headers = parsed.meta.fields || [];
  const rows    = parsed.data || [];
  return { headers, rows };
}

// ── Mapping: /export CSV headers + common aliases -> internal field keys ──
// Header lookups are lowercased + trimmed. `null` = computed column, ignored
// on import (Evaluate By, Cancel By, Total Value).
const CSV_HEADER_TO_FIELD: any = {
  'vendor':                'vendor',         // special: name lookup
  'vendor name':           'vendor',
  'product':               'product',
  'contract #':            'contractNumber',
  'contract number':       'contractNumber',
  'customer #':            'customerNumber',
  'customer number':       'customerNumber',
  'status':                'status',
  'start date':            'startDate',
  'end date':              'endDate',
  'evaluate by':           null,             // computed
  'cancel by':             null,             // computed
  'quantity':              'quantity',
  'qty':                   'quantity',
  'cost per license':      'costPerLicense',
  'cost':                  'costPerLicense',
  'unit cost':             'costPerLicense',
  'total value':           null,             // computed
  'auto renewal':          'autoRenewal',
  'auto-renewal':          'autoRenewal',
  'notice days':           'autoRenewalNoticeDays',
  'po number':             'poNumber',
  'po #':                  'poNumber',
  'invoice number':        'invoiceNumber',
  'invoice #':             'invoiceNumber',
  'department':            'department',
  'team':                  'team',
  'cost center':           'costCenter',
  'requestor':             'requestor',
  'reseller':              'resellerName',
  'reseller / distributor':'resellerName',
  'reseller account #':    'resellerAccountNumber',
  'reseller contact':      'resellerContactName',
  'reseller email':        'resellerContactEmail',
  'notes':                 'notes',
};

// Surfaced to the client for the mapping dropdown UI. Order mirrors /export.
const SCHEMA_FIELDS = [
  { key: 'vendor',                label: 'Vendor (lookup by name)', type: 'vendorName', required: true },
  { key: 'product',               label: 'Product',                  type: 'string',     required: true },
  { key: 'contractNumber',        label: 'Contract #',               type: 'string' },
  { key: 'customerNumber',        label: 'Customer #',               type: 'string' },
  { key: 'status',                label: 'Status',                   type: 'enum',
    options: ['active','under_review','renewed','cancelled','expired'] },
  { key: 'startDate',             label: 'Start Date',               type: 'date' },
  { key: 'endDate',               label: 'End Date',                 type: 'date' },
  { key: 'quantity',              label: 'Quantity',                 type: 'integer' },
  { key: 'costPerLicense',        label: 'Cost Per License',         type: 'number' },
  { key: 'autoRenewal',           label: 'Auto Renewal',             type: 'boolean' },
  { key: 'autoRenewalNoticeDays', label: 'Notice Days',              type: 'integer' },
  { key: 'poNumber',              label: 'PO Number',                type: 'string' },
  { key: 'invoiceNumber',         label: 'Invoice Number',           type: 'string' },
  { key: 'department',            label: 'Department',               type: 'string' },
  { key: 'team',                  label: 'Team',                     type: 'string' },
  { key: 'costCenter',            label: 'Cost Center',              type: 'string' },
  { key: 'requestor',             label: 'Requestor',                type: 'string' },
  { key: 'resellerName',          label: 'Reseller',                 type: 'string' },
  { key: 'resellerAccountNumber', label: 'Reseller Account #',       type: 'string' },
  { key: 'resellerContactName',   label: 'Reseller Contact',         type: 'string' },
  { key: 'resellerContactEmail',  label: 'Reseller Email',           type: 'string' },
  { key: 'notes',                 label: 'Notes',                    type: 'string' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function suggestMapping(headers, customDefs) {
  const m: any = {};
  for (const h of headers) {
    const key = String(h || '').trim().toLowerCase();
    if (!key) { m[h] = null; continue; }
    if (CSV_HEADER_TO_FIELD[key] !== undefined) {
      m[h] = CSV_HEADER_TO_FIELD[key];
      continue;
    }
    const cf = customDefs.find(d => d.name.trim().toLowerCase() === key);
    m[h] = cf ? `custom:${cf.fieldKey}` : null;
  }
  return m;
}

// Coerce a raw CSV cell into the JS shape the Contract model expects.
// Returns the coerced value, or an Error whose .message is human-readable.
// null/empty inputs return null (= "leave field blank").
function coerce(field, raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '') return null;

  switch (field) {
    case 'startDate':
    case 'endDate': {
      let d = null;
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        d = new Date(s);
      } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
        const [mm, dd, yy] = s.split('/');
        d = new Date(`${yy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`);
      } else {
        d = new Date(s);
      }
      if (Number.isNaN(d?.getTime?.())) return new Error(`Invalid date: "${s}"`);
      return d;
    }
    case 'quantity':
    case 'autoRenewalNoticeDays': {
      const cleaned = s.replace(/,/g, '');
      if (!/^-?\d+$/.test(cleaned)) return new Error(`Invalid integer: "${s}"`);
      return parseInt(cleaned, 10);
    }
    case 'costPerLicense': {
      const cleaned = s.replace(/[$,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return new Error(`Invalid number: "${s}"`);
      return parseFloat(cleaned);
    }
    case 'autoRenewal': {
      const v = s.toLowerCase();
      if (['yes','true','y','1'].includes(v)) return true;
      if (['no','false','n','0'].includes(v)) return false;
      return new Error(`Invalid boolean: "${s}" (expected Yes/No)`);
    }
    case 'status': {
      const v = s.toLowerCase().replace(/[ -]/g, '_');
      const allowed = ['active','under_review','renewed','cancelled','expired'];
      if (allowed.includes(v)) return v;
      return new Error(`Invalid status: "${s}"`);
    }
    case 'resellerContactEmail':
    case 'deliveryEmail':
    case 'endUserEmail': {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return new Error(`Invalid email: "${s}"`);
      return s;
    }
    default:
      return s;
  }
}

function csvEscape(v) {
  if (v == null) return '';
  let s = String(v);
  // formula-injection guard, same as /export
  if (/^\s*[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Audit Cluster A P2 (2026-05-16): defense-in-depth formula-injection
// guard for the write path. Pre-fix, only the EXPORT path (contracts.js
// /export and the error-CSV emitter above) prefixed formula triggers.
// A cell containing "=cmd|'/c calc'!A1" in a Notes column was stored
// verbatim — subsequent re-exports via /export re-armored it, but a
// customer pivoting to a different export tool (or any direct CSV dump
// from the DB) would carry the payload unmolested. Sanitize on the way
// in so the value in the row is never dangerous.
//
// Only applied to free-form text fields (notes, descriptions, etc.).
// Number/date/UUID columns can't carry a formula trigger meaningfully.
function sanitizeFormulaPrefix(v) {
  if (v == null) return v;
  if (typeof v !== 'string') return v;
  if (/^\s*[=+\-@\t\r]/.test(v)) return "'" + v;
  return v;
}

// Transaction-aware custom-field upsert. Mirrors the helper in contracts.js
// but takes the prisma tx client so writes are part of the import's
// atomic batch. Unknown field keys are silently ignored (a CSV from a
// peer instance may have columns the target account doesn't define).
async function applyCustomFieldsInTx(tx, accountId, contractId, customFieldsMap) {
  if (!customFieldsMap || typeof customFieldsMap !== 'object') return;
  const { validateValueForDefinition } = require('./customFields');

  const definitions = await tx.customFieldDefinition.findMany({
    where: { accountId, archivedAt: null },
  });
  const byKey = new Map(definitions.map(d => [d.fieldKey, d]));

  for (const [key, raw] of Object.entries<any>(customFieldsMap)) {
    const def: any = byKey.get(key);
    if (!def) continue;
    let stored;
    try {
      stored = validateValueForDefinition(def, raw);
    } catch (err) {
      throw new Error(`Custom field "${def.name}": ${err.message}`);
    }
    if (stored == null) {
      await tx.customFieldValue.deleteMany({
        where: { contractId, definitionId: def.id },
      });
      continue;
    }
    await tx.customFieldValue.upsert({
      where:  { contractId_definitionId: { contractId, definitionId: def.id } },
      update: { value: stored },
      create: { contractId, definitionId: def.id, value: stored },
    });
  }
}

// Pick the subset of a normalized row that corresponds to Contract columns.
// Excludes internal helpers (vendorName, _customFields).
function pickContractFields(r) {
  const out: any = {};
  const cols = [
    'contractNumber','customerNumber','quantity','costPerLicense',
    'startDate','endDate','autoRenewal','autoRenewalNoticeDays',
    'poNumber','invoiceNumber','requestor','deliveryEmail','licenseKeys',
    'department','team','costCenter','endUserName','endUserEmail',
    'deliveryMethod','notes','status',
    'resellerName','resellerAccountNumber','resellerContactName','resellerContactEmail',
  ];
  // Audit Cluster A P2: free-form text columns get the formula-injection
  // guard applied on the way in. Numeric/date/boolean/enum columns can't
  // carry a meaningful trigger. Keep this list in sync with the schema's
  // text-typed string columns.
  const TEXT_COLS_FORMULA_GUARD = new Set([
    'contractNumber','customerNumber','poNumber','invoiceNumber',
    'requestor','deliveryEmail','licenseKeys','department','team',
    'costCenter','endUserName','endUserEmail','deliveryMethod','notes',
    'resellerName','resellerAccountNumber','resellerContactName','resellerContactEmail',
  ]);
  for (const c of cols) {
    if (r[c] !== undefined) {
      out[c] = TEXT_COLS_FORMULA_GUARD.has(c) ? sanitizeFormulaPrefix(r[c]) : r[c];
    }
  }
  return out;
}

function dedupeKeyOf(vendorId, endDate) {
  const dKey = endDate ? new Date(endDate).toISOString().split('T')[0] : 'null';
  return `${vendorId}|${dKey}`;
}

// ── POST /api/contracts/import ──────────────────────────────────────────────

router.post('/', requireManager, (req, res, next) => {
  importUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: `CSV exceeds ${MAX_IMPORT_BYTES} bytes (${Math.round(MAX_IMPORT_BYTES/1024/1024)}MB)` });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    return next();
  });
}, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const step = (req.query.step === 'commit') ? 'commit' : 'preview';

    // Parse file — CSV or XLSX via shared helper. Async because exceljs's
    // workbook.xlsx.load returns a promise (W7 migration from xlsx@0.18).
    let parsed;
    try {
      parsed = await parseUploadedFile(req.file.buffer, req.file.originalname);
    } catch (parseErr) {
      return res.status(400).json({ success: false, error: `File parse error: ${parseErr.message}` });
    }
    const { headers, rows } = parsed;

    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'File contained no data rows' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ success: false, error: `Import exceeds ${MAX_IMPORT_ROWS}-row cap (${rows.length} rows)` });
    }
    if (headers.length === 0) {
      return res.status(400).json({ success: false, error: 'File has no header row' });
    }

    // Custom field definitions for this account (used by mapping + commit)
    const customDefs = await prisma.customFieldDefinition.findMany({
      where: { accountId: req.user.accountId, archivedAt: null },
    });

    // Build mapping — client-supplied on commit, suggested on preview
    let mapping;
    if (step === 'commit' && req.body.mapping) {
      try { mapping = JSON.parse(req.body.mapping); }
      catch { return res.status(400).json({ success: false, error: 'mapping must be valid JSON' }); }
      if (typeof mapping !== 'object' || mapping === null) {
        return res.status(400).json({ success: false, error: 'mapping must be a JSON object' });
      }
    } else {
      mapping = suggestMapping(headers, customDefs);
    }

    // Require Vendor + Product to be mapped (always — both required schema cols)
    const targetFields = Object.values<any>(mapping).filter(Boolean);
    const missingRequired = [];
    if (!targetFields.includes('vendor'))  missingRequired.push('Vendor');
    if (!targetFields.includes('product')) missingRequired.push('Product');
    if (missingRequired.length > 0) {
      return res.status(400).json({
        success: false,
        error:   `CSV is missing required column(s): ${missingRequired.join(', ')}. Use the mapping UI to map an existing column.`,
        data:    { headers, suggestedMapping: mapping },
      });
    }

    // Per-row coerce + validate
    const vendorNamesNeeded = new Set<string>();      // canonical-case set
    const vendorNamesByLc   = new Map();       // lc -> original
    const normalizedRows    = [];
    const validationErrors  = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const data: any = { _customFields: {} };
      const rowErrors = [];

      for (const [csvHeader, fieldKey] of Object.entries<any>(mapping)) {
        if (!fieldKey) continue;
        const raw = r[csvHeader];

        if (fieldKey.startsWith('custom:')) {
          data._customFields[fieldKey.slice('custom:'.length)] = (raw == null) ? null : String(raw);
          continue;
        }

        if (fieldKey === 'vendor') {
          const name = (raw == null ? '' : String(raw)).trim();
          if (!name) { rowErrors.push({ field: 'vendor', error: 'Vendor name is required' }); continue; }
          data.vendorName = name;
          const lc = name.toLowerCase();
          vendorNamesNeeded.add(lc);
          if (!vendorNamesByLc.has(lc)) vendorNamesByLc.set(lc, name);
          continue;
        }

        if (fieldKey === 'product') {
          const p = (raw == null ? '' : String(raw)).trim();
          if (!p) { rowErrors.push({ field: 'product', error: 'Product is required' }); continue; }
          data.product = p;
          continue;
        }

        const coerced = coerce(fieldKey, raw);
        if (coerced instanceof Error) {
          rowErrors.push({ field: fieldKey, error: coerced.message });
          continue;
        }
        data[fieldKey] = coerced;
      }

      // Belt-and-suspenders: if vendor/product weren't mapped at all for this row
      if (data.vendorName === undefined && !rowErrors.some(e => e.field === 'vendor')) {
        rowErrors.push({ field: 'vendor', error: 'Vendor name is required' });
      }
      if (data.product === undefined && !rowErrors.some(e => e.field === 'product')) {
        rowErrors.push({ field: 'product', error: 'Product is required' });
      }

      normalizedRows.push(data);
      if (rowErrors.length > 0) {
        validationErrors.push({ row: i + 2, errors: rowErrors });  // +2 = 1-indexed + header row
      }
    }

    // Existing vendors in the account (case-insensitive match by trimmed name)
    const vendorRecords = await prisma.vendor.findMany({
      where:  { accountId: req.user.accountId },
      select: { id: true, name: true },
    });
    const vendorByLc = new Map(vendorRecords.map(v => [v.name.trim().toLowerCase(), v]));
    const unknownVendors = [...vendorNamesNeeded]
      .filter(lc => !vendorByLc.has(lc))
      .map(lc => vendorNamesByLc.get(lc));

    // Dedupe lookup — (vendorId, endDate) within accountId, archived excluded
    const knownVendorIds = vendorRecords.map(v => v.id);
    const existingContracts = knownVendorIds.length === 0 ? [] : await prisma.contract.findMany({
      where:  { accountId: req.user.accountId, archivedAt: null, vendorId: { in: knownVendorIds } },
      select: { id: true, vendorId: true, endDate: true, product: true },
    });
    const existingByKey = new Map();
    for (const c of existingContracts) {
      existingByKey.set(dedupeKeyOf(c.vendorId, c.endDate), c);
    }

    const duplicates = [];
    for (let i = 0; i < normalizedRows.length; i++) {
      const r = normalizedRows[i];
      if (!r.vendorName) continue;
      const v: any = vendorByLc.get(r.vendorName.toLowerCase());
      if (!v) continue;
      const dup = existingByKey.get(dedupeKeyOf(v.id, r.endDate));
      if (dup) {
        duplicates.push({
          row: i + 2,
          existingContractId: dup.id,
          existingProduct: dup.product,
          newProduct: r.product,
        });
      }
    }

    if (step === 'preview') {
      return res.json({
        success: true,
        data: {
          step:             'preview',
          totalRows:        rows.length,
          headers,
          suggestedMapping: mapping,
          schemaFields:     SCHEMA_FIELDS,
          customFields:     customDefs.map(d => ({
            key: d.fieldKey, name: d.name, type: d.type, required: d.required,
          })),
          sampleRows:       normalizedRows.slice(0, 10).map(r => ({ ...r, _customFields: undefined })),
          validationErrors,
          duplicates,
          unknownVendors,
          maxRows:          MAX_IMPORT_ROWS,
        },
      });
    }

    // ── COMMIT step ─────────────────────────────────────────────────────────
    const dedupeStrategy = ['skip', 'update', 'create'].includes(req.body.dedupeStrategy)
      ? req.body.dedupeStrategy
      : 'skip';
    const createMissingVendors = String(req.body.createMissingVendors || '').toLowerCase() === 'true';
    const importArchived = String(req.body.archived || '').toLowerCase() === 'true'; // #10: archived-contracts import lands rows in archived state

    if (!createMissingVendors && unknownVendors.length > 0) {
      return res.status(400).json({
        success: false,
        error:   `Unknown vendors: ${unknownVendors.slice(0, 5).join(', ')}${unknownVendors.length > 5 ? '...' : ''}. Set createMissingVendors=true to auto-create.`,
        data:    { unknownVendors },
      });
    }

    // Default category — every account is seeded with a "saas" category at
    // creation time. Imported contracts inherit it; users can re-categorize later.
    const saasDefault = await prisma.category.findUnique({
      where: { accountId_slug: { accountId: req.user.accountId, slug: 'saas' } },
    });
    const defaultCategoryId = saasDefault?.id ?? null;

    const errorRows = [];   // rows we couldn't commit (validation failures)
    let created = 0, updated = 0, skipped = 0;

    const _eltCfg = await loadEvalLeadTimes(req.user.accountId); // #28 configurable lead times
    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        // Auto-create unknown vendors (commit-step only, gated by flag)
        const newVendorByLc = new Map();
        if (createMissingVendors) {
          for (const name of unknownVendors) {
            const lc = name.toLowerCase();
            const v = await tx.vendor.create({
              // Audit Cluster A P2: vendor names are user-controlled free-form
              // strings that round-trip into exports. Same formula-injection
              // guard as the contract text columns.
              data:   { accountId: req.user.accountId, name: sanitizeFormulaPrefix(name) },
              select: { id: true, name: true },
            });
            newVendorByLc.set(lc, v);
          }
        }

        let txCreated = 0, txUpdated = 0, txSkipped = 0;

        for (let i = 0; i < normalizedRows.length; i++) {
          const r       = normalizedRows[i];
          const rowNum  = i + 2;
          const rowHadValidationErr = validationErrors.find(e => e.row === rowNum);

          if (rowHadValidationErr) {
            errorRows.push({ row: rowNum, errors: rowHadValidationErr.errors, raw: rows[i] });
            continue;  // not skipped (skipped = "dup with skip strategy"); failed
          }

          const lc = r.vendorName.toLowerCase();
          const vendor = vendorByLc.get(lc) || newVendorByLc.get(lc);
          if (!vendor) {
            // shouldn't happen — we either bailed earlier or created them above
            errorRows.push({ row: rowNum, errors: [{ field: 'vendor', error: 'Vendor not found in account' }], raw: rows[i] });
            continue;
          }

          const existing = existingByKey.get(dedupeKeyOf(vendor.id, r.endDate));

          if (existing && dedupeStrategy === 'skip') {
            txSkipped++;
            continue;
          }

          const writeData = pickContractFields(r);

          if (existing && dedupeStrategy === 'update') {
            // Recompute derived fields if endDate / cost / qty / autoRenewal changed
            const merged: any = {
              endDate:              writeData.endDate ?? existing.endDate,
              costPerLicense:       writeData.costPerLicense,
              quantity:             writeData.quantity,
              autoRenewal:          writeData.autoRenewal,
              autoRenewalNoticeDays: writeData.autoRenewalNoticeDays,
            };
            writeData.evaluationStartByDate = calculateEvaluationStartByDate(
              merged.endDate, merged.costPerLicense, merged.quantity, _eltCfg,
            );
            writeData.cancelByDate = calculateCancelByDate(
              merged.endDate, merged.autoRenewal, merged.autoRenewalNoticeDays,
            );
            if (writeData.quantity != null && writeData.costPerLicense != null) {
              writeData.totalValue = parseFloat(writeData.costPerLicense) * parseInt(writeData.quantity);
            }
            await tx.contract.update({
              where: { id: existing.id },
              data:  writeData,
            });
            try {
              await applyCustomFieldsInTx(tx, req.user.accountId, existing.id, r._customFields);
            } catch (cfErr) {
              throw new Error(`Row ${rowNum}: ${cfErr.message}`);
            }
            txUpdated++;
            continue;
          }

          // Insert path (no dup, OR dup with 'create' strategy)
          const insertData: any = {
            ...writeData,
            archivedAt:            importArchived ? new Date() : null, // #10
            accountId:             req.user.accountId,
            vendorId:              vendor.id,
            // Audit Cluster A P2: product is a free-form text column too.
            product:               sanitizeFormulaPrefix(r.product),
            status:                writeData.status || 'active',
            autoRenewal:           writeData.autoRenewal === true,
            categoryId:            defaultCategoryId,
            evaluationStartByDate: calculateEvaluationStartByDate(
              writeData.endDate, writeData.costPerLicense, writeData.quantity, _eltCfg,
            ),
            cancelByDate: calculateCancelByDate(
              writeData.endDate, writeData.autoRenewal, writeData.autoRenewalNoticeDays,
            ),
            totalValue: (writeData.quantity != null && writeData.costPerLicense != null)
              ? parseFloat(writeData.costPerLicense) * parseInt(writeData.quantity)
              : null,
          };
          const newRow = await tx.contract.create({ data: insertData, select: { id: true } });
          try {
            await applyCustomFieldsInTx(tx, req.user.accountId, newRow.id, r._customFields);
          } catch (cfErr) {
            throw new Error(`Row ${rowNum}: ${cfErr.message}`);
          }
          txCreated++;
        }

        return { txCreated, txUpdated, txSkipped };
      }, { timeout: 60000 });
    } catch (txErr) {
      console.error('POST /api/contracts/import — transaction failed:', txErr);
      return res.status(500).json({ success: false, error: `Import failed: ${txErr.message}` });
    }

    created = txResult.txCreated;
    updated = txResult.txUpdated;
    skipped = txResult.txSkipped;
    const failed = errorRows.length;

    // Activity log — single row for the whole batch
    try {
      await prisma.activityLog.create({
        data: {
          contractId: null,
          userId:     req.user.id,
          action:     'bulk_contract_import',
          details:    {
            totalRows: rows.length,
            created, updated, skipped, failed,
            dedupeStrategy,
            createMissingVendors,
            newVendorsCount: createMissingVendors ? unknownVendors.length : 0,
          },
        },
      });
    } catch (logErr) {
      console.warn('bulk_contract_import activity log failed:', logErr.message);
    }

    // Build error CSV if needed (base64; client decodes for download)
    let errorCsv = null;
    if (errorRows.length > 0) {
      const errLines = errorRows.map(er => {
        const cells = headers.map(h => csvEscape(er.raw[h] ?? ''));
        const errs  = er.errors.map(e => `${e.field}: ${e.error}`).join('; ');
        cells.push(csvEscape(errs));
        return cells.join(',');
      });
      const csv = [[...headers, 'Errors'].join(','), ...errLines].join('\n');
      errorCsv = Buffer.from(csv, 'utf8').toString('base64');
    }

    return res.json({
      success: true,
      data: {
        step:    'commit',
        created, updated, skipped, failed,
        errorCsv,
        dedupeStrategy,
        createMissingVendors,
      },
    });
  } catch (err) {
    console.error('POST /api/contracts/import error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;

export {};
