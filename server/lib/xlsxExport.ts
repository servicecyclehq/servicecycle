/**
 * xlsxExport.ts — shared ExcelJS workbook builder + streamer.
 *
 * Report routes reuse the same column-registry → workbook conversion without
 * duplicating formatting. All styling now flows through lib/xlsxStyle so every
 * Excel export across the platform shares one canonical, branded look (navy
 * masthead, petrol header, status chips, typed formats, frozen + filterable
 * header). The multi-sheet account export gets a KPI summary cover.
 *
 * Column def shape (columnDefs[i]):
 *   { id, header, type?: 'string'|'number'|'currency'|'date'|'percent',
 *     get?: row => value, width?: number,
 *     chip?: raw => 'good'|'warn'|'bad'|null, bar?: boolean }
 */

'use strict';

const ExcelJS = require('exceljs');
const { applyReportSheet, applySummarySheet, brandWorkbook } = require('./xlsxStyle');

const today = () => new Date().toISOString().slice(0, 10);
const rowsLabel = (n: number) => `${n} row${n === 1 ? '' : 's'}`;

// Map a column registry entry (id-keyed) to an xlsxStyle column (key-keyed).
function toStyleColumns(defs: any[]): any[] {
  return defs.map((c) => ({ header: c.header, key: c.id, type: c.type, get: c.get, width: c.width, chip: c.chip, bar: c.bar }));
}

async function sendXlsx(res: any, { sheetName, columnDefs, rows, filename, subtitle, truncated }: any) {
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);
  const ws = wb.addWorksheet(sheetName || 'Report');

  applyReportSheet(ws, {
    title: sheetName || 'Report',
    subtitle: subtitle || `${rowsLabel(rows.length)} · Generated ${today()}${truncated ? ' · capped — refine filters for the full set' : ''}`,
    columns: toStyleColumns(columnDefs),
    rows,
    autoFilter: true,
  });

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(Buffer.from(buffer));
}

// ── Multi-sheet full-account export (#5 export-everything) ───────────────────
// A branded "Read Me" summary (KPI cards from the entity counts + meta +
// offboarding) followed by one filterable sheet per entity from the sheetPlan.
async function sendAccountXlsx(res: any, { exportData, sheetPlan, filename }: any) {
  const wb = new ExcelJS.Workbook();
  brandWorkbook(wb);

  const m = exportData.meta || {};
  const acct = exportData.account?.companyName || '';
  const gen = m.generatedAt ? new Date(m.generatedAt).toISOString().slice(0, 10) : today();
  const counts = exportData.counts || {};

  const kpis = Object.entries(counts).slice(0, 4).map(([k, v]) => ({ value: String(v), label: k }));
  const lines: Array<[string | null, any]> = [
    ['Product', `${m.product || 'ServiceCycle'} account export v${m.exportVersion || '1'}`],
    ['Standard', m.standard || 'NFPA 70B'],
    ['Company', acct],
    ['Generated', gen],
    [null, null],
    ...Object.entries(counts).map(([k, v]) => [`Count — ${k}`, String(v)] as [string, string]),
  ];
  for (const line of (exportData.offboarding || [])) lines.push([null, null], ['Offboarding', line]);

  applySummarySheet(wb.addWorksheet('Read Me'), {
    title: 'ServiceCycle Account Export',
    subtitle: `${acct ? acct + '   ·   ' : ''}Generated ${gen}`,
    kpis,
    lines,
  });

  for (const plan of sheetPlan) {
    const rows = exportData[plan.key] || [];
    const ws = wb.addWorksheet(plan.sheet);
    applyReportSheet(ws, {
      title: plan.sheet,
      subtitle: `${acct ? acct + '   ·   ' : ''}${rowsLabel(rows.length)}   ·   Generated ${gen}`,
      columns: toStyleColumns(plan.columns),
      rows,
      autoFilter: true,
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(Buffer.from(buffer));
}

module.exports = { sendXlsx, sendAccountXlsx };

export {};
