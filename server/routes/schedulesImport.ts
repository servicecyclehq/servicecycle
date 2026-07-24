'use strict';

/**
 * /api/schedules/import -- bulk maintenance schedule history import.
 *
 * Purpose: when a customer migrates from Maximo/SAP/Oracle, their PM schedules
 * have real last-completion dates. This route writes those dates into the
 * matching MaintenanceSchedule rows so nextDueDate is computed correctly from
 * day 1 rather than being null (which would trigger false "never serviced" alerts).
 *
 * This route UPDATES existing schedules -- it does NOT create new ones.
 * New schedules come from bulk-apply (/api/schedules/bulk-apply) or the
 * asset import's autoApplySchedules flag.
 *
 * Matching logic (per row):
 *   1. Find asset by serialNumber (case-insensitive).
 *   2. Find MaintenanceSchedule by (assetId, taskCode) -- exact taskCode match
 *      on MaintenanceTaskDefinition.taskCode (e.g. "XFMR_DGA").
 *   3. Fallback: case-insensitive contains match on taskDefinition.taskName.
 *   4. If matched: set lastCompletedDate. If nextDueDate is provided, use it;
 *      otherwise leave null (the alert engine recomputes on next sweep).
 *
 * Platform column name presets:
 *   maximo  -- ASSETNUM, LASTCOMPDATE, NEXTDATE, PMNUM/DESCRIPTION
 *   sap     -- Equipment, "Last Called", "Next Planned", "Maintenance Item"/"Item Description"
 *   oracle  -- ASSET_NUMBER, LAST_COMPLETION_DATE, NEXT_DUE_DATE, ACTIVITY/ACTIVITY_DESCRIPTION
 */

const router = require('express').Router();
const multer = require('multer');
const Papa   = require('papaparse');
const ExcelJS = require('exceljs');
const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const prisma = require('../lib/prisma').default;

const MAX_ROWS  = 2000;
const MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req: any, file: any, cb: any) => {
    const ok = /\.(csv|xlsx|xls)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only .csv or .xlsx files are accepted'), ok);
  },
});

function handleUpload(req: any, res: any, next: any) {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, error: err.message });
  });
}

function cellStr(v: any): string {
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

/**
 * CWE-1236 formula-injection guard.
 * Strips leading formula-trigger characters from free-text values so that
 * preview sampleRows reflected back to the client cannot become spreadsheet
 * formulas if the user pastes them into Excel/LibreOffice.
 * Characters: = + - @ (and tab/newline variants per OWASP CSV spec).
 */
function sanitizeFormulaPrefix(s: string): string {
  if (!s) return s;
  return s.replace(/^[=+\-@\t\r\n]+/, '');
}

async function parseFile(buffer: Buffer, originalname: string) {
  if (/\.(xlsx|xls)$/i.test(originalname || '')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [] as string[], rows: [] as any[] };
    let headers: string[] = [];
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
  return { headers: parsed.meta.fields as string[] || [], rows: parsed.data as any[] || [] };
}

// ---- Column mappings -------------------------------------------------------

const PLATFORM_MAPPINGS: Record<string, Record<string, string>> = {
  generic: {
    'asset serial':          'assetSerialNumber',
    'asset serial number':   'assetSerialNumber',
    'serial number':         'assetSerialNumber',
    'serial':                'assetSerialNumber',
    'asset number':          'assetSerialNumber',
    'task code':             'taskCode',
    'task':                  'taskCode',
    'pm code':               'taskCode',
    'activity code':         'taskCode',
    'task name':             'taskDescription',
    'task description':      'taskDescription',
    'activity description':  'taskDescription',
    'description':           'taskDescription',
    'last completed':        'lastCompletedDate',
    'last completion date':  'lastCompletedDate',
    'last completed date':   'lastCompletedDate',
    'date last completed':   'lastCompletedDate',
    'next due':              'nextDueDate',
    'next due date':         'nextDueDate',
    'next scheduled date':   'nextDueDate',
    'next date':             'nextDueDate',
  },
  maximo: {
    'assetnum':    'assetSerialNumber',
    'lastcompdate':'lastCompletedDate',
    'nextdate':    'nextDueDate',
    'pmnum':       'taskCode',
    'description': 'taskDescription',
  },
  sap: {
    'equipment':         'assetSerialNumber',
    'last called':       'lastCompletedDate',
    'next planned':      'nextDueDate',
    'maintenance item':  'taskCode',
    'item description':  'taskDescription',
    'maintenance plan':  '_plan',
  },
  oracle: {
    'asset_number':           'assetSerialNumber',
    'last_completion_date':   'lastCompletedDate',
    'next_due_date':          'nextDueDate',
    'activity':               'taskCode',
    'activity_description':   'taskDescription',
    'department':             '_dept',
  },
};

const HEADER_ALIAS_MAP: Record<string, string> = {};
for (const map of Object.values(PLATFORM_MAPPINGS)) {
  for (const [alias, field] of Object.entries(map)) {
    if (!field.startsWith('_') && !HEADER_ALIAS_MAP[alias]) HEADER_ALIAS_MAP[alias] = field;
  }
}

const SCHEMA_FIELDS = [
  { key: 'assetSerialNumber', label: 'Asset Serial Number (lookup)', required: true },
  { key: 'lastCompletedDate', label: 'Last Completed Date',          required: true },
  { key: 'taskCode',          label: 'Task Code (e.g. XFMR_DGA)',    required: false },
  { key: 'taskDescription',   label: 'Task Name / Description',      required: false },
  { key: 'nextDueDate',       label: 'Next Due Date (optional override)', required: false },
];
const VALID_KEYS = new Set(SCHEMA_FIELDS.map(f => f.key));

function suggestMapping(headers: string[], platform = 'generic') {
  const map = PLATFORM_MAPPINGS[platform] || PLATFORM_MAPPINGS.generic;
  const m: Record<string, string | null> = {};
  for (const h of headers) {
    const k = h.trim().toLowerCase();
    const field = map[k] ?? HEADER_ALIAS_MAP[k] ?? null;
    m[h] = (field && !field.startsWith('_') && VALID_KEYS.has(field)) ? field : null;
  }
  return m;
}

function parseDate(s: string): Date | Error {
  const t = (s || '').trim();
  if (!t) return new Error('Empty date');
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const d = new Date(t); if (!isNaN(d.getTime())) return d; }
  const mdy = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (mdy) { const d = new Date(`${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`); if (!isNaN(d.getTime())) return d; }
  const sap = t.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (sap) { const d = new Date(`${sap[3]}-${sap[2]}-${sap[1]}`); if (!isNaN(d.getTime())) return d; }
  const fb = new Date(t);
  if (!isNaN(fb.getTime())) return fb;
  return new Error(`Unrecognized date: "${s}"`);
}

function coerceField(key: string, raw: string) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (key === 'lastCompletedDate' || key === 'nextDueDate') return parseDate(s);
  if (s.length > 500) return new Error('Value too long (max 500 chars)');
  return s;
}

// ---- Shared pipeline -------------------------------------------------------

async function prepare(req: any): Promise<any> {
  if (!req.file?.buffer) return { error: { status: 400, body: { success: false, error: 'No file uploaded' } } };
  let parsed: any;
  try { parsed = await parseFile(req.file.buffer, req.file.originalname); }
  catch (e: any) { return { error: { status: 400, body: { success: false, error: `Parse error: ${e.message}` } } }; }

  const { headers, rows } = parsed;
  if (!headers.length) return { error: { status: 400, body: { success: false, error: 'No header row' } } };
  if (!rows.length)    return { error: { status: 400, body: { success: false, error: 'No data rows' } } };
  if (rows.length > MAX_ROWS) return { error: { status: 400, body: { success: false, error: `Exceeds ${MAX_ROWS}-row cap` } } };

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
    return { error: { status: 400, body: { success: false, error: 'Map a column to "Asset Serial Number".', data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };
  if (!targetFields.includes('lastCompletedDate'))
    return { error: { status: 400, body: { success: false, error: 'Map a column to "Last Completed Date".', data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };
  if (!targetFields.includes('taskCode') && !targetFields.includes('taskDescription'))
    return { error: { status: 400, body: { success: false, error: 'Map a column to either "Task Code" or "Task Name / Description" to match schedules.', data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };

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
    if (!data.assetSerialNumber) errs.push({ field: 'assetSerialNumber', error: 'Required' });
    else serialSet.add(String(data.assetSerialNumber).trim().toLowerCase());
    if (!data.lastCompletedDate) errs.push({ field: 'lastCompletedDate', error: 'Required' });
    normalizedRows.push(data);
    if (errs.length) validationErrors.push({ row: i + 2, errors: errs });
  }

  // Load assets
  const allAssets = await prisma.asset.findMany({
    where:  { accountId: req.user.accountId, serialNumber: { not: null } },
    select: { id: true, serialNumber: true, equipmentType: true },
  });
  const assetBySerial = new Map<string, any>();
  for (const a of allAssets) {
    if (a.serialNumber) assetBySerial.set(a.serialNumber.trim().toLowerCase(), a);
  }

  // Load all schedule rows for this account (with task definition codes/names)
  const schedules = await prisma.maintenanceSchedule.findMany({
    where:  { accountId: req.user.accountId },
    select: {
      id: true, assetId: true,
      taskDefinition: { select: { taskCode: true, taskName: true, equipmentType: true } },
    },
  });
  // Index: assetId -> [{ scheduleId, taskCode, taskName }]
  const schedByAsset = new Map<string, any[]>();
  for (const s of schedules) {
    if (!schedByAsset.has(s.assetId)) schedByAsset.set(s.assetId, []);
    schedByAsset.get(s.assetId)!.push({
      id:       s.id,
      taskCode: s.taskDefinition.taskCode.toUpperCase(),
      taskName: s.taskDefinition.taskName.toLowerCase(),
    });
  }

  const unmatchedSerials: string[] = [];
  for (const s of serialSet) {
    if (!assetBySerial.has(s)) unmatchedSerials.push(s);
  }

  return { headers, rows, mapping, normalizedRows, validationErrors,
           errorRowSet: new Set(validationErrors.map((e: any) => e.row)),
           assetBySerial, schedByAsset, unmatchedSerials, platform };
}

// ---- Schedule matcher ------------------------------------------------------
// Returns scheduleId or null.

function findSchedule(schedByAsset: Map<string, any[]>, assetId: string, taskCode?: string, taskDescription?: string): string | null {
  const list = schedByAsset.get(assetId);
  if (!list || !list.length) return null;
  // 1. Exact task code match (normalized uppercase, strip spaces/dashes)
  if (taskCode) {
    const norm = taskCode.trim().toUpperCase().replace(/[\s\-_]+/g, '_');
    const exact = list.find(s => s.taskCode === norm);
    if (exact) return exact.id;
  }
  // 2. Task description contains-match (case-insensitive)
  if (taskDescription) {
    const needle = taskDescription.trim().toLowerCase();
    // Try: every significant word in the description appears in the task name
    const words = needle.split(/\s+/).filter(w => w.length > 3);
    const byDesc = list.find(s => words.length > 0 && words.every(w => s.taskName.includes(w)));
    if (byDesc) return byDesc.id;
    // Softer: task name contains the first meaningful word
    const byFirst = words.length > 0 && list.find(s => s.taskName.includes(words[0]));
    if (byFirst) return byFirst.id;
  }
  return null;
}

// ---- Routes ----------------------------------------------------------------

router.post('/preview', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    // Count how many rows would successfully match a schedule
    const { normalizedRows, errorRowSet, assetBySerial, schedByAsset } = ctx;
    let matchedCount = 0, noAsset = 0, noSchedule = 0;
    for (let i = 0; i < normalizedRows.length; i++) {
      const rowNum = i + 2;
      if (errorRowSet.has(rowNum)) continue;
      const r = normalizedRows[i];
      const asset = assetBySerial.get(String(r.assetSerialNumber || '').trim().toLowerCase());
      if (!asset) { noAsset++; continue; }
      const schedId = findSchedule(schedByAsset, asset.id, r.taskCode, r.taskDescription);
      if (!schedId) { noSchedule++; continue; }
      matchedCount++;
    }

    // CWE-1236: sanitize free-text cells in the preview sample before reflecting to client.
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
        step: 'preview', totalRows: ctx.rows.length,
        headers: ctx.headers, suggestedMapping: ctx.mapping, schemaFields: SCHEMA_FIELDS,
        sampleRows: safeSample, validationErrors: ctx.validationErrors,
        unmatchedSerials: ctx.unmatchedSerials,
        matchedCount, noAsset, noSchedule,
        platform: ctx.platform, maxRows: MAX_ROWS,
      },
    });
  } catch (err) {
    console.error('Schedule import preview error:', err);
    return res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

router.post('/commit', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    if (!req.body?.columnMap) return res.status(400).json({ success: false, error: 'columnMap required' });
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    const { normalizedRows, validationErrors, errorRowSet, assetBySerial, schedByAsset } = ctx;
    const errorRows: any[] = [];
    const skippedRows: any[] = [];
    let updated = 0;

    await prisma.$transaction(async (tx: any) => {
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
          skippedRows.push({ row: rowNum, serialNumber: r.assetSerialNumber, reason: 'No asset with this serial number' });
          continue;
        }
        const schedId = findSchedule(schedByAsset, asset.id, r.taskCode, r.taskDescription);
        if (!schedId) {
          const hint = r.taskCode || r.taskDescription || '(no task identifier provided)';
          skippedRows.push({ row: rowNum, serialNumber: r.assetSerialNumber, reason: `No matching schedule found for task: ${hint}` });
          continue;
        }
        await tx.maintenanceSchedule.update({
          where: { id: schedId },
          data:  {
            lastCompletedDate: r.lastCompletedDate,
            nextDueDate:       r.nextDueDate || null,
          },
        });
        updated++;
      }
    }, { timeout: 60000 });

    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'schedules_import_committed',
      details: { updated, skipped: skippedRows.length, failed: errorRows.length },
    });

    return res.json({
      success: true,
      data: { step: 'commit', updated, skipped: skippedRows.length, failed: errorRows.length, skippedRows, errors: errorRows },
    });
  } catch (err) {
    console.error('Schedule import commit error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;
export {};
