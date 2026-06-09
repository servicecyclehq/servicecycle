'use strict';

/**
 * /api/deficiencies/import -- bulk deficiency/finding import from CSV or Excel.
 *
 * Covers inspection findings from IBM Maximo (FAILURELIST / PROBLEM records),
 * SAP S/4HANA PM (PM Notifications, IW28 export), and Oracle EAM
 * (Work Requests / Service Requests), plus generic CSV.
 *
 * Two endpoints:
 *
 *   POST /preview  -- parse + validate + asset-match. No writes.
 *   POST /commit   -- create Deficiency rows linked to matched assets.
 *                     Rows with no asset match or errors are skipped/reported.
 *
 * Required columns: assetSerialNumber, severity, description.
 * Optional: correctiveAction, resolvedAt.
 *
 * Severity mappings per platform:
 *   Maximo  PROBLEMCODE: CRITICAL/URGENT/P1 -> IMMEDIATE; MAJOR/P2 -> RECOMMENDED; MINOR/P3 -> ADVISORY
 *   SAP     Notification Type: M2/DL/PM -> IMMEDIATE; M1/S1 -> RECOMMENDED; S2/PM-MONITOR -> ADVISORY
 *   Oracle  PRIORITY_CODE: 1/EMERGENCY/CRITICAL -> IMMEDIATE; 2/HIGH -> RECOMMENDED; 3/MEDIUM/LOW -> ADVISORY
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

// ---- Severity normalization -------------------------------------------------

function normalizeSeverity(raw: string): string | null {
  const s = String(raw || '').trim().toUpperCase().replace(/[-_\s]+/g, '');
  // IMMEDIATE -- safety/operation risk
  if (['IMMEDIATE','CRITICAL','URGENT','EMERGENCY','P1','1','M2','DL','HIGH'].includes(s)) return 'IMMEDIATE';
  // RECOMMENDED -- correct at next opportunity
  if (['RECOMMENDED','MAJOR','IMPORTANT','P2','2','M1','S1','MEDIUM'].includes(s)) return 'RECOMMENDED';
  // ADVISORY -- monitor
  if (['ADVISORY','MINOR','LOW','P3','3','S2','PMMONITOR','INFORMATIONAL','MONITOR'].includes(s)) return 'ADVISORY';
  return null;
}

// ---- Column mappings -------------------------------------------------------

const PLATFORM_MAPPINGS: Record<string, Record<string, string>> = {
  generic: {
    'asset serial':           'assetSerialNumber',
    'asset serial number':    'assetSerialNumber',
    'serial number':          'assetSerialNumber',
    'serial':                 'assetSerialNumber',
    'asset number':           'assetSerialNumber',
    'severity':               'severity',
    'priority':               'severity',
    'classification':         'severity',
    'description':            'description',
    'finding':                'description',
    'deficiency':             'description',
    'corrective action':      'correctiveAction',
    'recommended action':     'correctiveAction',
    'remedy':                 'correctiveAction',
    'resolution':             'correctiveAction',
    'resolved date':          'resolvedAt',
    'resolution date':        'resolvedAt',
    'date resolved':          'resolvedAt',
    'completion date':        'resolvedAt',
  },
  maximo: {
    'assetnum':   'assetSerialNumber',
    'description':'description',
    'problemcode':'severity',
    'remedy':     'correctiveAction',
    'faildate':   '_faildate',
    'wonum':      'externalRef',
  },
  sap: {
    'equipment':        'assetSerialNumber',
    'short text':       'description',
    'long text':        'correctiveAction',
    'notification type':'severity',
    'completion date':  'resolvedAt',
    'notification':     'externalRef',
    'malfunction start':'_faildate',
  },
  oracle: {
    'asset_number':        'assetSerialNumber',
    'description':         'description',
    'priority_code':       'severity',
    'resolution_summary':  'correctiveAction',
    'resolution_date':     'resolvedAt',
    'request_number':      'externalRef',
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
  { key: 'severity',          label: 'Severity (IMMEDIATE / RECOMMENDED / ADVISORY)', required: true },
  { key: 'description',       label: 'Description / Finding',        required: true },
  { key: 'correctiveAction',  label: 'Corrective Action / Remedy',   required: false },
  { key: 'resolvedAt',        label: 'Resolution Date (if resolved)', required: false },
  { key: 'externalRef',       label: 'External Reference',           required: false },
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
  if (key === 'resolvedAt') return parseDate(s);
  if (key === 'severity') {
    const n = normalizeSeverity(s);
    return n ?? new Error(`Unknown severity "${s}" (expected IMMEDIATE, RECOMMENDED, or ADVISORY; or platform codes like P1/P2/P3, M1/M2, 1/2/3)`);
  }
  if (s.length > 5000) return new Error('Value too long (max 5000 chars)');
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
  for (const req_field of ['assetSerialNumber','severity','description']) {
    if (!targetFields.includes(req_field)) {
      const label = SCHEMA_FIELDS.find(f => f.key === req_field)?.label || req_field;
      return { error: { status: 400, body: { success: false, error: `Map a column to "${label}" to continue.`, data: { headers, suggestedMapping: mapping, schemaFields: SCHEMA_FIELDS } } } };
    }
  }

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
    if (!data.severity)          errs.push({ field: 'severity',          error: 'Required' });
    if (!data.description)       errs.push({ field: 'description',       error: 'Required' });
    normalizedRows.push(data);
    if (errs.length) validationErrors.push({ row: i + 2, errors: errs });
  }

  const allAssets = await prisma.asset.findMany({
    where:  { accountId: req.user.accountId, serialNumber: { not: null } },
    select: { id: true, serialNumber: true, equipmentType: true },
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

// ---- Routes ----------------------------------------------------------------

router.post('/preview', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);
    return res.json({
      success: true,
      data: {
        step: 'preview', totalRows: ctx.rows.length,
        headers: ctx.headers, suggestedMapping: ctx.mapping, schemaFields: SCHEMA_FIELDS,
        sampleRows: ctx.rows.slice(0, 10), validationErrors: ctx.validationErrors,
        unmatchedSerials: ctx.unmatchedSerials, platform: ctx.platform, maxRows: MAX_ROWS,
      },
    });
  } catch (err) {
    console.error('Deficiency import preview error:', err);
    return res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

router.post('/commit', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    if (!req.body?.columnMap) return res.status(400).json({ success: false, error: 'columnMap required' });
    const ctx = await prepare(req);
    if (ctx.error) return res.status(ctx.error.status).json(ctx.error.body);

    const { normalizedRows, validationErrors, errorRowSet, assetBySerial } = ctx;
    const accountId = req.user.accountId;
    const errorRows: any[] = [];
    const skippedRows: any[] = [];
    let created = 0;

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
        let description = String(r.description || '').slice(0, 5000);
        if (r.externalRef) description = `[Ref: ${r.externalRef}] ${description}`;
        await tx.deficiency.create({
          data: {
            accountId,
            assetId:          asset.id,
            workOrderId:      null,
            severity:         r.severity as any,
            description,
            correctiveAction: r.correctiveAction || null,
            resolvedAt:       r.resolvedAt || null,
          },
          select: { id: true },
        });
        created++;
      }
    }, { timeout: 60000 });

    return res.json({
      success: true,
      data: { step: 'commit', created, skipped: skippedRows.length, failed: errorRows.length, skippedRows, errors: errorRows },
    });
  } catch (err) {
    console.error('Deficiency import commit error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;
export {};
