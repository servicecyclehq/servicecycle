/**
 * xlsxStyle.ts — the canonical ServiceCycle Excel look.
 *
 * One shared style so every workbook the platform exports is branded and laid
 * out identically. Modern, not "spreadsheet-plain": gridlines off, a left
 * whitespace gutter, an editorial title with a thin accent rule, a KPI dashboard
 * on the summary sheet, color status chips, a risk data bar, typed
 * number/currency/date/percent formats, a frozen header, fit-to-width printing.
 * Palette mirrors the PDF house style so PDFs and spreadsheets read as one
 * product.
 *
 *   applySummarySheet(ws, { title, subtitle, kpis, lines })  — dashboard cover
 *   applyReportSheet (ws, { title, subtitle, columns, rows, totals }) — data
 *
 * A column may carry `chip: (raw) => 'good'|'warn'|'bad'|null` to render a status
 * pill, and `bar: true` to render an in-cell data bar. Do not hand-style
 * worksheets elsewhere — extend this module so the look stays uniform and the
 * xlsx audit stays meaningful.
 */

'use strict';

// ARGB ('FFRRGGBB'). Mirrors the PDF palette; one accent + neutrals + status.
const BRAND = {
  ink:     'FF111827', // titles / strong text
  accent:  'FF0D4F6E', // petrol — the single brand accent (header, rules)
  accentLt:'FFE9F1F5', // accent tint (KPI card wash)
  barFill: 'FFAFCFDD', // light petrol — data-bar fill, so dark cell text stays readable over it
  band:    'FFF7F9FB', // faint zebra
  grid:    'FFEAEDF2', // hairline row separators
  subtle:  'FF6B7280', // muted labels
  text:    'FF1F2937',
  white:   'FFFFFFFF',
};

// Soft status chips (fill + text), green/amber/red == good/warn/bad.
const CHIP: Record<string, { fill: string; text: string }> = {
  good: { fill: 'FFE7F5EC', text: 'FF15803D' },
  warn: { fill: 'FFFCF1E2', text: 'FFB45309' },
  bad:  { fill: 'FFFBEAEA', text: 'FFB91C1C' },
};

type ColType = 'string' | 'number' | 'currency' | 'date' | 'percent';
interface Col {
  header: string; key: string; type?: ColType; width?: number;
  get?: (row: any) => any;
  chip?: (raw: any) => 'good' | 'warn' | 'bad' | null;
  bar?: boolean;
}

const NUMFMT: Record<string, string> = {
  currency: '"$"#,##0',
  date:     'yyyy-mm-dd',
  percent:  '0.0%',
  number:   '#,##0',
};

const GUT = 2; // data starts in column B; column A is a whitespace gutter

function dateOrNull(v: any): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function numericType(t?: ColType): boolean {
  return t === 'number' || t === 'currency' || t === 'percent';
}

function autoWidth(col: Col, rows: any[]): number {
  if (col.width) return col.width;
  let w = String(col.header || '').length + 3;
  for (const r of rows) {
    const raw = col.get ? col.get(r) : r[col.key];
    const len = raw == null ? 0 : String(raw).length;
    if (len + 3 > w) w = len + 3;
  }
  return Math.min(Math.max(w, 11), 58);
}

function coerce(col: Col, raw: any): any {
  if (col.type === 'date') return raw instanceof Date ? raw : dateOrNull(raw);
  if (numericType(col.type)) return (raw == null || raw === '') ? null : Number(raw);
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  return raw == null ? '' : String(raw);
}

function colLetter(ws: any, n: number): string { return ws.getColumn(n).letter; }

/**
 * Data sheet: whitespace gutter, editorial title + accent rule, petrol header,
 * hairline-separated rows, optional status chips + risk data bar, bold totals.
 */
function applyReportSheet(ws: any, opts: {
  title: string;
  subtitle?: string;
  columns: Col[];
  rows: any[];
  totals?: Record<string, any>;
  autoFilter?: boolean;
}) {
  const { title, subtitle, columns, rows, totals } = opts;
  const nCol = columns.length;
  ws.getColumn(1).width = 2.4;
  columns.forEach((c, i) => { ws.getColumn(i + GUT).width = autoWidth(c, rows); });
  const firstL = colLetter(ws, GUT);
  const lastL  = colLetter(ws, GUT + nCol - 1);

  ws.views = [{ state: 'frozen', ySplit: 4, showGridLines: false }];
  ws.getRow(1).height = 6;

  // Title + subtitle (editorial, on white).
  const tc = ws.getCell(`${firstL}2`);
  tc.value = title;
  tc.font = { name: 'Calibri', size: 17, bold: true, color: { argb: BRAND.ink } };
  tc.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 24;

  const sc = ws.getCell(`${firstL}3`);
  sc.value = (subtitle || 'PREPARED BY SERVICECYCLE').toUpperCase();
  sc.font = { name: 'Calibri', size: 8.5, bold: true, color: { argb: BRAND.subtle } };
  sc.alignment = { vertical: 'middle' };
  ws.getRow(3).height = 16;
  // Thin accent rule under the subtitle, spanning the table.
  for (let i = 0; i < nCol; i++) {
    ws.getRow(3).getCell(i + GUT).border = { bottom: { style: 'medium', color: { argb: BRAND.accent } } };
  }

  // Header row (row 4).
  const hr = ws.getRow(4);
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + GUT);
    cell.value = c.header.toUpperCase();
    cell.font = { name: 'Calibri', size: 8.5, bold: true, color: { argb: BRAND.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.accent } };
    cell.alignment = { vertical: 'middle', horizontal: numericType(c.type) ? 'right' : 'left', indent: 1 };
  });
  hr.height = 22;

  // Data rows (from row 5).
  rows.forEach((r, ri) => {
    const row = ws.getRow(5 + ri);
    row.height = 18;
    columns.forEach((c, i) => {
      const cell = row.getCell(i + GUT);
      const raw = c.get ? c.get(r) : r[c.key];
      cell.value = coerce(c, raw);
      if (c.type && NUMFMT[c.type]) cell.numFmt = NUMFMT[c.type];
      cell.font = { name: 'Calibri', size: 10, color: { argb: BRAND.text } };
      cell.alignment = { vertical: 'middle', horizontal: numericType(c.type) ? 'right' : 'left', indent: 1 };
      cell.border = { bottom: { style: 'thin', color: { argb: BRAND.grid } } };
      if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.band } };
      const kind = c.chip ? c.chip(raw) : null;
      if (kind && CHIP[kind]) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CHIP[kind].fill } };
        cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: CHIP[kind].text } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      }
    });
  });

  // In-cell data bars for any `bar` column.
  if (rows.length) {
    columns.forEach((c, i) => {
      if (!c.bar) return;
      const L = colLetter(ws, i + GUT);
      ws.addConditionalFormatting({
        ref: `${L}5:${L}${4 + rows.length}`,
        rules: [{ type: 'dataBar', gradient: false, border: false, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: BRAND.barFill } }],
      });
    });
  }

  // Totals.
  if (totals) {
    const row = ws.getRow(5 + rows.length);
    row.height = 18;
    columns.forEach((c, i) => {
      const cell = row.getCell(i + GUT);
      const has = Object.prototype.hasOwnProperty.call(totals, c.key);
      cell.value = (i === 0 && !has) ? 'TOTAL' : (has ? coerce(c, totals[c.key]) : null);
      if (has && c.type && NUMFMT[c.type]) cell.numFmt = NUMFMT[c.type];
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.ink } };
      cell.alignment = { vertical: 'middle', horizontal: numericType(c.type) ? 'right' : 'left', indent: 1 };
      cell.border = { top: { style: 'medium', color: { argb: BRAND.accent } } };
    });
  }

  ws.properties.tabColor = { argb: BRAND.accent };
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape', margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } };
  // Optional filter dropdowns on the (frozen) header row.
  if (opts.autoFilter && rows.length) {
    ws.autoFilter = { from: { row: 4, column: GUT }, to: { row: 4, column: GUT + nCol - 1 } };
  }
}

/**
 * Summary / cover sheet: editorial title, a KPI dashboard (big-number cards with
 * an accent top-rule), then a label/value meta block. `kpis` is up to 4
 * { value, label } cards; `lines` is [label, value] pairs ([null,null] = spacer).
 */
function applySummarySheet(ws: any, opts: {
  title: string;
  subtitle?: string;
  kpis?: Array<{ value: string; label: string }>;
  lines?: Array<[string | null, any]>;
}) {
  ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  ws.getColumn(1).width = 2.4;
  for (let c = GUT; c <= GUT + 10; c++) ws.getColumn(c).width = 15;
  ws.getRow(1).height = 8;

  const firstL = colLetter(ws, GUT);
  const tc = ws.getCell(`${firstL}2`);
  tc.value = opts.title;
  tc.font = { name: 'Calibri', size: 20, bold: true, color: { argb: BRAND.ink } };
  ws.getRow(2).height = 28;
  const sc = ws.getCell(`${firstL}3`);
  sc.value = (opts.subtitle || 'PREPARED BY SERVICECYCLE').toUpperCase();
  sc.font = { name: 'Calibri', size: 9, bold: true, color: { argb: BRAND.subtle } };
  ws.getRow(3).height = 18;

  // KPI cards — each spans 2 columns, separated by a 1-column gutter.
  const kpis = (opts.kpis || []).slice(0, 4);
  let row = 5;
  if (kpis.length) {
    ws.getRow(5).height = 26;
    ws.getRow(6).height = 16;
    kpis.forEach((k, idx) => {
      const c0 = GUT + idx * 3;            // card columns c0..c0+1, gutter at c0+2
      const a = colLetter(ws, c0);
      const b = colLetter(ws, c0 + 1);
      ws.mergeCells(`${a}5:${b}5`);
      ws.mergeCells(`${a}6:${b}6`);
      const num = ws.getCell(`${a}5`);
      num.value = k.value;
      num.font = { name: 'Calibri', size: 18, bold: true, color: { argb: BRAND.accent } };
      num.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      const lab = ws.getCell(`${a}6`);
      lab.value = k.label.toUpperCase();
      lab.font = { name: 'Calibri', size: 8, bold: true, color: { argb: BRAND.subtle } };
      lab.alignment = { vertical: 'top', horizontal: 'left', indent: 1 };
      // card wash + accent top rule
      [`${a}5`, `${b}5`, `${a}6`, `${b}6`].forEach((addr) => {
        ws.getCell(addr).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.accentLt } };
      });
      ws.getCell(`${a}5`).border = { top: { style: 'medium', color: { argb: BRAND.accent } } };
      ws.getCell(`${b}5`).border = { top: { style: 'medium', color: { argb: BRAND.accent } } };
    });
    row = 8;
  }

  // Meta block.
  for (const [k, v] of (opts.lines || [])) {
    const r = ws.getRow(row++);
    if (k == null && (v == null || v === '')) { r.height = 6; continue; }
    r.height = 16;
    ws.mergeCells(`${colLetter(ws, GUT)}${r.number}:${colLetter(ws, GUT + 1)}${r.number}`);
    const kc = r.getCell(GUT);
    kc.value = k || '';
    kc.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.accent } };
    kc.alignment = { vertical: 'middle' };
    ws.mergeCells(`${colLetter(ws, GUT + 2)}${r.number}:${colLetter(ws, GUT + 8)}${r.number}`);
    const vc = r.getCell(GUT + 2);
    vc.value = v == null ? '' : String(v);
    vc.font = { name: 'Calibri', size: 10, color: { argb: BRAND.text } };
    vc.alignment = { vertical: 'middle', wrapText: true };
  }

  ws.properties.tabColor = { argb: BRAND.ink };
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape', margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
}

/**
 * Round-trip template/export: brand the existing header row IN PLACE — headers
 * stay in row 1 so the file still re-imports — then freeze it and autofit
 * columns. NO masthead. Use this for any .xlsx that is downloaded, filled in,
 * and re-uploaded (AFX multi-table export, import templates), where a masthead
 * would shift the headers out of row 1 and break the parser.
 */
function applyTemplateHeader(ws: any, opts: { headerRow?: number } = {}) {
  const hn = opts.headerRow || 1;
  const hr = ws.getRow(hn);
  hr.eachCell({ includeEmpty: false }, (cell: any) => {
    cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: BRAND.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.accent } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  });
  hr.height = 20;
  ws.views = [{ state: 'frozen', ySplit: hn }];
  ws.properties.tabColor = { argb: BRAND.accent };
  ws.columns.forEach((col: any) => {
    let w = 10;
    col.eachCell({ includeEmpty: false }, (cell: any) => {
      const len = cell.value == null ? 0 : String(cell.value).length;
      if (len + 3 > w) w = len + 3;
    });
    col.width = Math.min(Math.max(w, 10), 48);
  });
}

function brandWorkbook(wb: any) {
  wb.creator = 'ServiceCycle';
  wb.company = 'ServiceCycle';
  wb.created = new Date();
}

module.exports = { BRAND, CHIP, applyReportSheet, applySummarySheet, applyTemplateHeader, brandWorkbook, NUMFMT };

export {};
