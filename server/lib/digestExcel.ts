/**
 * digestExcel.ts — builds the monthly-digest Excel attachment as a Buffer
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

export interface DigestRow {
  rep: string;
  company: string;
  site: string;
  equipment: string;       // "Transformer · Square D / EZ-9"
  serviceNeeded: string;   // task name
  dueDate: Date | null;    // nextDueDate
  status: string;          // "12d overdue" | "due in 30d"
  condition: string;       // C1 | C2 | C3
  priorityScore: number | null; // DPS 1–25
  trend: string;           // "⚠ worsening" | ""
  estMinDollars: number | null;
  estMaxDollars: number | null;
  rulPct: number | null;   // modernizationRiskScore × 100
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
  { header: '⚠ Trend',        key: 'trend',         width: 16 },
  { header: 'Est. value $',   key: 'estValue',      width: 20 },
  { header: 'RUL %',          key: 'rulPct',        width: 10, type: 'number' },
  { header: 'Age (yrs)',      key: 'ageYears',      width: 11, type: 'number' },
  { header: 'Auto-C3',        key: 'autoC3',        width: 10 },
];

function estValueText(r: DigestRow): string {
  if (r.estMinDollars == null && r.estMaxDollars == null) return '';
  const min = r.estMinDollars ?? r.estMaxDollars ?? 0;
  const max = r.estMaxDollars ?? r.estMinDollars ?? 0;
  if (min === max) return `$${min.toLocaleString()}`;
  return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
}

/**
 * Build the workbook as a Buffer. `title` becomes a frozen header banner row.
 */
export async function buildDigestXlsxBuffer(
  rows: DigestRow[],
  { title = 'ServiceCycle — Monthly Service Digest' }: { title?: string } = {},
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

module.exports = { buildDigestXlsxBuffer };
export {};
