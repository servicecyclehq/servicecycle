'use strict';

/**
 * lib/pdfStyle.ts
 * ---------------
 * C1(b): the shared ServiceCycle PDF theme -- the pdfkit counterpart of
 * lib/xlsxStyle.ts (spreadsheets) and client/src/styles/print.css (browser
 * print). One module defines the "Field Report" document standard from
 * docs/design/direction-board-2026-07-12.html (#dir-c / .m3): a masthead
 * with a double hairline rule, numbered sections (01, 02, ...),
 * hairline-ruled tables with right-aligned mono numeric columns, and a
 * mono footer (timestamp, page N [of M], optional integrity-hash line).
 *
 * Colors are the LOCKED brand palette (brand/brand.md v1.1; v0.91 palette
 * locked 2026-05-27). pdfkit has no CSS variables, so the canonical hex
 * literals are defined ONCE here. Renderers must import PDF_COLORS instead
 * of re-declaring COLORS blocks (compliancePdf / empDocument / cfoReport /
 * leaveBehindPdf / proposalPdf each duplicate one today -- C2 migrates
 * them). Note: those legacy blocks use accent #0d4f6e, which is the v0.91
 * HOVER shade; the locked primary is petrol #073a52.
 *
 * HARD RULES (docs/design/EXPORT_SURFACE_INVENTORY_2026-07-13.md):
 *  - Immutable snapshots: compliance snapshots + EMP documents are
 *    SHA-256-anchored and re-hashed on download (routes/compliance.ts
 *    integrity check). This theme applies FORWARD-ONLY to newly generated
 *    documents. Never re-render, backfill, or "refresh" stored snapshot
 *    bytes with this (or any) theme.
 *  - Safety-format exemptions: ANSI Z535.4 arc-flash label colors/geometry
 *    (lib/arcFlashLabelDoc.ts), the NFPA 70E energized-work permit format,
 *    and the popup label sheet are normative and NOT brand-themeable. Do
 *    not wire this module into them beyond, at most, footer
 *    micro-typography.
 *
 * Design constraints, so C2 migrations are drop-in (patterns verified
 * against lib/compliancePdf.ts, lib/empDocument.ts, lib/reportsPdf.ts):
 *  - Helpers take an existing `doc`; they never create or end documents.
 *    Each renderer keeps its own hardened stream lifecycle (error handler
 *    bound before first write, settled flag, kill-on-close).
 *  - Explicit y in, next y out (and doc.x/doc.y left at the same point), so
 *    both cursor styles in the codebase work: empDocument threads ctx.y,
 *    compliancePdf and reportsPdf use doc.y.
 *  - drawFooter keeps the recursion guard + cursor-neutral + lineBreak:false
 *    hardening from compliancePdf/pdfHelpDoc (the v0.36.8 pageAdded
 *    recursion fix class) and the same (doc, opts, pageNum) call shape.
 *  - Page geometry matches the house PDFs: LETTER, 54pt (0.75in) margins,
 *    504pt content width.
 *
 * Typical use (C2):
 *   const { PDF_COLORS, PDF_FONTS, PDF_PAGE, drawMasthead,
 *           drawSectionHeading, drawTable, drawFooter, attachFooter,
 *           formatTimestamp } = require('./pdfStyle');
 *   const doc = new PDFDocument({ size: 'LETTER',
 *     margins: { top: 54, bottom: 54, left: 54, right: 54 } });
 *   // ... buffer/pipe + error wiring first, as in empDocument ...
 *   attachFooter(doc, { generatedAtIso, docId, brandName }); // p1 + pageAdded
 *   let y = drawMasthead(doc, { title: 'Compliance Snapshot',
 *     org: account.companyName, metaLines: [formatTimestamp(new Date())] });
 *   y = drawSectionHeading(doc, { number: 1, title: 'Status',
 *     aux: 'vs NFPA 70B (2023)', y });
 *   y = drawTable(doc, { y, cols: [
 *     { key: 'task', label: 'Task', w: 200 },
 *     { key: 'age',  label: 'Age (days)', w: 60, numeric: true },
 *   ], rows });
 *   doc.end();
 *
 * For "Page N of M": create the doc with { bufferPages: true }, skip
 * attachFooter, and call finalizeFooters(doc, opts) just before doc.end().
 */

// Locked brand palette -- brand/brand.md "Color palette" tables (light mode).
// Single source of truth for server-side documents; do NOT copy these hexes
// into individual renderers.
const PDF_COLORS = {
  ink:          '#0a0d12', // primary text, headings, masthead rules
  petrol:       '#073a52', // brand primary -- section numbers, accents
  petrolHover:  '#0d4f6e', // one stop lighter (legacy renderer accent)
  petrolTint:   '#e6f0f5', // soft petrol wash (badges, info panels)
  emerald:      '#10b981', // signal accent -- use sparingly
  textMuted:    '#1e293b', // secondary text
  textFaint:    '#334155', // tertiary text, footers, table headers
  border:       '#c7cfdb', // default border / section top rules
  borderSubtle: '#e3e7ee', // hairline table row rules
  pageBg:       '#fafbfd', // page wash (panels only; paper stays white)
  card:         '#ffffff',
  success:      '#15803d',
  warning:      '#b45309',
  danger:       '#b91c1c',
  successBg:    '#dcfce7',
  warningBg:    '#fef3c7',
  dangerBg:     '#fee2e2',
};

// pdfkit built-in (AFM) fonts only -- no font files to ship or license.
// Courier is the mono voice for figures / IDs / dates / footers, mirroring
// print.css's var(--font-mono) role.
const PDF_FONTS = {
  sans:        'Helvetica',
  sansBold:    'Helvetica-Bold',
  sansOblique: 'Helvetica-Oblique',
  mono:        'Courier',
  monoBold:    'Courier-Bold',
};

// House page geometry (identical to compliancePdf / empDocument).
const PDF_PAGE = {
  margin:   54,             // 0.75in
  width:    612,            // LETTER
  height:   792,
  contentW: 612 - 54 * 2,   // 504
  bottom:   792 - 54,
};

const CELL_PAD = 3;
const TABLE_FS = 8;         // table body font size
const HEADER_FS = 6.5;      // table header label size (uppercase mono)
const TRACK = 0.6;          // characterSpacing for uppercase mono labels

// -- small utilities ----------------------------------------------------------

function fmtCell(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

const DAY_NAMES   = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                     'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Masthead-meta timestamp in the field-report voice:
 * "SUN 13 JUL 2026, 04:12 UTC". Always UTC -- documents are evidence and
 * must not depend on server timezone.
 */
function formatTimestamp(d) {
  const dt = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  if (isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return DAY_NAMES[dt.getUTCDay()] + ' ' + p(dt.getUTCDate()) + ' ' +
    MONTH_NAMES[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear() + ', ' +
    p(dt.getUTCHours()) + ':' + p(dt.getUTCMinutes()) + ' UTC';
}

/**
 * Page-break guard for the ctx.y threading style: returns the y to draw at,
 * adding a page when `need` points would not fit above the bottom margin.
 */
function ensureSpace(doc, y, need) {
  if (y + need > PDF_PAGE.bottom - 6) {
    doc.addPage();
    return PDF_PAGE.margin;
  }
  return y;
}

// Column widths act as weights scaled to fill contentW, so both styles in
// the codebase work unchanged: empDocument-style absolute widths that sum
// to 504 (scale = 1) and reportsPdf-style small weights.
function scaledWidths(cols) {
  let total = 0;
  for (const c of cols) total += (c.w || c.width || 1);
  const scale = PDF_PAGE.contentW / (total || 1);
  return cols.map((c) => (c.w || c.width || 1) * scale);
}

function isRight(col) { return col.align === 'right' || !!col.numeric; }

function cellFont(col) {
  if (col.numeric || col.mono) return col.bold ? PDF_FONTS.monoBold : PDF_FONTS.mono;
  return col.bold ? PDF_FONTS.sansBold : PDF_FONTS.sans;
}

// -- masthead -----------------------------------------------------------------

/**
 * Title + right-aligned mono org/meta block + the double hairline rule.
 *
 * opts: { title, org?, metaLines?: string[], y? }
 * Returns the y below the rule (also sets doc.x/doc.y there).
 */
function drawMasthead(doc, opts) {
  const o = opts || {};
  const m = PDF_PAGE.margin;
  const y = o.y != null ? o.y : m;
  const title = String(o.title || '');

  const metaLines = [];
  if (o.org) metaLines.push(String(o.org).toUpperCase());
  for (const l of (o.metaLines || [])) metaLines.push(String(l).toUpperCase());

  // Right meta block width (capped so a long org name cannot crush the title).
  doc.font(PDF_FONTS.mono).fontSize(7.5);
  let metaW = 0;
  for (const l of metaLines) {
    const w = doc.widthOfString(l, { characterSpacing: TRACK });
    if (w > metaW) metaW = w;
  }
  // +2pt cushion: pdfkit's wrapper ellipsizes a line rendered into a width
  // exactly equal to its own measured width (rounding epsilon), which cut the
  // trailing " UTC" off the longest meta line (C2a finding).
  metaW = Math.min(metaW + 2, PDF_PAGE.contentW * 0.45);

  const titleW = PDF_PAGE.contentW - (metaLines.length ? metaW + 18 : 0);
  doc.font(PDF_FONTS.sansBold).fontSize(21).fillColor(PDF_COLORS.ink);
  const titleH = doc.heightOfString(title, { width: titleW });
  doc.text(title, m, y, { width: titleW });

  if (metaLines.length) {
    doc.font(PDF_FONTS.mono).fontSize(7.5).fillColor(PDF_COLORS.textFaint);
    let my = y + 5; // optically aligned with the title cap height
    for (const l of metaLines) {
      doc.text(l, m + PDF_PAGE.contentW - metaW, my, {
        width: metaW,
        align: 'right',
        lineBreak: false,
        characterSpacing: TRACK,
        ellipsis: true,
        height: 10,
      });
      my += 11;
    }
  }

  // Double rule: 2.5pt ink + 1pt ink echo 4pt below (field-report signature).
  const ruleY = y + Math.max(titleH, metaLines.length * 11) + 10;
  doc.moveTo(m, ruleY).lineTo(m + PDF_PAGE.contentW, ruleY)
     .lineWidth(2.5).strokeColor(PDF_COLORS.ink).stroke();
  doc.moveTo(m, ruleY + 4).lineTo(m + PDF_PAGE.contentW, ruleY + 4)
     .lineWidth(1).strokeColor(PDF_COLORS.ink).stroke();
  doc.lineWidth(1);

  const nextY = ruleY + 4 + 14;
  doc.x = m; doc.y = nextY;
  return nextY;
}

// -- numbered sections --------------------------------------------------------

/**
 * "01  Status ... aux" heading with a hairline top rule.
 *
 * opts: { number?, title, aux?, y?, topRule? }
 *  - number: 1 -> "01" (a string passes through untouched); omit it for an
 *    unnumbered peer heading (empDocument's "Purpose & Scope" pattern).
 *  - topRule: false suppresses the rule (e.g. the first section sitting
 *    right under the masthead's double rule).
 * Returns the y below the heading (also sets doc.x/doc.y there).
 */
function drawSectionHeading(doc, opts) {
  const o = opts || {};
  const m = PDF_PAGE.margin;
  let y = o.y != null ? o.y : doc.y;
  y = ensureSpace(doc, y, 60);

  if (o.topRule !== false) {
    doc.moveTo(m, y).lineTo(m + PDF_PAGE.contentW, y)
       .lineWidth(0.75).strokeColor(PDF_COLORS.border).stroke();
    doc.lineWidth(1);
  }
  const textY = y + 10;

  let x = m;
  if (o.number != null && o.number !== '') {
    const num = typeof o.number === 'number'
      ? String(o.number).padStart(2, '0') : String(o.number);
    doc.font(PDF_FONTS.monoBold).fontSize(9.5).fillColor(PDF_COLORS.petrol)
       .text(num, x, textY + 2, { lineBreak: false, characterSpacing: TRACK });
    x += doc.widthOfString(num, { characterSpacing: TRACK }) + 10;
  }

  const auxText = o.aux ? String(o.aux) : null;
  doc.font(PDF_FONTS.sans).fontSize(8);
  const auxW = auxText ? doc.widthOfString(auxText) : 0;

  doc.font(PDF_FONTS.sansBold).fontSize(12.5).fillColor(PDF_COLORS.ink)
     .text(String(o.title || ''), x, textY, {
       width: m + PDF_PAGE.contentW - x - (auxText ? auxW + 12 : 0),
       lineBreak: false,
       ellipsis: true,
       height: 16,
     });

  if (auxText) {
    doc.font(PDF_FONTS.sans).fontSize(8).fillColor(PDF_COLORS.textFaint)
       .text(auxText, m + PDF_PAGE.contentW - auxW, textY + 4, { lineBreak: false });
  }

  const nextY = textY + 22;
  doc.x = m; doc.y = nextY;
  return nextY;
}

// -- hairline tables ----------------------------------------------------------

/**
 * Column def: { key, label, w?, align?: 'left'|'right', numeric?, mono?,
 * bold?, color? }
 *  - numeric: right-aligned + mono (the figures voice); align:'right' alone
 *    right-aligns without switching to mono.
 *  - w: absolute pt or weight -- widths are scaled to fill the 504pt
 *    content width either way.
 */

/** Uppercase mono header labels over a 1.5pt ink rule. Returns y below. */
function drawTableHeader(doc, cols, y) {
  const m = PDF_PAGE.margin;
  const widths = scaledWidths(cols);

  doc.font(PDF_FONTS.mono).fontSize(HEADER_FS);
  let labelH = 0;
  cols.forEach((c, i) => {
    const h = doc.heightOfString(String(c.label || '').toUpperCase(),
      { width: Math.max(widths[i] - CELL_PAD * 2, 8), characterSpacing: TRACK, lineGap: 1 });
    if (h > labelH) labelH = h;
  });

  let x = m;
  doc.fillColor(PDF_COLORS.textFaint);
  cols.forEach((c, i) => {
    doc.text(String(c.label || '').toUpperCase(), x + CELL_PAD, y, {
      width: Math.max(widths[i] - CELL_PAD * 2, 8),
      align: isRight(c) ? 'right' : 'left',
      characterSpacing: TRACK,
      lineGap: 1,
    });
    x += widths[i];
  });

  const ruleY = y + labelH + 4;
  doc.moveTo(m, ruleY).lineTo(m + PDF_PAGE.contentW, ruleY)
     .lineWidth(1.5).strokeColor(PDF_COLORS.ink).stroke();
  doc.lineWidth(1);
  return ruleY + 4;
}

/** Measured row height for a data row (drawTable uses this to page-break). */
function measureTableRow(doc, cols, row) {
  const widths = scaledWidths(cols);
  let h = 0;
  cols.forEach((c, i) => {
    doc.font(cellFont(c)).fontSize(TABLE_FS);
    const cellH = doc.heightOfString(fmtCell(row[c.key]),
      { width: Math.max(widths[i] - CELL_PAD * 2, 8), lineGap: 1 });
    if (cellH > h) h = cellH;
  });
  return Math.max(h + CELL_PAD * 2, 14);
}

/**
 * One data row with a hairline bottom rule. No page-break logic -- callers
 * that manage their own loops break first, then call this. Returns y below.
 */
function drawTableRow(doc, cols, row, y) {
  const m = PDF_PAGE.margin;
  const widths = scaledWidths(cols);
  const h = measureTableRow(doc, cols, row);

  let x = m;
  cols.forEach((c, i) => {
    doc.font(cellFont(c)).fontSize(TABLE_FS)
       .fillColor(c.color || PDF_COLORS.ink)
       .text(fmtCell(row[c.key]), x + CELL_PAD, y + CELL_PAD, {
         width: Math.max(widths[i] - CELL_PAD * 2, 8),
         align: isRight(c) ? 'right' : 'left',
         lineGap: 1,
       });
    x += widths[i];
  });

  doc.moveTo(m, y + h).lineTo(m + PDF_PAGE.contentW, y + h)
     .lineWidth(0.5).strokeColor(PDF_COLORS.borderSubtle).stroke();
  doc.lineWidth(1);
  return y + h;
}

/**
 * Full table loop: header, measured page breaks with the header repeated on
 * every new page, per-row try/catch (one malformed row must not take the
 * document down -- empDocument pattern). Footer drawing on added pages is
 * the renderer's pageAdded listener's job (see attachFooter).
 *
 * opts: { cols, rows, y?, emptyText? }
 * Returns the y below the table (also sets doc.x/doc.y there).
 */
function drawTable(doc, opts) {
  const o = opts || {};
  const cols = o.cols || [];
  const rows = o.rows || [];
  const m = PDF_PAGE.margin;
  let y = o.y != null ? o.y : doc.y;

  if (!rows.length) {
    y = ensureSpace(doc, y, 16);
    doc.font(PDF_FONTS.sansOblique).fontSize(8.5).fillColor(PDF_COLORS.textMuted)
       .text(o.emptyText || 'None recorded.', m, y, { width: PDF_PAGE.contentW });
    const nextEmptyY = doc.y + 8;
    doc.x = m; doc.y = nextEmptyY;
    return nextEmptyY;
  }

  y = ensureSpace(doc, y, 40);
  y = drawTableHeader(doc, cols, y);

  for (const row of rows) {
    try {
      const h = measureTableRow(doc, cols, row);
      if (y + h > PDF_PAGE.bottom - 6) {
        doc.addPage();
        y = drawTableHeader(doc, cols, PDF_PAGE.margin);
      }
      y = drawTableRow(doc, cols, row, y);
    } catch (err) {
      try {
        console.error('[pdfStyle] table row render failed; skipping.',
          err && err.message ? err.message : err);
      } catch (_) { /* noop */ }
    }
  }

  const nextY = y + 10;
  doc.x = m; doc.y = nextY;
  return nextY;
}

// -- footer -------------------------------------------------------------------

/**
 * Mono footer below the bottom margin: hairline rule; left = brand +
 * generated timestamp + document id; right = "PAGE N" or "PAGE N OF M";
 * optional second line = "SHA-256 <hash>" when opts.integritySha256 is set
 * (the integrity slot -- omit it for documents that are not hash-anchored).
 *
 * opts: { generatedAtIso, docId?, brandName?, integritySha256? }
 * Call shape matches the existing renderers:
 * drawFooter(doc, opts, pageNum[, pageCount]).
 * Recursion-guarded and cursor-neutral (compliancePdf v0.36.8 pattern).
 */
function drawFooter(doc, opts, pageNum, pageCount?: number) {
  if (doc._renderingFooter) return;
  doc._renderingFooter = true;
  const sx = doc.x, sy = doc.y;
  try {
    const o = opts || {};
    const m = PDF_PAGE.margin;
    const y = doc.page.height - m + 10;

    doc.moveTo(m, y).lineTo(doc.page.width - m, y)
       .lineWidth(0.5).strokeColor(PDF_COLORS.border).stroke();
    doc.lineWidth(1);

    const left = [
      (o.brandName ? String(o.brandName) + ' — ' : '') + 'Generated by ServiceCycle',
      o.generatedAtIso ? String(o.generatedAtIso) : null,
      o.docId ? String(o.docId) : null,
    ].filter(Boolean).join(' — ');

    doc.font(PDF_FONTS.mono).fontSize(HEADER_FS).fillColor(PDF_COLORS.textFaint);
    const pageLabel = 'PAGE ' + pageNum + (pageCount ? ' OF ' + pageCount : '');
    const pw = doc.widthOfString(pageLabel, { characterSpacing: TRACK });
    doc.text(left, m, y + 4, {
      lineBreak: false,
      characterSpacing: 0.2,
      width: doc.page.width - m * 2 - pw - 12,
      ellipsis: true,
      height: 10,
    });
    doc.text(pageLabel, doc.page.width - m - pw, y + 4,
      { lineBreak: false, characterSpacing: TRACK });

    if (o.integritySha256) {
      doc.font(PDF_FONTS.mono).fontSize(6).fillColor(PDF_COLORS.textFaint)
         .text('SHA-256 ' + String(o.integritySha256), m, y + 14,
           { lineBreak: false });
    }
  } finally {
    doc.x = sx; doc.y = sy;
    doc._renderingFooter = false;
  }
}

/**
 * Standard footer wiring for renderers WITHOUT bufferPages: draws the page-1
 * footer now (pageAdded does not fire for page 1) and re-draws on every
 * pageAdded. Call it right after constructing the doc and binding the error
 * handler, before any content. Returns { pageNum } (live count).
 */
function attachFooter(doc, opts) {
  const state = { pageNum: 1 };
  doc.on('pageAdded', () => {
    state.pageNum += 1;
    drawFooter(doc, opts, state.pageNum);
  });
  drawFooter(doc, opts, 1);
  return state;
}

/**
 * "Page N of M" finishing pass for docs created with { bufferPages: true }:
 * stamps every buffered page's footer with the total. Call INSTEAD of
 * attachFooter, immediately before doc.end().
 */
function finalizeFooters(doc, opts) {
  const range = doc.bufferedPageRange();
  if (!range || isNaN(range.start) || !range.count) {
    throw new Error('finalizeFooters requires new PDFDocument({ bufferPages: true })');
  }
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawFooter(doc, opts, i + 1, range.count);
  }
}

module.exports = {
  PDF_COLORS,
  PDF_FONTS,
  PDF_PAGE,
  formatTimestamp,
  ensureSpace,
  drawMasthead,
  drawSectionHeading,
  drawTableHeader,
  drawTableRow,
  measureTableRow,
  drawTable,
  drawFooter,
  attachFooter,
  finalizeFooters,
};

export {};
