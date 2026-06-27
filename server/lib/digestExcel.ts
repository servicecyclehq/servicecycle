/**
 * digestExcel.ts — builds the monthly-digest Excel attachment as a Buffer
 * (for Brevo email attach), not an HTTP stream like lib/xlsxExport.ts.
 *
 * The Rep column is on EVERY row on purpose: it lets the sales manager open
 * one workbook and filter "what is Sarah working on this month" across the
 * whole book. The rep email attaches the same builder filtered to one rep.
 *
 * Row shape (DigestRow) is assembled by lib/monthlyDigest.ts so the math
 * (rate resolution, day buckets, trend) lives in one place. Styling is the
 * shared canonical look (lib/xlsxStyle) + a filter on the header row.
 */

const ExcelJS = require('exceljs');
const { applyReportSheet, brandWorkbook } = require('./xlsxStyle');

// Locale helpers — default to en-US/USD; override via env vars for non-US customers.
const DEFAULT_LOCALE   = process.env.DEFAULT_LOCALE   || 'en-US';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: DEFAULT_CURRENCY, maximumFractionDigits: 0 }).format(n);
}

const condChip = (v: any) => (v === 'C1' ? 'good' : v === 'C2' ? 'warn' : v === 'C3' ? 'bad' : null);
const today = () => new Date().toISOString().slice(0, 10);
const countLabel = (n: number) => `${n} item${n === 1 ? '' : 's'}`;

export interface DigestRow {
  rep: string;
  company: string;
  site: string;
  equipment: string;       // "Transformer — Square D / EZ-9"
  serviceNeeded: string;   // task name
  dueDate: Date | null;    // nextDueDate
  status: string;          // "12d overdue" | "due in 30d"
  condition: string;       // C1 | C2 | C3
  priorityScore: number | null; // DPS 1-25
  trend: string;           // "worsening" | ""
  estMinDollars: number | null;
  estMaxDollars: number | null;
  rulPct: number | null;   // modernizationRiskScore × 100
  ageYears: number | null;
  autoC3: boolean;
}

function estValueText(r: DigestRow): string {
  if (r.estMinDollars == null && r.estMaxDollars == null) return '';
  const min = r.estMinDollars ?? r.estMaxDollars ?? 0;
  const max = r.estMaxDollars ?? r.estMinDollars ?? 0;
  if (min === max) return fmtCurrency(min);
  return `${fmtCurrency(min)} – ${fmtCurrency(max)}`;
}

// Internal sales digest — every column, filterable by rep.
export async function buildDigestXlsxBuffer(
  rows: DigestRow[],
  { title = 'Monthly Service Digest' }: { title?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);
  const ws = wb.addWorksheet('Service Digest');

  const columns = [
    { header: 'Rep', key: 'rep' },
    { header: 'Company', key: 'company' },
    { header: 'Site', key: 'site' },
    { header: 'Equipment', key: 'equipment' },
    { header: 'Service Needed', key: 'serviceNeeded' },
    { header: 'Est. Due Date', key: 'dueDate', type: 'date' },
    { header: 'Status', key: 'status' },
    { header: 'Condition', key: 'condition', chip: condChip },
    { header: 'Priority', key: 'priorityScore', type: 'number' },
    { header: 'Trend', key: 'trend' },
    { header: 'Est. Value', key: 'estValue' },
    { header: 'RUL %', key: 'rulPct', type: 'number' },
    { header: 'Age (yrs)', key: 'ageYears', type: 'number' },
    { header: 'Auto-C3', key: 'autoC3' },
  ];
  const data = rows.map((r) => ({
    rep: r.rep, company: r.company, site: r.site, equipment: r.equipment,
    serviceNeeded: r.serviceNeeded, dueDate: r.dueDate, status: r.status,
    condition: r.condition, priorityScore: r.priorityScore, trend: r.trend,
    estValue: estValueText(r), rulPct: r.rulPct, ageYears: r.ageYears,
    autoC3: r.autoC3 ? 'Yes' : '',
  }));

  applyReportSheet(ws, {
    title,
    subtitle: `All reps · ${countLabel(data.length)} · Generated ${today()}`,
    columns,
    rows: data,
    autoFilter: true,
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// Customer-facing workbook — value-framed maintenance list. STRIPS every
// sales/internal column (no dollars, no priority-to-sell, no RUL, no auto-C3).
export async function buildCustomerXlsxBuffer(
  rows: DigestRow[],
  { title = 'Maintenance Summary' }: { title?: string } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);
  const ws = wb.addWorksheet('Maintenance');

  const columns = [
    { header: 'Site', key: 'site' },
    { header: 'Equipment', key: 'equipment' },
    { header: 'Service Needed', key: 'serviceNeeded' },
    { header: 'Due Date', key: 'dueDate', type: 'date' },
    { header: 'Status', key: 'status' },
    { header: 'Condition', key: 'condition', chip: condChip },
    { header: 'Trend', key: 'trend' },
  ];
  const data = rows.map((r) => ({
    site: r.site || '',
    equipment: r.equipment || '',
    serviceNeeded: r.serviceNeeded || '',
    dueDate: r.dueDate instanceof Date ? r.dueDate : (r.dueDate ? new Date(r.dueDate) : null),
    status: r.status || '',
    condition: r.condition || '',
    trend: (r.trend && String(r.trend).trim()) ? 'Worsening' : '',
  }));

  applyReportSheet(ws, {
    title,
    subtitle: `${countLabel(data.length)} · Generated ${today()}`,
    columns,
    rows: data,
    autoFilter: true,
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildDigestXlsxBuffer, buildCustomerXlsxBuffer };
export {};
