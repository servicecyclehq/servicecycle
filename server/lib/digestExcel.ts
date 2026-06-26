/**
 * digestExcel.ts  builds the monthly-digest Excel attachment as a Buffer
 * (for Brevo email attach), not an HTTP stream like lib/xlsxExport.ts.
 *
 * The Rep column is on EVERY row on purpose: it lets the sales manager open
 * one workbook and filter "what is Sarah working on this month" across the
 * whole book. The rep email attaches the same builder filtered to one rep.
 *
 * Row shape (DigestRow) is assembled by lib/monthlyDigest.ts so the math
 * (rate resolution, day buckets, trend) lives in one place.
 */

const ExcelJS = require('exceljs');

// Locale helpers — default to en-US/USD; override via env vars for non-US customers.
const DEFAULT_LOCALE   = process.env.DEFAULT_LOCALE   || 'en-US';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';

function fmtNumber(n: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE).format(n);
}
function fmtCurrency(n: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: DEFAULT_CURRENCY, maximumFractionDigits: 0 }).format(n);
}

export interface DigestRow {
  rep: string;
  company: string;
  site: string;
  equipment: string;       // "Transformer  Square D / EZ-9"
  serviceNeeded: string;   // task name
  dueDate: Date | null;    // nextDueDate
  status: string;          // "12d overdue" | "due in 30d"
  condition: string;       // C1 | C2 | C3
  priorityScore: number | null; // DPS 125
  trend: string;           // " worsening" | ""
  estMinDollars: number | null;
  estMaxDollars: number | null;
  rulPct: number | null;   // modernizationRiskScore  100
  ageYears: number | null;
  autoC3: boolean;
}

const COLUMNS: Array<{ header: string; key: keyof DigestRow | 'estValue'; width: number; type?: string }> = [
  { header: 'Rep',            key: 'rep',           width: 20 },
  { header: 'Company',        key: 'company',       width: 26 },
  { header: 'Site',           key: 'site',          width: 22 },
  { header: 'Equipment',      key: 'equipment',     width: 30 },
  { header: 'Service needed', key: 'serviceNeeded', width: 28 },
  { header: 'Est. due date',  key: 'dueDate',       width: 14, type: 'date' },
  { header: 'Status',         key: 'status',        width: 14 },
  { header: 'Condition',      key: 'condition',     width: 11 },
  { header: 'Priority',       key: 'priorityScore', width: 10, type: 'number' },
  { header: ' Trend',        key: 'trend',         width: 16 },
  { header: 'Est. value $',   key: 'estValue',      width: 20 },
  { header: 'RUL %',          key: 'rulPct',        width: 10, type: 'number' },
  { header: 'Age (yrs)',      key: 'ageYears',      width: 11, type: 'number' },
  { header: 'Auto-C3',        key: 'autoC3',        width: 10 },
];

function estValueText(r: DigestRow): string {
  if (r.estMinDollars == null && r.estMaxDollars == null) return '';
  const min = r.estMinDollars ?? r.estMaxDollars ?? 0;
  const max = r.estMaxDollars ?? r.estMinDollars ?? 0;
  if (min === max) return fmtCurrency(min);
  return `${fmtCurrency(min)}  ${fmtCurrency(max)}`;
}

/**
 * Build the workbook as a Buffer. `title` becomes a frozen header banner row.
 */
export async function buildDigestXlsxBuffer(
  rows: DigestRow[],
  { title = 'ServiceCycle  Monthly Service Digest' }: { title?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ServiceCycle';
  wb.created = new Date();
  const ws = wb.addWorksheet('Service Digest');

  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

  for (const r of rows) {
    const rowObj: any = {};
    for (const c of COLUMNS) {
      if (c.key === 'estValue') { rowObj.estValue = estValueText(r); continue; }
      const raw = (r as any)[c.key];
      if (c.type === 'date') rowObj[c.key] = raw instanceof Date ? raw : (raw ? new Date(raw) : null);
      else if (c.type === 'number') rowObj[c.key] = (raw == null || raw === '') ? null : Number(raw);
      else if (c.key === 'autoC3') rowObj[c.key] = raw ? 'Yes' : '';
      else rowObj[c.key] = raw == null ? '' : String(raw);
    }
    const row = ws.addRow(rowObj);
    COLUMNS.forEach((c, idx) => {
      if (c.type === 'date') row.getCell(idx + 1).numFmt = 'yyyy-mm-dd';
      else if (c.type === 'number') row.getCell(idx + 1).numFmt = '#,##0';
    });
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ── Customer-facing workbook ────────────────────────────────────────────────
// Value-framed: the facility's own maintenance list. STRIPS every sales/internal
// column (no dollars, no priority-to-sell, no RUL, no auto-C3) — just what needs
// doing and when. Mirrors the customer email's "things to do", in spreadsheet form.
const CUSTOMER_COLUMNS: Array<{ header: string; key: string; width: number; type?: string }> = [
  { header: 'Site',           key: 'site',          width: 22 },
  { header: 'Equipment',      key: 'equipment',     width: 30 },
  { header: 'Service needed', key: 'serviceNeeded', width: 28 },
  { header: 'Due date',       key: 'dueDate',       width: 14, type: 'date' },
  { header: 'Status',         key: 'status',        width: 16 },
  { header: 'Condition',      key: 'condition',     width: 11 },
  { header: 'Trend',          key: 'trend',         width: 14 },
];

export async function buildCustomerXlsxBuffer(
  rows: DigestRow[],
  { title = 'ServiceCycle - Maintenance Summary' }: { title?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ServiceCycle';
  wb.created = new Date();
  const ws = wb.addWorksheet('Maintenance');

  ws.columns = CUSTOMER_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

  for (const r of rows) {
    const rowObj: any = {
      site: r.site || '',
      equipment: r.equipment || '',
      serviceNeeded: r.serviceNeeded || '',
      dueDate: r.dueDate instanceof Date ? r.dueDate : (r.dueDate ? new Date(r.dueDate) : null),
      status: r.status || '',
      condition: r.condition || '',
      trend: (r.trend && String(r.trend).trim()) ? 'Worsening' : '',
    };
    const row = ws.addRow(rowObj);
    row.getCell(4).numFmt = 'yyyy-mm-dd';
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: CUSTOMER_COLUMNS.length } };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildDigestXlsxBuffer, buildCustomerXlsxBuffer };
export {};
