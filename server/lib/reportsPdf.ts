'use strict';

/**
 * lib/reportsPdf.ts
 * ------------------
 * Generic tabular PDF renderer for the /api/reports/* named reports
 * (2026-07-05, section 9). C2a (2026-07-13): migrated onto the shared Field
 * Report theme in lib/pdfStyle.ts -- masthead, branded hairline table, mono
 * footer -- replacing the previous deliberately-unbranded plain table
 * (docs/design/EXPORT_SURFACE_INVENTORY_2026-07-13.md callout 6 named this
 * the biggest visual win). Still ONE generic renderer: a report that needs
 * bespoke layout gets its own module -- don't grow this one report at a time.
 *
 * Usage: renderReportTablePdf(res, { title, subtitle, generatedAt, columns,
 * rows }) streams a PDF directly to an Express response. `columns` is
 * [{ key, label, width? }] (width is a relative weight); `rows` is an array
 * of plain objects keyed by `columns[].key`. Values are stringified -- callers
 * are responsible for formatting (dates, decimals) before passing rows in.
 * Empty cells render as the shared table style em dash.
 */

const PDFDocument = require('pdfkit');
const {
  PDF_COLORS, PDF_FONTS, PDF_PAGE, formatTimestamp,
  drawMasthead, drawTable, attachFooter,
} = require('./pdfStyle');

function renderReportTablePdf(res: any, opts: {
  title: string;
  subtitle?: string;
  generatedAt?: Date;
  columns: Array<{ key: string; label: string; width?: number }>;
  rows: any[];
}) {
  const { title, subtitle, generatedAt, columns, rows } = opts;
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PDF_PAGE.margin, bottom: PDF_PAGE.margin, left: PDF_PAGE.margin, right: PDF_PAGE.margin },
    info: { Title: title, Author: 'ServiceCycle' },
  });

  res.setHeader('Content-Type', 'application/pdf');
  const safeName = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 64);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'report'}.pdf"`);

  let destroyed = false;
  const kill = () => { if (destroyed) return; destroyed = true; try { doc.unpipe(res); doc.destroy(); } catch (_) { /* noop */ } };
  res.on('close', kill);

  doc.pipe(res);

  try {
    const when = generatedAt || new Date();
    // Footer on page 1 now + on every pageAdded (incl. drawTable's breaks).
    attachFooter(doc, { generatedAtIso: when.toISOString() });

    let y = drawMasthead(doc, { title, metaLines: [formatTimestamp(when)] });

    if (subtitle) {
      doc.font(PDF_FONTS.sans).fontSize(9).fillColor(PDF_COLORS.textMuted)
         .text(subtitle, PDF_PAGE.margin, y, { width: PDF_PAGE.contentW });
      y = doc.y + 10;
    }

    drawTable(doc, {
      y,
      cols: columns.map((c) => ({ key: c.key, label: c.label, w: c.width || 1 })),
      rows,
      emptyText: 'No rows to display.',
    });
  } catch (e) {
    console.error('[reportsPdf] render error:', e);
  }
  if (!destroyed) doc.end();
}

module.exports = { renderReportTablePdf };

export {};
