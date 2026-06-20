'use strict';

/**
 * /api/work-orders/import -- bulk work-order history import from CSV or Excel.
 *
 * Primary use-case: migrating historical maintenance records from IBM Maximo,
 * SAP S/4HANA PM, or Oracle EAM so the EMP maintenance-history section is
 * populated immediately on go-live, rather than accumulating from scratch.
 *
 * Two endpoints:
 *
 *   POST /preview  -- multipart file= (csv|xlsx) + optional columnMap JSON.
 *                     Parses, detects asset matches by serial number, validates
 *                     rows, returns preview data. No writes.
 *
 *   POST /commit   -- multipart file= + columnMap + optional platform.
 *                     Creates WorkOrder rows (status COMPLETE, scheduleId null)
 *                     linked to matched assets. Rows with no asset match or
 *                     validation errors are collected and reported.
 *
 * Required columns: assetSerialNumber, completedDate.
 * Optional: scheduledDate, startedAt, status, notes, asFoundCondition,
 *           asLeftCondition, netaDecal, contractorName.
 *
 * Platform presets (auto-map known column names from each system's export):
 *   generic  -- sensible defaults
 *   maximo   -- ASSETNUM, ACTFINISH, ACTSTART, SCHEDSTART, STATUS, DESCRIPTION, VENDOR
 *   sap      -- Equipment, "Actual finish", "Actual start", "Basic start date",
 *               "User Status", "Short text", Vendor
 *   oracle   -- ASSET_NUMBER, ACTUAL_COMPLETION_DATE, ACTUAL_START_DATE,
 *               SCHEDULED_START_DATE, STATUS_CODE, DESCRIPTION
 *
 * Row cap: 1 000 rows / 10 MB (history imports are typically larger).
 * Manager+ only. Every row scoped to req.user.accountId.
 */

const router = require('express').Router();
const multer = require('multer');
const Papa   = require('papaparse');
const ExcelJS = require('exceljs');
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

const MAX_ROWS  = 1000;
const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only .csv or .xlsx files are accepted'), ok);
  },
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ success: false, error: err.message || 'Upload failed' });
  });
}

// ---- Cell helpers (identical to assetsImport pattern) -----------------------

function cellStr(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text || '').join('');
    if ('result' in v) return cellStr(v.result);
    return String(v);
  }
  return String(v);
}

async function parseFile(buffer, originalname) {
  if (/\.(xlsx|xls)$/i.test(originalname || '')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    let headers: any[] = [];
    const rows: any[] = [];
    ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
      const vals = row.values || [];
      if (rowNumber === 1) { headers = vals.slice(1).map((h: any) => cellStr(h).trim()); return; }
      const cells = vals.slice(1);
      if (cells.every((c: any) => c == null || cellStr(c) === '')) return;
      const obj: any = {};
      headers.forEach((h: string, i: number) => { if (h) obj[h] = cellStr(cells[i]); });
      rows.push(obj);
    });
    return { headers, rows };
  }
  const parsed = Papa.parse(buffer.toString('utf8'), { header: true, skipEmptyLines: true, trimHeaders: true });
  return { headers: parsed.meta.fields || [], rows: parsed.data || [] };
}

// ---- Status normalization ---------------------------------------------------
// Covers the three target platforms plus common generic values.

function normalizeStatus(raw: string): string | null {
  const s = String(raw || '').trim().toUpperCase().replace(/[-_\s]+/g, '');
  // Maximo: COMP, COMP-, CLOSE, HISTEQ, WCLOSE
  if (['COMP', 'COMP-', 'CLOSE', 'HISTEQ', 'WCLOSE', 'COMPLETE', 'COMPLETED', 'DONE', 'CLOSED', 'FINISHED'].includes(s)) return 'COMPLETE';
  // SAP: TECO (technically complete), CNF (confirmed), CLSD
  if (['TECO', 'CNF', 'CLSD', 'TECHNICALLYCOMPLETE'].includes(s)) return 'COMPLETE';
  // Oracle: COMPLETE already handled above
  // In-progress
  if (['INPRG', 'INPROG', 'INPROGRESS', 'REL', 'RELEASED', 'STARTED', 'ACTIVE'].includes(s)) return 'IN_PROGRESS';
  // Scheduled / open
  if (['WAPPR', 'WMATL', 'WPCOND', 'APPR', 'OPEN', 'SCHEDULED', 'PENDING', 'CRTD', 'CREATED', 'PLANNED'].includes(s)) return 'SCHEDULED';
  // Cancelled
  if (['CAN', 'CANC', 'CANCELLED', 'CANCELED'].includes(s)) return 'CANCELLED';
  return null;
}

// ---- Column mappings by platform -------------------------------------------

const PLATFORM_MAPPINGS: Record<string, Record<string, string>> = {
  generic: {
    'asset serial':          'assetSerialNumber',
    'asset serial number':   'assetSerialNumber',
    'serial':                'assetSerialNumber',
    'serial number':         'assetSerialNumber',
    'asset number':          'assetSerialNumber',
    'asset #':               'assetSerialNumber',
    'completed date':        'completedDate',
    'completion date':       'completedDate',
    'actual completion':     'completedDate',
    'date completed':        'completedDate',
    'scheduled date':        'scheduledDate',
    'schedule date':         'scheduledDate',
    'start date':            'startedAt',
    'actual start':          'startedAt',
    'status':                'status',
    'notes':                 'notes',
    'description':           'notes',
    'comments':              'notes',
    'as found':              'asFoundCondition',
    'as found condition':    'asFoundCondition',
    'as left':               'asLeftCondition',
    'as left condition':     'asLeftCondition',
    'neta decal':            'netaDecal',
    'decal':                 'netaDecal',
    'result':                'netaDecal',
    'contractor':            'contractorName',
    'vendor':                'contractorName',
    'service provider':      'contractorName',
  },
  maximo: {
    'assetnum':   'assetSerialNumber',
    'actfinish':  'completedDate',
    'actstart':   'startedAt',
    'schedstart': 'scheduledDate',
    'status':     'status',
    'description':'notes',
    'vendor':     'contractorName',
    'wonum':      'externalRef',
    'worktype':   '_worktype',
  },
  sap: {
    'equipment':          'assetSerialNumber',
    'actual finish':      'completedDate',
    'actual start':       'startedAt',
    'basic start date':   'scheduledDate',
    'user status':        'status',
    'short text':         'notes',
    'vendor':             'contractorName',
    'order':              'externalRef',
    'functional location':'_funcloc',
  },
  oracle: {
    'asset_number':              'assetSerialNumber',
    'actual_completion_date':    'completedDate',
    'actual_start_date':         'startedAt',
    'scheduled_start_date':      'scheduledDate',
    'status_code':               'status',
    'description':               'notes',
    'wo_number':                 'externalRef',
    'department':                '_dept',
  },
};

// All headers from all platforms merged for broad auto-detection
const HEADER_ALIAS_MAP: Record<string, string> = {};
for (const map of Object.values(PLATFORM_MAPPINGS)) {
  for (const [alias, field] of Object.entries(map)) {
    if (!field.startsWith('_') && !HEADER_ALIAS_MAP[alias]) HEADER_ALIAS_MAP[alias] = field;
  }
}

const SCHEMA_FIELDS = [
  { key: 'assetSerialNumber', label: 'Asset Serial Number (lookup)', required: true },
  { key: 'completedDate',     label: 'Completed Date',              required: true },
  { key: 'scheduledDate',     label: 'Scheduled Date',              required: false },
  { key: 'startedAt',         label: 'Started Date / Time',         required: false },
  { key: 'status',            label: 'Status',                      required: false },
  { key: 'notes',             label: 'Notes / Description',         required: false },
  { key: 'asFoundCondition',  label: 'As-Found Condition (C1/C2/C3)', required: false },
  { key: 'asLeftCondition',   label: 'As-Left Condition (C1/C2/C3)', required: false },
  { key: 'netaDecal',         label: 'NETA Decal (GREEN/YELLOW/RED)', required: false },
  { key: 'contractorName',    label: 'Contractor / Vendor',         required: false },
  { key: 'externalRef',       label: 'External WO Reference',       required: false },
];
const VALID_KEYS = new Set(SCHEMA_FIELDS.map(f => f.key));

function suggestMapping(headers: string[], platform = 'generic') {
  const map = PLATFORM_MAPPINGS[platform] || PLATFORM_MAPPINGS.generic;
  const m: Record<string, string | null> = {};
  for (const h of headers) {
    const k = h.trim().toLowerCase();
    m[h] = map[k] ?? HEADER_ALIAS_MAP[k] ?? null;
    // Drop internal fields
    if (m[h] && (m[h] as string).startsWith('_')) m[h] = null;
    if (m[h] && !VALID_KEYS.has(m[h] as string)) m[h] = null;
  }
  return m;
}

// ---- Date parser ------------------------------------------------------------

function parseDate(s: string): Date | Error {
  if (!s || s.trim() === '') return new Error('Empty date');
  const t = s.trim();
  // ISO / exceljs
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const d = new Date(t);
    if (!isNaN(d.getTime())) return d;
  }
  // m/d/yyyy or m-d-yyyy
  const mdyMatch = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (mdyMatch) {
    const d = new Date(`${mdyMatch[3]}-${mdyMatch[1].padStart(2,'0')}-${mdyMatch[2].padStart(2,'0')}`);
    if (!isNaN(d.getTime())) return d;
  }
  // SAP date format: DD.MM.YYYY
  const sapMatch = t.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (sapMatch) {
    const d = new Date(`${sapMatch[3]}-${sapMatch[2]}-${sapMatch[1]}`);
    if (!isNaN(d.getTime())) return d;
  }
  const fallback = new Date(t);
  if (!isNaN(fallback.getTime())) return fallback;
  return new Error(`Unrecognized date format: "${s}"`);
}

function parseCondition(s: string): string | Error {
  const v = s.trim().toUpperCase();
  if (['C1','C2','C3'].includes(v)) return v;
  if (v === '1' || v === 'GOOD') return 'C1';
  if (v === '2' || v === 'FAIR') return 'C2';
  if (v === '3' || v === 'POOR') return 'C3';
  return new Error(`Invalid condition: "${s}" (expected C1, C2, or C3)`);
}

function parseDecal(s: string): string | Error {
  const v = s.trim().toUpperCase();
  if (v === 'GREEN' || v === 'G' || v === 'SERVICEABLE' || v === 'PASS') return 'GREEN';
  if (v === 'YELLOW' || v === 'Y' || v === 'LIMITED' || v === 'LIMITED SERVICE') return 'YELLOW';
  if (v === 'RED' || v === 'R' || v === 'FAIL' || v === 'NON-SERVICEABLE') return 'RED';
  return new Error(`Invalid decal: "${s}" (expected GREEN, YELLOW, or RED)`);
}

function coerceField(key: string, raw: string) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  switch (key) {
    case 'completedDate':
    case 'scheduledDate':
    case 'startedAt':
      return parseDate(s);
    case 'asFoundCondition':
    case 'asLeftCondition':
      return parseCondition(s);
    case 'netaDecal':
      return parseDecal(s);
    case 'status': {
      const n = normalizeStatus(s);
      return n ?? s; // keep raw if unknown; preview will flag it
    }
    default:
      if (s.length > 2000) return new Error('Value too long (max 2000 chars)');
      return s;
  }
}

// ---- Shared preview/commit pipeline ----------------------------------------

async function prepare(req): Promise<any> {
  if (!req.file?.buffer) return { error: { status: 400, body: { success: false, error: 'No file uploaded' } } };

  let parsed;
  try { parsed = await parseFile(req.file.buffer, req.file.originalname); }
  catch (e: any) { return { error: { status: 400, body: { success: false, error: `Parse error: ${e.message}` } } }; }

  const { headers, rows } = parsed;
  if (!headers.length) return { error: { status: 400, body: { success: false, error: 'No header row found' } } };
  if (!rows.length)    return { error: { status: 400, body: { success: false, error: 'No data rows found' } } };
  if (rows.length > MAX_ROWS) return { error: { status: 400, body: { success: false, error: `Exceeds ${MAX_ROWS}-row cap (${rows.length} rows)` } } };

  const platform = String(req.body?.platform || 'generic').toLowerCase();
  let mapping: Record<string, string | null>;
  if (req.body?.columnMap) {
    try { mapping = JSON.parse(req.body.columnMap); }
    catch { return { error: { status: 400, body: { success: false, error: 'columnMap must be valid JSON' } } }; }
    for (const [h, f] of Object.entries<any>(mapping)) {
      if (f && (f.startsWith('_') || !VALID_KEYS.has(f))) mapping[h] = null;
    }
  } else {
    mapping = suggestMapping(headers, platform);
  }

  const targetFields = Object.values(mapping).filter(Boolean) as string[];
  if (!targetFields.includes('assetSerialNumber'))
    return { error: { status: 400, body: { success: false, error: 'Map a column to "Asset Serial Number" to continue.', data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };
  if (!targetFields.includes('completedDate'))
    return { error: { status: 400, body: { success: false, error: 'Map a column to "Completed Date" to continue.', data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };

  // Per-row normalize
  const normalizedRows: any[] = [];
  const validationErrors: any[] = [];
  const serialSet = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const data: any = {};
    const errs: any[] = [];
    for (const [header, fieldKey] of Object.entries<any>(mapping)) {
      if (!fieldKey) continue;
      const coerced = coerceField(fieldKey, r[header]);
      if (coerced instanceof Error) { errs.push({ field: fieldKey, error: coerced.message }); continue; }
      data[fieldKey] = coerced;
    }
    if (!data.assetSerialNumber) errs.push({ field: 'assetSerialNumber', error: 'Asset serial number is required' });
    else serialSet.add(String(data.assetSerialNumber).trim().toLowerCase());
    if (!data.completedDate)     errs.push({ field: 'completedDate',     error: 'Completed date is required' });
    // Default status to COMPLETE for history imports
    if (!data.status) data.status = 'COMPLETE';
    else if (!['COMPLETE','IN_PROGRESS','SCHEDULED','CANCELLED'].includes(data.status)) {
      errs.push({ field: 'status', error: `Unknown status "${data.status}" (expected COMPLETE, IN_PROGRESS, SCHEDULED, or CANCELLED)` });
    }
    normalizedRows.push(data);
    if (errs.length) validationErrors.push({ row: i + 2, errors: errs });
  }

  // Asset lookup by serial number
  const serials = [...serialSet];
  const assets = serials.length
    ? await prisma.asset.findMany({
        where:  { accountId: req.user.accountId, serialNumber: { in: serials.map(s => ({ equals: s, mode: 'insensitive' })) as any } },
        select: { id: true, serialNumber: true, equipmentType: true, manufacturer: true, model: true },
      })
    : [];
  // Prisma doesn't support in+insensitive directly; do a broader pull and filter
  const allAssets = await prisma.asset.findMany({
    where:  { accountId: req.user.accountId, serialNumber: { not: null } },
    select: { id: true, serialNumber: true, equipmentType: true, manufacturer: true, model: true },
  });
  const assetBySerial = new Map<string, any>();
  for (const a of allAssets) {
    if (a.serialNumber) assetBySerial.set(a.serialNumber.trim().toLowerCase(), a);
  }

  const unmatchedSerials: string[] = [];
  for (const s of serialSet) {
    if (!assetBySerial.has(s)) unmatchedSerials.push(s);
  }

  return { headers, rows, mapping, normalizedRows, validationErrors,
           errorRowSet: new Set(validationErrors.map((e: any) => e.row)),
           assetBySerial, unmatchedSerials, platform };
}

// ---- POST /preview ----------------------------------------------------------

// CWE-1236: strip leading spreadsheet-formula triggers so preview cells echoed
// back to the client can't become active formulas if pasted into Excel/
// LibreOffice. Mirrors the sibling deficiencies/schedules/assets import routes.
function sanitizeFormulaPrefix(s: string): string {
  if (!s) return s;
  return s.replace(/^[=+\-@\t\r\n]+/, '');
}

router.post('/preview', requireManager, handleUpload, async (req, res) => {
  try {
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);
    // Sanitize free-text cells in the preview sample before reflecting to client.
    const safeSample = ctx.rows.slice(0, 10).map((row: any) => {
      const safe: any = {};
      for (const [k, v] of Object.entries(row)) {
        safe[k] = typeof v === 'string' ? sanitizeFormulaPrefix(v) : v;
      }
      return safe;
    });
    return res.json({
      success: true,
      data: {
        step:             'preview',
        totalRows:        ctx.rows.length,
        headers:          ctx.headers,
        suggestedMapping: ctx.mapping,
        schemaFields:     SCHEMA_FIELDS,
        sampleRows:       safeSample,
        validationErrors: ctx.validationErrors,
        unmatchedSerials: ctx.unmatchedSerials,
        matchedCount:     ctx.rows.length - ctx.validationErrors.length - ctx.unmatchedSerials.length,
        platform:         ctx.platform,
        maxRows:          MAX_ROWS,
      },
    });
  } catch (err) {
    console.error('WO import preview error:', err);
    return res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

// ---- POST /commit ------------------------------------------------------------

router.post('/commit', requireManager, handleUpload, async (req, res) => {
  try {
    if (!req.body?.columnMap) return res.status(400).json({ success: false, error: 'columnMap required' });
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    const { normalizedRows, validationErrors, errorRowSet, assetBySerial } = ctx;
    const accountId = req.user.accountId;
    const errorRows: any[] = [];
    const skippedRows: any[] = [];
    let created = 0;

    const txResult = await prisma.$transaction(async (tx: any) => {
      for (let i = 0; i < normalizedRows.length; i++) {
        const rowNum = i + 2;
        if (errorRowSet.has(rowNum)) {
          const ve = validationErrors.find((e: any) => e.row === rowNum);
          errorRows.push({ row: rowNum, errors: ve?.errors || [{ error: 'Validation failed' }] });
          continue;
        }
        const r = normalizedRows[i];
        const serial = String(r.assetSerialNumber || '').trim().toLowerCase();
        const asset = assetBySerial.get(serial);
        if (!asset) {
          skippedRows.push({ row: rowNum, serialNumber: r.assetSerialNumber, reason: 'No asset found with this serial number' });
          continue;
        }
        // Append externalRef to notes for traceability
        let notes = r.notes || null;
        if (r.externalRef) notes = notes ? `[Ref: ${r.externalRef}] ${notes}` : `[Ref: ${r.externalRef}]`;

        await tx.workOrder.create({
          data: {
            accountId,
            assetId:          asset.id,
            scheduleId:       null,
            status:           r.status as any,
            scheduledDate:    r.scheduledDate || null,
            startedAt:        r.startedAt || null,
            completedDate:    r.completedDate,
            asFoundCondition: r.asFoundCondition as any || null,
            asLeftCondition:  r.asLeftCondition as any || null,
            netaDecal:        r.netaDecal as any || null,
            notes,
          },
          select: { id: true },
        });
        created++;
      }
      return { created };
    }, { timeout: 60000 });

    return res.json({
      success: true,
      data: {
        step: 'commit',
        created:  txResult.created,
        skipped:  skippedRows.length,
        failed:   errorRows.length,
        skippedRows,
        errors:   errorRows,
      },
    });
  } catch (err) {
    console.error('WO import commit error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;
export {};
