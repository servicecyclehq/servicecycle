/**
 * xlsxExport.js — shared ExcelJS workbook builder + streamer.
 *
 * v0.58.0: extracted from routes/export.js so the new reports routes
 * (auto-renewal-exposure, vendor-concentration, non-saas-categories) can
 * reuse the same column-registry → workbook conversion without
 * duplicating the workbook formatting code or the column-type number-
 * format choices.
 *
 * Column def shape (columnDefs[i]):
 *   {
 *     id:      'fieldKey',
 *     header:  'Column Header',
 *     type:    'string' | 'number' | 'currency' | 'date' | 'percent',
 *     get:     row => valueFromRow,
 *     width?:  number,  // default 20
 *   }
 *
 * Date cells use 'yyyy-mm-dd' format; currency uses "$"#,##0; percent uses
 * 0.0%; number uses #,##0 implicit. Cells with null/empty strings are left
 * blank rather than coerced to 0 — so a missing date doesn't show as
 * 1900-01-00.
 */

'use strict';

const ExcelJS = require('exceljs');

function dateOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function sendXlsx(res, { sheetName, columnDefs, rows, filename }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LapseIQ';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName || 'Report');

  ws.columns = columnDefs.map(c => ({
    header: c.header,
    key: c.id,
    width: c.width || 20,
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  };

  for (const r of rows) {
    const rowObj = {};
    for (const c of columnDefs) {
      const raw = c.get(r);
      if (c.type === 'date') {
        rowObj[c.id] = raw instanceof Date ? raw : dateOrNull(raw);
      } else if (c.type === 'number' || c.type === 'currency' || c.type === 'percent') {
        rowObj[c.id] = (raw == null || raw === '') ? null : Number(raw);
      } else {
        rowObj[c.id] = raw == null ? '' : String(raw);
      }
    }
    const row = ws.addRow(rowObj);
    columnDefs.forEach((c, idx) => {
      if (c.type === 'currency') {
        row.getCell(idx + 1).numFmt = '"$"#,##0';
      } else if (c.type === 'date') {
        row.getCell(idx + 1).numFmt = 'yyyy-mm-dd';
      } else if (c.type === 'percent') {
        // Values stored as 0..1 render as 0%..100%; values >1 are treated
        // as already-multiplied (e.g. 23.4 → 23.4%) so callers can pick
        // whichever convention is natural for their data.
        row.getCell(idx + 1).numFmt = '0.0%';
      } else if (c.type === 'number') {
        row.getCell(idx + 1).numFmt = '#,##0';
      }
    });
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(Buffer.from(buffer));
}

module.exports = { sendXlsx };

export {};
