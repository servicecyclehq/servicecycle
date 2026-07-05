'use strict';

/**
 * lib/reportsPdf.ts
 * ------------------
 * Minimal generic tabular PDF renderer for the /api/reports/* named reports
 * (2026-07-05, §9). Not a NETA-styled document (no letterhead/branding) —
 * this is a plain, functional table export for operators who want a printable
 * snapshot; it deliberately does not try to match the polish of the arc-flash
 * label / EMP document renderers (lib/arcFlashLabelDoc.ts, lib/empDocument.ts),
 * which are purpose-built compliance documents. If a report ever needs that
 * level of polish, give it its own renderer — don't grow this one bespoke
 * report at a time.
 *
 * Usage: renderReportTablePdf(res, { title, subtitle, generatedAt, columns,
 * rows }) streams a PDF directly to an Express response. `columns` is
 * [{ key, label, width? }]; `rows` is an array of plain objects keyed by
 * `columns[].key`. Values are stringified with String() — callers are
 * responsible for formatting (dates, decimals) before passing rows in.
 */

const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 40;
const ROW_HEIGHT = 18;
const HEADER_HEIGHT = 20;

function renderReportTablePdf(res: any, opts: {
  title: string;
  subtitle?: string;
  generatedAt?: Date;
  columns: Array<{ key: string; label: string; width?: number }>;
  rows: any[];
}) {
  const { title, subtitle, generatedAt, columns, rows } = opts;
  const doc = new PDFDocument({ size: 'letter', margin: PAGE_MARGIN, info: { Title: title, Author: 'ServiceCycle' } });

  res.setHeader('Content-Type', 'application/pdf');
  const safeName = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 64);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'report'}.pdf"`);

  let destroyed = false;
  const kill = () => { if (destroyed) return; destroyed = true; try { doc.unpipe(res); doc.destroy(); } catch (_) { /* noop */ } };
  res.on('close', kill);

  doc.pipe(res);

  try {
    const pageWidth = doc.page.width - PAGE_MARGIN * 2;
    const totalWeight = columns.reduce((s, c) => s + (c.width || 1), 0);
    const colWidths = columns.map((c) => (pageWidth * (c.width || 1)) / totalWeight);

    doc.fontSize(16).font('Helvetica-Bold').text(title);
    if (subtitle) doc.fontSize(10).font('Helvetica').fillColor('#555').text(subtitle);
    doc.fillColor('#000').fontSize(9).font('Helvetica')
      .text(`Generated ${(generatedAt || new Date()).toISOString()}`, { align: 'right' });
    doc.moveDown(0.5);

    const drawHeaderRow = () => {
      let x = PAGE_MARGIN;
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(9);
      columns.forEach((c, i) => {
        doc.text(c.label, x, y, { width: colWidths[i], continued: false });
        x += colWidths[i];
      });
      doc.moveDown(0.3);
      doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + pageWidth, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9);
    };

    drawHeaderRow();

    for (const row of rows) {
      if (doc.y > doc.page.height - PAGE_MARGIN - ROW_HEIGHT) {
        doc.addPage();
        drawHeaderRow();
      }
      let x = PAGE_MARGIN;
      const y = doc.y;
      columns.forEach((c, i) => {
        const val = row[c.key];
        doc.text(val === null || val === undefined ? '' : String(val), x, y, { width: colWidths[i] });
        x += colWidths[i];
      });
      doc.moveDown(0.4);
    }

    if (rows.length === 0) {
      doc.font('Helvetica-Oblique').fillColor('#777').text('No rows to display.');
    }
  } catch (e) {
    console.error('[reportsPdf] render error:', e);
  }
  if (!destroyed) doc.end();
}

module.exports = { renderReportTablePdf };

export {};
