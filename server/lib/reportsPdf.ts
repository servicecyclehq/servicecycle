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
 *
 * renderReportDocPdf(res, { title, org?, metaLines?, generatedAt?, filename?,
 * sections }) is the sectioned sibling for reports that are more than one
 * table: a document with a masthead, numbered sections (drawSectionHeading),
 * an optional narrative paragraph + a compact mono "brief line" of stats per
 * section, and any number of hairline tables -- with page-N-of-M footers via
 * finalizeFooters. `sections` is [{ number?, title, aux?, body?: string |
 * string[], stats?: [{ label, value }], table?: { columns, rows, emptyText? }}].
 * Both renderers are GENERIC -- a report needing bespoke layout still gets its
 * own module; don't grow either one report at a time.
 */

const PDFDocument = require('pdfkit');
const {
  PDF_COLORS, PDF_FONTS, PDF_PAGE, formatTimestamp, ensureSpace,
  drawMasthead, drawSectionHeading, drawTable, attachFooter, finalizeFooters,
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

// A compact mono "brief line" of KEY value pairs (uppercase faint label +
// bold ink value), wrapping across the content width. Mirrors the on-screen
// print `print-briefline`. Returns the y below the line.
function drawBriefLine(doc: any, stats: Array<{ label: any; value: any }>, y: number) {
  const m = PDF_PAGE.margin;
  const gap = 18;
  const labelFS = 6.5;
  const valueFS = 9.5;
  let cx = m;
  let cy = y;
  for (const s of (stats || [])) {
    if (!s) continue;
    const label = String(s.label == null ? '' : s.label).toUpperCase();
    const value = String(s.value == null ? '' : s.value);
    doc.font(PDF_FONTS.mono).fontSize(labelFS);
    const lw = doc.widthOfString(label, { characterSpacing: 0.6 });
    doc.font(PDF_FONTS.monoBold).fontSize(valueFS);
    const vw = doc.widthOfString(value);
    if (cx > m && cx + lw + 5 + vw > m + PDF_PAGE.contentW) { cx = m; cy += 16; }
    doc.font(PDF_FONTS.mono).fontSize(labelFS).fillColor(PDF_COLORS.textFaint)
       .text(label, cx, cy + 2, { lineBreak: false, characterSpacing: 0.6 });
    cx += lw + 5;
    doc.font(PDF_FONTS.monoBold).fontSize(valueFS).fillColor(PDF_COLORS.ink)
       .text(value, cx, cy, { lineBreak: false });
    cx += vw + gap;
  }
  const nextY = cy + 18;
  doc.x = m; doc.y = nextY;
  return nextY;
}

// Sectioned Field Report document: masthead -> numbered sections (each an
// optional narrative + optional stat brief line + optional hairline table) ->
// page-N-of-M footer. Streams straight to the Express response. See the file
// header for the opts shape.
function renderReportDocPdf(res: any, opts: {
  title: string;
  org?: string;
  metaLines?: string[];
  generatedAt?: Date;
  filename?: string;
  sections: Array<{
    number?: number | string;
    title: string;
    aux?: string;
    body?: string | string[];
    stats?: Array<{ label: any; value: any }>;
    table?: { columns: any[]; rows: any[]; emptyText?: string };
  }>;
}) {
  const { title, org, metaLines, generatedAt, filename, sections } = opts || ({} as any);
  const when = generatedAt || new Date();

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: PDF_PAGE.margin, bottom: PDF_PAGE.margin, left: PDF_PAGE.margin, right: PDF_PAGE.margin },
    info: { Title: String(title || 'Report'), Author: 'ServiceCycle' },
    bufferPages: true,
  });

  let destroyed = false;
  let footersDone = false;
  const kill = () => { if (destroyed) return; destroyed = true; try { doc.unpipe(res); doc.destroy(); } catch (_) { /* noop */ } };
  // Bind the stream error handler BEFORE the first write (pdfHelpDoc pattern:
  // a pdfkit stream-time error must not bubble as an unhandled 'error' event).
  doc.on('error', (e: any) => { try { console.error('[reportsPdf] doc stream error:', e && e.message); } catch (_) { /* noop */ } kill(); });
  res.on('close', kill);

  res.setHeader('Content-Type', 'application/pdf');
  const safeName = String(filename || title || 'report').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_').slice(0, 80);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName || 'report'}.pdf"`);

  doc.pipe(res);

  try {
    let y = drawMasthead(doc, {
      title: String(title || 'Report'),
      org: org || undefined,
      metaLines: (metaLines && metaLines.length) ? metaLines.filter(Boolean) : [formatTimestamp(when)],
    });

    (sections || []).forEach((sec, idx) => {
      if (!sec) return;
      y = drawSectionHeading(doc, {
        number: sec.number != null ? sec.number : idx + 1,
        title: sec.title,
        aux: sec.aux || undefined,
        y,
        topRule: idx !== 0, // first section sits under the masthead's double rule
      });

      if (sec.body) {
        const paras = Array.isArray(sec.body) ? sec.body : [sec.body];
        for (const p of paras) {
          if (!p) continue;
          doc.font(PDF_FONTS.sans).fontSize(9);
          const h = doc.heightOfString(String(p), { width: PDF_PAGE.contentW, lineGap: 1.5 });
          y = ensureSpace(doc, y, Math.min(h, 120) + 6);
          doc.font(PDF_FONTS.sans).fontSize(9).fillColor(PDF_COLORS.textMuted)
             .text(String(p), PDF_PAGE.margin, y, { width: PDF_PAGE.contentW, lineGap: 1.5 });
          y = doc.y + 8;
        }
      }

      if (sec.stats && sec.stats.length) {
        y = ensureSpace(doc, y, 24);
        y = drawBriefLine(doc, sec.stats, y);
      }

      if (sec.table && sec.table.columns) {
        y = drawTable(doc, {
          y,
          cols: sec.table.columns.map((c: any) => ({ ...c, w: c.w != null ? c.w : (c.width != null ? c.width : 1) })),
          rows: sec.table.rows || [],
          emptyText: sec.table.emptyText,
        });
      }

      y = doc.y + 8;
    });
  } catch (e) {
    try { console.error('[reportsPdf] renderReportDocPdf render error:', e); } catch (_) { /* noop */ }
  }

  try {
    if (!footersDone) { finalizeFooters(doc, { generatedAtIso: when.toISOString() }); footersDone = true; }
  } catch (e: any) {
    try { console.error('[reportsPdf] finalizeFooters error:', e && e.message); } catch (_) { /* noop */ }
  }
  if (!destroyed) doc.end();
}

module.exports = { renderReportTablePdf, renderReportDocPdf };

export {};
