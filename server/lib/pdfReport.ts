/**
 * PDF rendering for the Executive Spend Report.
 *
 * Uses pdfkit (streaming, MIT) — chosen over pdf-lib because the report is
 * generated from scratch and pdf-lib's draw API is much more verbose for
 * multi-page tables with text wrapping. pdf-lib is the right tool for
 * MODIFYING existing PDFs; for streaming generation, pdfkit wins.
 *
 * Visual identity matches the LapseIQ daily digest email
 * (lib/alertEngine.js):
 *   - Dark header band (#0f172a) with white "LapseIQ" wordmark
 *   - Slate text on white pages, accent blue for links
 *   - Section dividers in light slate
 *   - Tables with dark header rows and zebra-stripe body rows
 *
 * Single function: streamExecutiveSpendPdf(res, data) — pipes a binary
 * application/pdf to the express response. Caller is responsible for
 * setting Content-Type and Content-Disposition headers BEFORE calling.
 */

'use strict';

const PDFDocument = require('pdfkit');

// ── Palette (matches the email digest) ────────────────────────────────────────
const COLORS: any = {
  bgDark:    '#0f172a',  // slate-900 — header band
  textOnDark:'#ffffff',
  textOnDarkMuted: '#94a3b8',
  text:      '#0f172a',
  textMuted: '#64748b',
  textSubtle:'#94a3b8',
  border:    '#e2e8f0',
  borderStrong: '#cbd5e1',
  accent:    '#0d4f6e',  // brand petrol — links, callouts (Pass-3 B V-01)
  cardBg:    '#f8fafc',
  zebra:     '#f8fafc',
  positive:  '#16a34a',  // green-600 — savings (negative delta is good)
  negative:  '#dc2626',  // red-600 — spend increase
};

const FONT_REG  = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}

function fmtPercent(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDate(d) {
  if (!d) return '—';
  // Render in UTC so the FY anchor dates (which are stored as midnight UTC)
  // don't slip a calendar day in negative-offset timezones.
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Stream the PDF to the response.
 *
 * data shape (from routes/reports.js):
 *   {
 *     companyName, generatedAt, generatedBy,
 *     currentFY: { label, start, end, totalSpend, contractCount },
 *     priorFY:   { label, start, end, totalSpend, contractCount },
 *     yoy: { absolute, percent },
 *     byVendor:     [ { vendorName, current, prior, delta, percent, contractCount } ],
 *     byDepartment: [ { department, current, prior, delta, percent, contractCount } ],
 *     topContracts: [ { product, vendorName, department, totalValue, endDate } ],
 *   }
 */
function streamExecutiveSpendPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    // Bottom margin must be small enough that the footer (drawn near
    // pageHeight - 36) lives INSIDE the writable area. With Letter
    // (792pt tall) and 8pt footer text (line height ~11), writable
    // bottom = 792 - 24 = 768 leaves headroom for a footer baseline
    // around y=755. Anything bigger here causes pdfkit to auto-
    // paginate inside drawFooters and produce a blank page per page.
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title: `LapseIQ Executive Spend Report — ${data.currentFY.label}`,
      Author: 'LapseIQ',
      Subject: 'Executive Spend Report',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });

  doc.pipe(res);

  // ── Header band ────────────────────────────────────────────────────────────
  drawHeaderBand(doc, data);

  // ── Summary cards ──────────────────────────────────────────────────────────
  doc.moveDown(0.5);
  drawSummaryCards(doc, data);

  // ── Vendor table ───────────────────────────────────────────────────────────
  doc.moveDown(1);
  drawSectionTitle(doc, 'Spend by Vendor', `Top ${Math.min(data.byVendor.length, 15)} of ${data.byVendor.length}`);
  drawComparisonTable(doc, {
    rows: data.byVendor.slice(0, 15),
    nameKey: 'vendorName',
    nameHeader: 'Vendor',
    countLabel: (r) => `${r.contractCount} contract${r.contractCount === 1 ? '' : 's'}`,
    currentLabel: data.currentFY.label,
    priorLabel:   data.priorFY.label,
  });

  // ── Department table ───────────────────────────────────────────────────────
  doc.moveDown(1);
  drawSectionTitle(doc, 'Spend by Department');
  drawComparisonTable(doc, {
    rows: data.byDepartment,
    nameKey: 'department',
    nameHeader: 'Department',
    countLabel: (r) => `${r.contractCount} contract${r.contractCount === 1 ? '' : 's'}`,
    currentLabel: data.currentFY.label,
    priorLabel:   data.priorFY.label,
  });

  // ── Top 10 contracts ───────────────────────────────────────────────────────
  doc.moveDown(1);
  drawSectionTitle(doc, `Top ${Math.min(data.topContracts.length, 10)} Contracts by Value`, data.currentFY.label);
  drawTopContractsTable(doc, data.topContracts.slice(0, 10));

  // ── Footer (every page) ────────────────────────────────────────────────────
  drawFooters(doc, data);

  doc.end();
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function drawHeaderBand(doc, data) {
  const pageWidth = doc.page.width;
  const headerHeight = 96;

  // Dark band edge-to-edge
  doc.save();
  doc.rect(0, 0, pageWidth, headerHeight).fill(COLORS.bgDark);
  doc.restore();

  // Wordmark + subtitle
  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_BOLD).fontSize(10);
  doc.text('LapseIQ — Executive Spend Report', 48, 22, { characterSpacing: 1.2 });

  doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(20);
  doc.text(`${data.currentFY.label} · ${data.companyName || 'Your Company'}`, 48, 38);

  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(10);
  const sub = `Period: ${fmtDate(data.currentFY.start)} – ${fmtDate(addOneDay(data.currentFY.end, -1))}` +
              `   ·   Generated: ${fmtDate(data.generatedAt)}` +
              (data.generatedBy ? `   ·   By: ${data.generatedBy}` : '');
  doc.text(sub, 48, 68);

  // Move cursor below the band
  doc.y = headerHeight + 12;
  doc.x = 48;
}

function drawSummaryCards(doc, data) {
  const startX = doc.x;
  const startY = doc.y;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 12;
  const cardWidth = (pageWidth - gap * 3) / 4;
  const cardHeight = 70;

  const yoyColor = data.yoy.absolute > 0 ? COLORS.negative
                 : data.yoy.absolute < 0 ? COLORS.positive
                 : COLORS.textMuted;

  const cards = [
    {
      label: `${data.currentFY.label} Spend`,
      value: fmtMoney(data.currentFY.totalSpend),
      subtitle: `${data.currentFY.contractCount} contracts`,
      valueColor: COLORS.text,
    },
    {
      label: `${data.priorFY.label} Spend`,
      value: fmtMoney(data.priorFY.totalSpend),
      subtitle: `${data.priorFY.contractCount} contracts`,
      valueColor: COLORS.text,
    },
    {
      label: 'YoY Change',
      value: fmtMoney(data.yoy.absolute),
      subtitle: fmtPercent(data.yoy.percent),
      valueColor: yoyColor,
    },
    {
      label: 'Top Vendor',
      value: data.byVendor[0]?.vendorName || '—',
      subtitle: data.byVendor[0]
        ? `${fmtMoney(data.byVendor[0].current)}`
        : '',
      valueColor: COLORS.text,
      smallValue: true,
    },
  ];

  cards.forEach((card, i) => {
    const x = startX + i * (cardWidth + gap);
    const y = startY;
    doc.save();
    doc.roundedRect(x, y, cardWidth, cardHeight, 4)
       .lineWidth(1)
       .fillAndStroke(COLORS.cardBg, COLORS.border);
    doc.restore();

    doc.fillColor(COLORS.textMuted).font(FONT_BOLD).fontSize(8);
    doc.text(card.label.toUpperCase(), x + 10, y + 10, {
      width: cardWidth - 20, characterSpacing: 0.6,
    });

    doc.fillColor(card.valueColor).font(FONT_BOLD).fontSize(card.smallValue ? 13 : 16);
    doc.text(card.value, x + 10, y + 26, {
      width: cardWidth - 20, ellipsis: true, lineBreak: false,
    });

    if (card.subtitle) {
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(9);
      doc.text(card.subtitle, x + 10, y + 50, {
        width: cardWidth - 20, ellipsis: true, lineBreak: false,
      });
    }
  });

  doc.y = startY + cardHeight + 4;
  doc.x = startX;
}

function drawSectionTitle(doc, title, hint?) {
  ensureSpace(doc, 36);
  const startY = doc.y;
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13);
  doc.text(title, doc.page.margins.left, startY);
  if (hint) {
    doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(9);
    const tw = doc.widthOfString(title);
    doc.text(hint, doc.page.margins.left + tw + 8, startY + 4);
  }
  // Underline accent
  doc.moveTo(doc.page.margins.left, startY + 18)
     .lineTo(doc.page.margins.left + 30, startY + 18)
     .lineWidth(2)
     .strokeColor(COLORS.accent)
     .stroke();
  doc.y = startY + 24;
}

/**
 * Generic vendor / department comparison table. Columns:
 *   Name | Contracts | Current FY | Prior FY | Change $ | Change %
 */
function drawComparisonTable(doc, opts) {
  const { rows, nameKey, nameHeader, countLabel, currentLabel, priorLabel } = opts;
  if (!rows.length) {
    drawEmptyState(doc, 'No data for this period.');
    return;
  }

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalWidth = right - left;

  // Column widths (sum should == totalWidth)
  const cols = [
    { key: 'name',     header: nameHeader,     width: totalWidth * 0.30, align: 'left'  },
    { key: 'count',    header: 'Contracts',    width: totalWidth * 0.12, align: 'right' },
    { key: 'current',  header: currentLabel,   width: totalWidth * 0.16, align: 'right' },
    { key: 'prior',    header: priorLabel,     width: totalWidth * 0.16, align: 'right' },
    { key: 'delta',    header: 'Change $',        width: totalWidth * 0.13, align: 'right' },
    { key: 'pct',      header: 'Change %',          width: totalWidth * 0.13, align: 'right' },
  ];

  drawTableHeader(doc, cols);

  rows.forEach((r, i) => {
    const renderRow = (yStart) => {
      const deltaColor = r.delta > 0 ? COLORS.negative
                       : r.delta < 0 ? COLORS.positive
                       : COLORS.text;
      const cells = [
        { text: r[nameKey] || '—', font: FONT_BOLD, color: COLORS.text },
        { text: countLabel(r),                       color: COLORS.textMuted },
        { text: fmtMoney(r.current),                 color: COLORS.text },
        { text: fmtMoney(r.prior),                   color: COLORS.textMuted },
        { text: fmtMoney(r.delta),                   color: deltaColor },
        { text: r.percent != null ? fmtPercent(r.percent) : '—', color: deltaColor },
      ];
      drawTableRow(doc, cols, cells, i, yStart);
    };
    drawRowWithPagination(doc, renderRow, cols);
  });
}

function drawTopContractsTable(doc, rows) {
  if (!rows.length) {
    drawEmptyState(doc, 'No contracts in this period.');
    return;
  }

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalWidth = right - left;

  const cols = [
    { key: 'rank',    header: '#',          width: totalWidth * 0.05, align: 'right' },
    { key: 'product', header: 'Product',    width: totalWidth * 0.30, align: 'left'  },
    { key: 'vendor',  header: 'Vendor',     width: totalWidth * 0.20, align: 'left'  },
    { key: 'dept',    header: 'Department', width: totalWidth * 0.18, align: 'left'  },
    { key: 'end',     header: 'Renewal',    width: totalWidth * 0.13, align: 'right' },
    { key: 'value',   header: 'Value',      width: totalWidth * 0.14, align: 'right' },
  ];

  drawTableHeader(doc, cols);

  rows.forEach((c, i) => {
    const renderRow = (yStart) => {
      const cells = [
        { text: String(i + 1), color: COLORS.textMuted },
        { text: c.product || '—',     font: FONT_BOLD, color: COLORS.text },
        { text: c.vendorName || '—',  color: COLORS.text },
        { text: c.department || '—',  color: COLORS.textMuted },
        { text: fmtDate(c.endDate),   color: COLORS.textMuted },
        { text: fmtMoney(c.totalValue), font: FONT_BOLD, color: COLORS.text },
      ];
      drawTableRow(doc, cols, cells, i, yStart);
    };
    drawRowWithPagination(doc, renderRow, cols);
  });
}

function drawTableHeader(doc, cols) {
  const left = doc.page.margins.left;
  const headerHeight = 22;
  const startY = doc.y;

  doc.save();
  doc.rect(left, startY, sumWidths(cols), headerHeight).fill(COLORS.bgDark);
  doc.restore();

  let x = left;
  cols.forEach((col) => {
    doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(9);
    doc.text(col.header, x + 8, startY + 7, {
      width: col.width - 16,
      align: col.align,
      lineBreak: false,
    });
    x += col.width;
  });

  doc.y = startY + headerHeight;
}

function drawTableRow(doc, cols, cells, rowIndex, yStart) {
  const left = doc.page.margins.left;
  const rowHeight = 22;

  if (rowIndex % 2 === 1) {
    doc.save();
    doc.rect(left, yStart, sumWidths(cols), rowHeight).fill(COLORS.zebra);
    doc.restore();
  }

  let x = left;
  cells.forEach((cell, ci) => {
    const col = cols[ci];
    doc.fillColor(cell.color || COLORS.text)
       .font(cell.font || FONT_REG)
       .fontSize(10);
    doc.text(cell.text, x + 8, yStart + 6, {
      width: col.width - 16,
      align: col.align,
      lineBreak: false,
      ellipsis: true,
    });
    x += col.width;
  });

  // Bottom border
  doc.moveTo(left, yStart + rowHeight)
     .lineTo(left + sumWidths(cols), yStart + rowHeight)
     .lineWidth(0.5)
     .strokeColor(COLORS.border)
     .stroke();

  doc.y = yStart + rowHeight;
}

function drawRowWithPagination(doc, renderRow, cols) {
  const rowHeight = 22;
  if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom - 24) {
    doc.addPage();
    // Re-draw the header band lite — just leave 24px top margin and re-draw
    // the table header so the table is comprehensible across pages.
    doc.y = doc.page.margins.top + 24;
    drawTableHeader(doc, cols);
  }
  renderRow(doc.y);
}

function drawEmptyState(doc, message) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const startY = doc.y;
  doc.save();
  doc.rect(left, startY, right - left, 40).fill(COLORS.cardBg);
  doc.restore();
  doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(10);
  doc.text(message, left, startY + 14, { width: right - left, align: 'center' });
  doc.y = startY + 40;
}

function drawFooters(doc, data) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    // Footer baseline must satisfy y + lineHeight <= pageHeight - bottomMargin
    // (Letter 792 - 24 = 768). 8pt font line height ~= 11, so y <= 757.
    const y = doc.page.height - 36;

    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8);
    doc.text(
      `LapseIQ Executive Spend Report · ${data.companyName || 'Your Company'} · ${data.currentFY.label}`,
      left, y, { width: right - left - 60, align: 'left', lineBreak: false }
    );
    doc.text(
      `Page ${i - range.start + 1} of ${range.count}`,
      right - 60, y, { width: 60, align: 'right', lineBreak: false }
    );
  }
}

function sumWidths(cols) {
  return cols.reduce((s, c) => s + c.width, 0);
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom - 24) {
    doc.addPage();
    doc.y = doc.page.margins.top + 24;
  }
}

function addOneDay(d, n) {
  if (!d) return d;
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

// ── Shared helpers for the new canned reports ─────────────────────────────────

/**
 * Generic dark header band — same visual as the exec spend report but with
 * a configurable title/subtitle line so every report looks consistent.
 */
function drawGenericHeader(doc, { reportLabel, title, meta }) {
  const pageWidth = doc.page.width;
  const headerHeight = 96;
  doc.save();
  doc.rect(0, 0, pageWidth, headerHeight).fill(COLORS.bgDark);
  doc.restore();

  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_BOLD).fontSize(10);
  doc.text(`LapseIQ — ${reportLabel}`, 48, 22, { characterSpacing: 1.2 });

  doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(18);
  doc.text(title, 48, 38);

  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(10);
  doc.text(meta, 48, 70);

  doc.y = headerHeight + 12;
  doc.x = 48;
}

/**
 * Generic card row — same look as drawSummaryCards but driven by an explicit
 * array of { label, value, subtitle?, valueColor? } objects.
 */
function drawSimpleSummaryCards(doc, cards) {
  const startX = doc.page.margins.left;
  const startY = doc.y;
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const n = Math.min(cards.length, 4);
  const gap = 12;
  const cardWidth = (pageWidth - gap * (n - 1)) / n;
  const cardHeight = 70;

  cards.slice(0, n).forEach((card, i) => {
    const x = startX + i * (cardWidth + gap);
    doc.save();
    doc.roundedRect(x, startY, cardWidth, cardHeight, 4)
       .lineWidth(1)
       .fillAndStroke(COLORS.cardBg, COLORS.border);
    doc.restore();

    doc.fillColor(COLORS.textMuted).font(FONT_BOLD).fontSize(8);
    doc.text(card.label.toUpperCase(), x + 10, startY + 10, {
      width: cardWidth - 20, characterSpacing: 0.6,
    });

    doc.fillColor(card.valueColor || COLORS.text).font(FONT_BOLD).fontSize(15);
    doc.text(card.value, x + 10, startY + 26, {
      width: cardWidth - 20, ellipsis: true, lineBreak: false,
    });

    if (card.subtitle) {
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(9);
      doc.text(card.subtitle, x + 10, startY + 50, {
        width: cardWidth - 20, ellipsis: true, lineBreak: false,
      });
    }
  });

  doc.y = startY + cardHeight + 4;
  doc.x = startX;
}

/**
 * Generic page footers — same pattern as drawFooters but configurable.
 */
function drawGenericFooters(doc, leftText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y     = doc.page.height - 36;
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8);
    doc.text(leftText, left, y, {
      width: right - left - 60, align: 'left', lineBreak: false,
    });
    doc.text(
      `Page ${i - range.start + 1} of ${range.count}`,
      right - 60, y, { width: 60, align: 'right', lineBreak: false }
    );
  }
}

// ── Renewal Horizon ────────────────────────────────────────────────────────────

const RISK_LABELS_PDF = {
  trap:   'Auto-Renewal Traps',
  urgent: 'Window Closing Soon  (≤ 14 days)',
  soon:   'Coming Up  (≤ 30 days)',
  ok:     'On Track',
};

function streamRenewalHorizonPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Renewal Horizon — Next ${data.horizon} Days`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Renewal Horizon Report',
    title:       `Next ${data.horizon} Days  ·  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   ·   By: ${data.generatedBy}` : ''),
  });

  const atRiskValue = [...(data.byRisk.trap || []), ...(data.byRisk.urgent || [])]
    .reduce((s, c) => s + (c.renewalValue || 0), 0);

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Total Renewing',     value: String(data.totalContracts),       subtitle: `Next ${data.horizon} days` },
    { label: 'At-Risk Value',      value: fmtMoney(atRiskValue),             subtitle: 'Traps + urgent', valueColor: atRiskValue > 0 ? COLORS.negative : COLORS.text },
    { label: 'Auto-Renewal Traps', value: String((data.byRisk.trap || []).length), subtitle: 'Cancel window closed', valueColor: (data.byRisk.trap || []).length > 0 ? COLORS.negative : COLORS.text },
    { label: 'Pipeline Value',     value: fmtMoney(data.totalValue),         subtitle: `${data.totalContracts} contracts` },
  ]);

  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = [
    { key: 'vendor',   header: 'Vendor',        width: totalWidth * 0.19, align: 'left'  },
    { key: 'product',  header: 'Product',        width: totalWidth * 0.19, align: 'left'  },
    { key: 'category', header: 'Category',       width: totalWidth * 0.14, align: 'left'  },
    { key: 'end',      header: 'End Date',       width: totalWidth * 0.12, align: 'right' },
    { key: 'cancel',   header: 'Cancel By',      width: totalWidth * 0.12, align: 'right' },
    { key: 'value',    header: 'Annual Value',   width: totalWidth * 0.14, align: 'right' },
    { key: 'owner',    header: 'Owner',          width: totalWidth * 0.10, align: 'left'  },
  ];

  for (const riskKey of ['trap', 'urgent', 'soon', 'ok']) {
    const rows = data.byRisk[riskKey] || [];
    if (!rows.length) continue;
    doc.moveDown(0.8);
    drawSectionTitle(doc, RISK_LABELS_PDF[riskKey], `${rows.length} contract${rows.length === 1 ? '' : 's'}`);
    drawTableHeader(doc, cols);
    rows.forEach((c, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: c.vendorName  || '—', font: FONT_BOLD, color: COLORS.text },
          { text: c.product     || '—',                  color: COLORS.text },
          { text: c.categoryName|| '—',                  color: COLORS.textMuted },
          { text: fmtDate(c.endDate),                    color: COLORS.text },
          { text: fmtDate(c.cancelByDate),               color: riskKey === 'trap' ? COLORS.negative : COLORS.text },
          { text: fmtMoney(c.renewalValue), font: FONT_BOLD, color: COLORS.text },
          { text: c.ownerDisplay|| '—',                  color: COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  if (data.totalContracts === 0) {
    drawEmptyState(doc, 'No contracts renewing in this window.');
  }

  drawGenericFooters(doc, `LapseIQ Renewal Horizon  ·  ${data.companyName || 'Your Company'}  ·  Next ${data.horizon} days`);
  doc.end();
}

// ── Risk Radar ─────────────────────────────────────────────────────────────────

function streamRiskRadarPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Risk Radar`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Risk Radar Report',
    title:       `${data.companyName || 'Your Company'}  ·  ${data.totalIssues} issue${data.totalIssues === 1 ? '' : 's'} found`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   ·   By: ${data.generatedBy}` : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Auto-Renewal Traps',    value: String((data.traps || []).length),          subtitle: 'Cancel window passed',        valueColor: (data.traps || []).length > 0 ? COLORS.negative : COLORS.text },
    { label: 'Expired Still Active',  value: String((data.expiredActive || []).length),  subtitle: 'End date passed, still active', valueColor: (data.expiredActive || []).length > 0 ? COLORS.warning || '#d97706' : COLORS.text },
    { label: 'Co-term Misalignments', value: String((data.coTermMisaligned || []).length), subtitle: '>30-day date spread',         valueColor: (data.coTermMisaligned || []).length > 0 ? '#7c3aed' : COLORS.text },
    { label: 'Total Issues',          value: String(data.totalIssues),                   subtitle: 'Across all categories',         valueColor: data.totalIssues > 0 ? COLORS.negative : COLORS.positive },
  ]);

  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const baseCols = [
    { key: 'vendor',   header: 'Vendor',       width: totalWidth * 0.22, align: 'left'  },
    { key: 'product',  header: 'Product',       width: totalWidth * 0.20, align: 'left'  },
    { key: 'category', header: 'Category',      width: totalWidth * 0.16, align: 'left'  },
    { key: 'value',    header: 'Annual Value',  width: totalWidth * 0.14, align: 'right' },
    { key: 'owner',    header: 'Owner',         width: totalWidth * 0.12, align: 'left'  },
  ];

  // Traps
  if ((data.traps || []).length > 0) {
    doc.moveDown(0.8);
    drawSectionTitle(doc, 'Auto-Renewal Traps', `${data.traps.length} contract${data.traps.length === 1 ? '' : 's'}`);
    const cols = [
      ...baseCols.slice(0, 3),
      { key: 'cancelBy',  header: 'Cancel-By (passed)', width: totalWidth * 0.16, align: 'right' },
      ...baseCols.slice(3),
    ];
    drawTableHeader(doc, cols);
    data.traps.forEach((c, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: c.vendorName  || '—', font: FONT_BOLD, color: COLORS.text },
          { text: c.product     || '—',                  color: COLORS.text },
          { text: c.categoryName|| '—',                  color: COLORS.textMuted },
          { text: fmtDate(c.cancelByDate),               color: COLORS.negative },
          { text: fmtMoney(c.renewalValue), font: FONT_BOLD, color: COLORS.text },
          { text: c.ownerDisplay|| '—',                  color: COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  // Expired still active
  if ((data.expiredActive || []).length > 0) {
    doc.moveDown(0.8);
    drawSectionTitle(doc, 'Expired Contracts (Status: Active)', `${data.expiredActive.length} contract${data.expiredActive.length === 1 ? '' : 's'}`);
    const cols = [
      ...baseCols.slice(0, 3),
      { key: 'endDate',  header: 'Expired On', width: totalWidth * 0.16, align: 'right' },
      ...baseCols.slice(3),
    ];
    drawTableHeader(doc, cols);
    data.expiredActive.forEach((c, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: c.vendorName  || '—', font: FONT_BOLD, color: COLORS.text },
          { text: c.product     || '—',                  color: COLORS.text },
          { text: c.categoryName|| '—',                  color: COLORS.textMuted },
          { text: fmtDate(c.endDate),                    color: '#d97706' },
          { text: fmtMoney(c.renewalValue), font: FONT_BOLD, color: COLORS.text },
          { text: c.ownerDisplay|| '—',                  color: COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  // Co-term misalignments
  if ((data.coTermMisaligned || []).length > 0) {
    doc.moveDown(0.8);
    drawSectionTitle(doc, 'Co-term Misalignments', `${data.coTermMisaligned.length} group${data.coTermMisaligned.length === 1 ? '' : 's'}`);
    const cols = [
      ...baseCols.slice(0, 3),
      { key: 'endDate', header: 'End Date', width: totalWidth * 0.16, align: 'right' },
      ...baseCols.slice(3),
    ];
    data.coTermMisaligned.forEach(group => {
      doc.moveDown(0.4);
      ensureSpace(doc, 18);
      doc.fillColor('#7c3aed').font(FONT_BOLD).fontSize(10);
      doc.text(`Group: ${group.groupName}  ·  ${group.divergeDays}-day spread`, doc.page.margins.left, doc.y);
      doc.y += 14;
      drawTableHeader(doc, cols);
      (group.members || []).forEach((c, i) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, cols, [
            { text: c.vendorName  || '—', font: FONT_BOLD, color: COLORS.text },
            { text: c.product     || '—',                  color: COLORS.text },
            { text: c.categoryName|| '—',                  color: COLORS.textMuted },
            { text: fmtDate(c.endDate),                    color: COLORS.text },
            { text: fmtMoney(c.renewalValue), font: FONT_BOLD, color: COLORS.text },
            { text: c.ownerDisplay|| '—',                  color: COLORS.textMuted },
          ], i, yStart);
        }, cols);
      });
    });
  }

  if (data.totalIssues === 0) {
    drawEmptyState(doc, 'No risks detected — no auto-renewal traps, expired contracts, or co-term misalignments.');
  }

  drawGenericFooters(doc, `LapseIQ Risk Radar  ·  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// ── Savings Ledger ─────────────────────────────────────────────────────────────

function streamSavingsLedgerPdf(res, data, periodLabel) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Savings Ledger — ${periodLabel}`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Savings Ledger Report',
    title:       `${periodLabel}  ·  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   ·   By: ${data.generatedBy}` : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Total Savings',    value: fmtMoney(data.totalSavings),    subtitle: `${data.totalContracts} contracts`, valueColor: COLORS.positive },
    { label: 'Total Ask',        value: fmtMoney(data.totalAsk),        subtitle: 'Vendor initial quotes' },
    { label: 'Total Negotiated', value: fmtMoney(data.totalNegotiated), subtitle: 'What was agreed' },
    { label: 'Blended Rate',     value: data.blendedSavingsPct != null ? `${data.blendedSavingsPct > 0 ? '+' : ''}${data.blendedSavingsPct.toFixed(1)}%` : '—', subtitle: 'Avg savings %', valueColor: (data.blendedSavingsPct || 0) > 0 ? COLORS.positive : COLORS.text },
  ]);

  // By category summary
  if ((data.byCategory || []).length > 0) {
    doc.moveDown(0.8);
    drawSectionTitle(doc, 'Savings by Category');
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const catCols = [
      { key: 'cat',      header: 'Category',      width: totalWidth * 0.40, align: 'left'  },
      { key: 'count',    header: 'Contracts',      width: totalWidth * 0.15, align: 'right' },
      { key: 'savings',  header: 'Savings',        width: totalWidth * 0.20, align: 'right' },
      { key: 'rate',     header: 'Avg Rate',       width: totalWidth * 0.25, align: 'right' },
    ];
    drawTableHeader(doc, catCols);
    (data.byCategory || []).forEach((c, i) => {
      const avgSavingsPct = c.totalAsk > 0 ? (c.savings / c.totalAsk) * 100 : null;
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, catCols, [
          { text: c.categoryName || '—', font: FONT_BOLD, color: COLORS.text },
          { text: String(c.count || '—'), color: COLORS.textMuted },
          { text: fmtMoney(c.savings), font: FONT_BOLD, color: COLORS.positive },
          { text: avgSavingsPct != null ? `${avgSavingsPct.toFixed(1)}%` : '—', color: COLORS.textMuted },
        ], i, yStart);
      }, catCols);
    });
  }

  // Contract ledger
  if ((data.rows || []).length > 0) {
    doc.moveDown(0.8);
    drawSectionTitle(doc, 'Contract Ledger', `${data.rows.length} records`);
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rowCols = [
      { key: 'vendor',   header: 'Vendor',         width: totalWidth * 0.18, align: 'left'  },
      { key: 'product',  header: 'Product',         width: totalWidth * 0.18, align: 'left'  },
      { key: 'category', header: 'Category',        width: totalWidth * 0.14, align: 'left'  },
      { key: 'ask',      header: 'Original Ask',    width: totalWidth * 0.13, align: 'right' },
      { key: 'final',    header: 'Final Price',     width: totalWidth * 0.13, align: 'right' },
      { key: 'savings',  header: 'Savings $',       width: totalWidth * 0.12, align: 'right' },
      { key: 'pct',      header: 'Savings %',       width: totalWidth * 0.07, align: 'right' },
      { key: 'owner',    header: 'Owner',           width: totalWidth * 0.05, align: 'left'  },
    ];
    drawTableHeader(doc, rowCols);
    (data.rows || []).forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, rowCols, [
          { text: r.vendorName || '—',    font: FONT_BOLD, color: COLORS.text },
          { text: r.product || '—',                        color: COLORS.text },
          { text: r.categoryName || '—',                   color: COLORS.textMuted },
          { text: fmtMoney(r.originalAsk),                 color: COLORS.textMuted },
          { text: fmtMoney(r.finalNegotiatedPrice),        color: COLORS.text },
          { text: fmtMoney(r.savings),    font: FONT_BOLD, color: r.savings > 0 ? COLORS.positive : r.savings < 0 ? COLORS.negative : COLORS.text },
          { text: r.savingsPct != null ? `${r.savingsPct.toFixed(1)}%` : '—', color: r.savingsPct > 0 ? COLORS.positive : COLORS.textMuted },
          { text: r.ownerDisplay || '—',                   color: COLORS.textMuted },
        ], i, yStart);
      }, rowCols);
    });
  } else {
    drawEmptyState(doc, 'No savings data for this period.');
  }

  drawGenericFooters(doc, `LapseIQ Savings Ledger  ·  ${data.companyName || 'Your Company'}  ·  ${periodLabel}`);
  doc.end();
}

// ── License Wastage ────────────────────────────────────────────────────────────

function streamLicenseWastagePdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ License Wastage Report`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'License Wastage Report',
    title:       `${data.companyName || 'Your Company'}  ·  Seat utilization & waste estimate`,
    meta:        `${data.coverageCount} of ${data.totalActiveContracts} active contracts have utilization data` +
                 `   ·   Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   ·   By: ${data.generatedBy}` : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    {
      label: 'Est. Annual Waste',
      value: fmtMoney(data.totalEstimatedWaste),
      subtitle: data.wastePctOfAnnual != null ? "${data.wastePctOfAnnual.toFixed(1)}% of measured annual" : 'Based on entered seat data',
      valueColor: (data.totalEstimatedWaste || 0) > 0 ? COLORS.negative : COLORS.text,
    },
    {
      label: 'Biggest Waste',
      value: data.biggestWasteVendor ? fmtMoney(data.biggestWasteVendor.wasteValue) : '-',
      subtitle: data.biggestWasteVendor ? data.biggestWasteVendor.vendorName : 'No vendor flagged',
      valueColor: data.biggestWasteVendor ? COLORS.negative : COLORS.text,
    },
    {
      label: 'Avg Utilization',
      value: data.avgUtilization != null ? `${data.avgUtilization.toFixed(0)}%` : '—',
      subtitle: 'Across contracts with data',
      valueColor: data.avgUtilization != null
        ? (data.avgUtilization >= 80 ? COLORS.positive : data.avgUtilization >= 50 ? '#d97706' : COLORS.negative)
        : COLORS.text,
    },
    {
      label: 'Coverage',
      value: `${data.coverageCount} / ${data.totalActiveContracts}`,
      subtitle: 'Contracts with utilization data',
    },
  ]);

  if ((data.rows || []).length === 0) {
    drawEmptyState(doc, 'No utilization data entered. Add seats licensed and seats in use on active contracts.');
  } else {
    doc.moveDown(0.8);
    // v0.60 Dollarized: vendor + category rollups first so the eye lands
    // on the worst offenders before diving into the per-contract table.
    if ((data.byVendor || []).length > 0) {
      ensureSpace(doc, 60);
      drawSectionTitle(doc, 'Top vendors by waste', 'sum of estimated waste across all contracts');
      const totalWidthV = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const vcols = [
        { key: 'v', header: 'Vendor',          width: totalWidthV * 0.40, align: 'left'  },
        { key: 'c', header: 'Contracts',       width: totalWidthV * 0.12, align: 'right' },
        { key: 's', header: 'Waste Seats',     width: totalWidthV * 0.14, align: 'right' },
        { key: 'a', header: 'Annual Value',    width: totalWidthV * 0.16, align: 'right' },
        { key: 'w', header: 'Estimated Waste', width: totalWidthV * 0.18, align: 'right' },
      ];
      drawTableHeader(doc, vcols);
      (data.byVendor || []).slice(0, 10).forEach((v, i) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, vcols, [
            { text: v.vendorName,            font: FONT_BOLD, color: COLORS.text },
            { text: String(v.contractCount || 0),              color: COLORS.textMuted },
            { text: String(v.wasteSeats || 0),                 color: v.wasteSeats > 0 ? COLORS.negative : COLORS.textMuted },
            { text: fmtMoney(v.annualValue),                   color: COLORS.text },
            { text: fmtMoney(v.wasteValue), font: FONT_BOLD,   color: v.wasteValue > 0 ? COLORS.negative : COLORS.text },
          ], i, yStart);
        }, vcols);
      });
      doc.moveDown(0.6);
    }

    if ((data.byCategory || []).length > 0) {
      ensureSpace(doc, 60);
      drawSectionTitle(doc, 'By category', (data.byCategory || []).length + ' categor' + ((data.byCategory || []).length === 1 ? 'y' : 'ies') + ' with utilization data');
      const totalWidthC = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const ccols = [
        { key: 'cat', header: 'Category',        width: totalWidthC * 0.40, align: 'left'  },
        { key: 'v',   header: 'Vendors',         width: totalWidthC * 0.12, align: 'right' },
        { key: 'cn',  header: 'Contracts',       width: totalWidthC * 0.12, align: 'right' },
        { key: 'av',  header: 'Annual Value',    width: totalWidthC * 0.18, align: 'right' },
        { key: 'w',   header: 'Estimated Waste', width: totalWidthC * 0.18, align: 'right' },
      ];
      drawTableHeader(doc, ccols);
      (data.byCategory || []).forEach((cat, i) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, ccols, [
            { text: cat.categoryName,         font: FONT_BOLD, color: COLORS.text },
            { text: String(cat.vendorCount || 0),              color: COLORS.textMuted },
            { text: String(cat.contractCount || 0),            color: COLORS.textMuted },
            { text: fmtMoney(cat.annualValue),                 color: COLORS.text },
            { text: fmtMoney(cat.wasteValue), font: FONT_BOLD, color: cat.wasteValue > 0 ? COLORS.negative : COLORS.text },
          ], i, yStart);
        }, ccols);
      });
      doc.moveDown(0.6);
    }

    ensureSpace(doc, 60);
    drawSectionTitle(doc, 'Wastage Detail', 'sorted by estimated waste value');
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'vendor',    header: 'Vendor',         width: totalWidth * 0.17, align: 'left'  },
      { key: 'product',   header: 'Product',         width: totalWidth * 0.17, align: 'left'  },
      { key: 'licensed',  header: 'Licensed',        width: totalWidth * 0.09, align: 'right' },
      { key: 'inUse',     header: 'In Use',          width: totalWidth * 0.09, align: 'right' },
      { key: 'util',      header: 'Utilization',     width: totalWidth * 0.10, align: 'right' },
      { key: 'waste',     header: 'Waste Seats',     width: totalWidth * 0.09, align: 'right' },
      { key: 'annual',    header: 'Annual Value',    width: totalWidth * 0.13, align: 'right' },
      { key: 'estWaste',  header: 'Est. Waste',      width: totalWidth * 0.13, align: 'right' },
      { key: 'owner',     header: 'Owner',           width: totalWidth * 0.03, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    (data.rows || []).forEach((r, i) => {
      const utilColor = r.utilizationPct >= 80 ? COLORS.positive
                      : r.utilizationPct >= 50 ? '#d97706'
                      : COLORS.negative;
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: r.vendorName || '—', font: FONT_BOLD, color: COLORS.text },
          { text: r.product || '—',                     color: COLORS.text },
          { text: String(r.seatsLicensed ?? '—'),       color: COLORS.textMuted },
          { text: String(r.seatsActivelyInUse ?? '—'),  color: COLORS.textMuted },
          { text: `${r.utilizationPct.toFixed(0)}%`, font: FONT_BOLD, color: utilColor },
          { text: String(r.wasteSeats ?? 0),             color: r.wasteSeats > 0 ? COLORS.negative : COLORS.textMuted },
          { text: fmtMoney(r.annualValue),               color: COLORS.text },
          { text: fmtMoney(r.estimatedWasteValue), font: FONT_BOLD, color: r.estimatedWasteValue > 0 ? COLORS.negative : COLORS.text },
          { text: r.ownerDisplay || '—',                 color: COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ License Wastage  ·  ${data.companyName || 'Your Company'}  ·  Manual utilization data`);
  doc.end();
}

// ── Spend Ledger ───────────────────────────────────────────────────────────────

function streamSpendLedgerPdf(res, data) {
  const isCommitments = data.mode === 'commitments';
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Spend Ledger — ${data.fyLabel} ${isCommitments ? 'Commitments' : 'Actuals'}`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Spend Ledger Report',
    title:       `${data.fyLabel}  ·  ${isCommitments ? 'Commitments' : 'Actuals'}  ·  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   ·   By: ${data.generatedBy}` : ''),
  });

  // Summary cards
  doc.moveDown(0.5);
  const summaryCards: any[] = [
    {
      label: `${data.fyLabel} Spend`,
      value: fmtMoney(data.totalSpend),
      subtitle: isCommitments ? `${data.contractCount ?? ''} contracts` : `${data.totalPOs ?? ''} POs`,
    },
  ];
  if (isCommitments && data.priorSpend != null) {
    summaryCards.push({ label: `${data.priorFYLabel} Spend`, value: fmtMoney(data.priorSpend), subtitle: 'Prior FY' });
  }
  if (isCommitments && data.yoy) {
    const yoyColor = data.yoy.absolute > 0 ? COLORS.negative : data.yoy.absolute < 0 ? COLORS.positive : COLORS.textMuted;
    summaryCards.push({
      label: 'YoY Change',
      value: fmtMoney(data.yoy.absolute),
      subtitle: data.yoy.percent != null ? `${data.yoy.percent > 0 ? '+' : ''}${data.yoy.percent.toFixed(1)}%` : '—',
      valueColor: yoyColor,
    });
  }
  drawSimpleSummaryCards(doc, summaryCards);

  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const hasPrior = isCommitments;

  // Spend table helper
  function drawSpendSection(title, rows, nameKey, nameHeader) {
    if (!rows || !rows.length) return;
    doc.moveDown(0.8);
    drawSectionTitle(doc, title, `${rows.length} rows`);
    const cols = hasPrior ? [
      { key: 'name',    header: nameHeader,         width: totalWidth * 0.28, align: 'left'  },
      { key: 'count',   header: 'Contracts',         width: totalWidth * 0.12, align: 'right' },
      { key: 'current', header: data.fyLabel,         width: totalWidth * 0.16, align: 'right' },
      { key: 'prior',   header: data.priorFYLabel,    width: totalWidth * 0.16, align: 'right' },
      { key: 'delta',   header: 'Change $',           width: totalWidth * 0.14, align: 'right' },
      { key: 'pct',     header: 'Change %',           width: totalWidth * 0.14, align: 'right' },
    ] : [
      { key: 'name',    header: nameHeader,           width: totalWidth * 0.40, align: 'left'  },
      { key: 'count',   header: 'POs',                width: totalWidth * 0.15, align: 'right' },
      { key: 'current', header: data.fyLabel,          width: totalWidth * 0.25, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      const deltaColor = r.delta > 0 ? COLORS.negative : r.delta < 0 ? COLORS.positive : COLORS.text;
      drawRowWithPagination(doc, (yStart) => {
        const cells = hasPrior ? [
          { text: r[nameKey] || r.categoryName || '—', font: FONT_BOLD, color: COLORS.text },
          { text: String(r.contractCount ?? '—'), color: COLORS.textMuted },
          { text: fmtMoney(r.current ?? r.spend), font: FONT_BOLD, color: COLORS.text },
          { text: fmtMoney(r.prior), color: COLORS.textMuted },
          { text: fmtMoney(r.delta), font: FONT_BOLD, color: deltaColor },
          { text: r.percent != null ? fmtPercent(r.percent) : '—', color: deltaColor },
        ] : [
          { text: r[nameKey] || r.categoryName || '—', font: FONT_BOLD, color: COLORS.text },
          { text: String(r.poCount ?? '—'), color: COLORS.textMuted },
          { text: fmtMoney(r.spend), font: FONT_BOLD, color: COLORS.text },
        ];
        drawTableRow(doc, cols, cells, i, yStart);
      }, cols);
    });
  }

  drawSpendSection('Spend by Vendor',     data.byVendor     || [], 'vendorName',  'Vendor');
  drawSpendSection('Spend by Category',   data.byCategory   || [], 'categoryName','Category');
  drawSpendSection('Spend by Department', data.byDepartment || [], 'department',  'Department');

  drawGenericFooters(doc, `LapseIQ Spend Ledger  ·  ${data.companyName || 'Your Company'}  ·  ${data.fyLabel} ${isCommitments ? 'Commitments' : 'Actuals'}`);
  doc.end();
}

// v0.58.1 PDF streamers for the three Tier-1 white-space reports added in
// v0.58.0. Each mirrors the on-screen "KPI band -> section title -> detail
// table" layout from client/src/pages/{AutoRenewalExposure,VendorConcentration,
// NonSaaSCategory}Report.jsx, cropped to 8.5x11 letter. Each reuses the
// existing drawGenericHeader / drawSimpleSummaryCards / drawSectionTitle /
// drawTableHeader / drawTableRow / drawRowWithPagination / drawEmptyState /
// drawGenericFooters / fmt* helpers from earlier in the file - no new
// templating system, no new module dependencies.

// -- Auto-Renewal Exposure ----------------------------------------------------

function streamAutoRenewalExposurePdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Auto-Renewal Exposure - Next ${data.horizon} Days`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Auto-Renewal Exposure',
    title:       `Next ${data.horizon} Days  -  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Total Exposure',  value: fmtMoney(data.totalExposure),    subtitle: `${data.totalContracts} contract${data.totalContracts === 1 ? '' : 's'}`, valueColor: data.totalExposure > 0 ? COLORS.negative : COLORS.text },
    { label: 'Critical (<=7d)', value: String(data.criticalCount || 0), subtitle: fmtMoney(data.criticalExposure), valueColor: data.criticalCount > 0 ? COLORS.negative : COLORS.text },
    { label: 'Warning (<=30d)', value: String(data.warningCount  || 0), subtitle: fmtMoney(data.warningExposure),  valueColor: data.warningCount  > 0 ? '#d97706'        : COLORS.text },
    { label: 'Horizon',         value: `${data.horizon}d`,              subtitle: 'Cancel window' },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Contracts entering cancel window', `${rows.length} row${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No auto-renewing contracts in the selected window.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'vendor',  header: 'Vendor',        width: totalWidth * 0.18, align: 'left'  },
      { key: 'product', header: 'Product',       width: totalWidth * 0.20, align: 'left'  },
      { key: 'cancel',  header: 'Cancel By',     width: totalWidth * 0.12, align: 'right' },
      { key: 'days',    header: 'Days Left',     width: totalWidth * 0.09, align: 'right' },
      { key: 'value',   header: 'Renewal Value', width: totalWidth * 0.15, align: 'right' },
      { key: 'risk',    header: 'Risk',          width: totalWidth * 0.10, align: 'left'  },
      { key: 'owner',   header: 'Owner',         width: totalWidth * 0.16, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const riskColor = r.risk === 'critical' ? COLORS.negative
                        : r.risk === 'warning'  ? '#d97706'
                        : COLORS.textMuted;
        const riskLabel = r.risk === 'critical' ? 'Critical'
                        : r.risk === 'warning'  ? 'Warning'
                        : 'OK';
        const daysCellColor = r.risk === 'critical' ? COLORS.negative : COLORS.text;
        drawTableRow(doc, cols, [
          { text: r.vendorName || '-', font: FONT_BOLD,  color: COLORS.text },
          { text: r.product    || '-',                   color: COLORS.text },
          { text: fmtDate(r.cancelByDate),               color: COLORS.text },
          { text: r.daysToCancelBy != null ? String(r.daysToCancelBy) : '-', color: daysCellColor },
          { text: fmtMoney(r.renewalValue), font: FONT_BOLD, color: COLORS.text },
          { text: riskLabel,                font: FONT_BOLD, color: riskColor },
          { text: r.ownerDisplay || '-',                  color: COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Auto-Renewal Exposure  -  ${data.companyName || 'Your Company'}  -  Next ${data.horizon} days`);
  doc.end();
}

// -- Vendor Concentration (Pareto) --------------------------------------------

function streamVendorConcentrationPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Vendor Concentration - ${data.rangeLabel}`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Vendor Concentration (Pareto)',
    title:       `${data.rangeLabel}  -  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  // Top-5-share color heuristic: >= 80% = concentration risk (red),
  // 60-80% = elevated (amber), below 60% = neutral.
  const top5Color = (data.top5Pct || 0) >= 80 ? COLORS.negative
                  : (data.top5Pct || 0) >= 60 ? '#d97706'
                  : COLORS.text;
  drawSimpleSummaryCards(doc, [
    { label: 'Total Spend',       value: fmtMoney(data.totalSpend),                                    subtitle: `${data.vendorCount} vendor${data.vendorCount === 1 ? '' : 's'}` },
    { label: 'Top 5 Share',       value: data.top5Pct  != null ? `${data.top5Pct.toFixed(1)}%`  : '-', subtitle: fmtMoney(data.top5Spend),  valueColor: top5Color },
    { label: 'Top 10 Share',      value: data.top10Pct != null ? `${data.top10Pct.toFixed(1)}%` : '-', subtitle: fmtMoney(data.top10Spend) },
    { label: '80% Pareto Cutoff', value: data.headCount != null ? String(data.headCount) : '-',       subtitle: `${data.tailCount || 0} vendor${(data.tailCount || 0) === 1 ? '' : 's'} in tail` },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Vendor ranking by spend', `${rows.length} vendor${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No vendor spend recorded for this period.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'rank',      header: '#',            width: totalWidth * 0.06, align: 'right' },
      { key: 'vendor',    header: 'Vendor',       width: totalWidth * 0.38, align: 'left'  },
      { key: 'contracts', header: 'Contracts',    width: totalWidth * 0.11, align: 'right' },
      { key: 'spend',     header: 'Spend',        width: totalWidth * 0.17, align: 'right' },
      { key: 'pct',       header: 'Share %',      width: totalWidth * 0.12, align: 'right' },
      { key: 'cum',       header: 'Cumulative %', width: totalWidth * 0.16, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        // Highlight the head of the distribution (vendors at or below 80% cumulative)
        // by keeping their name in full-strength text; tail rows go muted.
        const inHead = data.cutoffIdx != null ? i <= data.cutoffIdx : true;
        drawTableRow(doc, cols, [
          { text: String(r.rank ?? i + 1),                              color: COLORS.textMuted },
          { text: r.vendorName || '-',           font: FONT_BOLD,       color: inHead ? COLORS.text : COLORS.textMuted },
          { text: String(r.contractCount ?? 0),                         color: COLORS.textMuted },
          { text: fmtMoney(r.spend),             font: FONT_BOLD,       color: COLORS.text },
          { text: r.pct != null ? `${r.pct.toFixed(1)}%` : '-',         color: COLORS.text },
          {
            text: r.cumulativePct != null ? `${r.cumulativePct.toFixed(1)}%` : '-',
            color: r.atCutoff ? COLORS.accent : COLORS.textMuted,
            font:  r.atCutoff ? FONT_BOLD     : FONT_REG,
          },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Vendor Concentration  -  ${data.companyName || 'Your Company'}  -  ${data.rangeLabel}`);
  doc.end();
}

// -- Non-SaaS Category Breakdown ----------------------------------------------

function streamNonSaaSCategoriesPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Non-SaaS Category Breakdown`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Non-SaaS Category Breakdown',
    title:       `${data.companyName || 'Your Company'}  -  Beyond SaaS visibility`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Non-SaaS Spend',  value: fmtMoney(data.totalSpend),           subtitle: 'Active contracts' },
    { label: 'Categories',      value: String(data.categoryCount || 0),     subtitle: 'With active contracts' },
    { label: 'Contracts',       value: String(data.totalContracts || 0),    subtitle: 'Non-SaaS only' },
    { label: 'Expiring <=90d',  value: String(data.expiringSoonCount || 0), subtitle: 'Across categories', valueColor: (data.expiringSoonCount || 0) > 0 ? '#d97706' : COLORS.text },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Category breakdown', `${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No active non-SaaS contracts found.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'category',  header: 'Category',    width: totalWidth * 0.34, align: 'left'  },
      { key: 'spend',     header: 'Spend',       width: totalWidth * 0.16, align: 'right' },
      { key: 'share',     header: 'Share %',     width: totalWidth * 0.12, align: 'right' },
      { key: 'contracts', header: 'Contracts',   width: totalWidth * 0.10, align: 'right' },
      { key: 'vendors',   header: 'Vendors',     width: totalWidth * 0.10, align: 'right' },
      { key: 'expiring',  header: 'Exp. <=90d',  width: totalWidth * 0.18, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: r.categoryName || '-', font: FONT_BOLD, color: COLORS.text },
          { text: fmtMoney(r.spend),     font: FONT_BOLD, color: COLORS.text },
          { text: r.sharePct != null ? `${r.sharePct.toFixed(1)}%` : '-',  color: COLORS.text },
          { text: String(r.contractCount ?? 0),                            color: COLORS.textMuted },
          { text: String(r.vendorCount ?? 0),                              color: COLORS.textMuted },
          {
            text: r.expiringSoon > 0 ? String(r.expiringSoon) : '-',
            color: r.expiringSoon > 0 ? '#d97706' : COLORS.textMuted,
            font:  r.expiringSoon > 0 ? FONT_BOLD : FONT_REG,
          },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Non-SaaS Category Breakdown  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}


// ── v0.59.0 streamers — close the four stubs from v0.58.0 ───────────────────

// -- Co-Termination Opportunity ----------------------------------------------

function streamCoTermOpportunityPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Co-Termination Opportunity`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Co-Termination Opportunity',
    title:       `${data.companyName || 'Your Company'}  -  Spread >= ${data.minSpread}d`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Groups',         value: String(data.groupCount || 0),         subtitle: `${data.contractCount || 0} contract${data.contractCount === 1 ? '' : 's'}` },
    { label: 'Annual Value',   value: fmtMoney(data.totalAnnualValue),      subtitle: 'addressable' },
    { label: 'Top Opportunity',value: fmtMoney(data.biggestOpportunityUsd), subtitle: data.biggestOpportunityGroup || '-', valueColor: COLORS.accent },
    { label: 'Total Spread',   value: `${data.totalSpreadDays || 0}d`,      subtitle: 'days across groups' },
  ]);

  doc.moveDown(0.8);
  const groups = data.groups || [];
  if (!groups.length) {
    drawSectionTitle(doc, 'Co-term groups', '0');
    drawEmptyState(doc, 'No co-term groups exceed the selected spread threshold.');
  } else {
    groups.forEach((g, gi) => {
      ensureSpace(doc, 80);
      drawSectionTitle(doc, g.groupName, `${g.memberCount} contracts  -  ${g.divergeDays}d spread  -  ${fmtMoney(g.annualValue)} annual  -  est savings ${fmtMoney(g.estimatedSavingsUsd)}`);

      const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const cols = [
        { key: 'vendor',  header: 'Vendor',      width: totalWidth * 0.22, align: 'left'  },
        { key: 'product', header: 'Product',     width: totalWidth * 0.28, align: 'left'  },
        { key: 'end',     header: 'End Date',    width: totalWidth * 0.14, align: 'right' },
        { key: 'value',   header: 'Value',       width: totalWidth * 0.16, align: 'right' },
        { key: 'owner',   header: 'Owner',       width: totalWidth * 0.20, align: 'left'  },
      ];
      drawTableHeader(doc, cols);
      (g.members || []).forEach((m, mi) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, cols, [
            { text: m.vendorName || '-', font: FONT_BOLD, color: COLORS.text },
            { text: m.product    || '-',                  color: COLORS.text },
            { text: fmtDate(m.endDate),                   color: COLORS.text },
            { text: fmtMoney(m.renewalValue), font: FONT_BOLD, color: COLORS.text },
            { text: m.ownerDisplay || '-',                color: COLORS.textMuted },
          ], mi, yStart);
        }, cols);
      });

      // small spacer line so groups don't visually run together
      doc.moveDown(0.4);
    });

    // Methodology footnote
    ensureSpace(doc, 40);
    doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8);
    doc.text(
      'Savings estimate = 3% of annual value (vendor leverage) + $500 per misaligned contract (admin overhead). ' +
      'Proposed alignment uses the latest member end-date.',
      doc.page.margins.left, doc.y + 4,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
    );
  }

  drawGenericFooters(doc, `LapseIQ Co-Termination Opportunity  -  ${data.companyName || 'Your Company'}  -  Spread >= ${data.minSpread}d`);
  doc.end();
}

// -- Renewal Commitment Forecast ---------------------------------------------

function streamRenewalCommitmentForecastPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Renewal Commitment Forecast - Next ${data.horizon} Months`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Renewal Commitment Forecast',
    title:       `Next ${data.horizon} Months  -  ${data.companyName || 'Your Company'}`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Total Commitment', value: fmtMoney(data.totalCommitment), subtitle: `${data.totalContracts || 0} contracts` },
    { label: 'Auto-Renew Share', value: data.autoRenewSharePct != null ? `${data.autoRenewSharePct.toFixed(1)}%` : '-', subtitle: fmtMoney(data.autoRenewValue), valueColor: (data.autoRenewSharePct || 0) >= 40 ? '#d97706' : COLORS.text },
    { label: 'Biggest Month',    value: data.biggestMonth ? fmtMonthShort(data.biggestMonth.yyyy_mm) : '-', subtitle: data.biggestMonth ? fmtMoney(data.biggestMonth.renewalValue) : '-', valueColor: COLORS.accent },
    { label: 'Horizon',          value: `${data.horizon}m`,             subtitle: 'rolling forward' },
  ]);

  doc.moveDown(0.8);
  const months = data.months || [];
  drawSectionTitle(doc, 'Month-by-month forecast', `${months.length} month${months.length === 1 ? '' : 's'}`);

  if (!months.length) {
    drawEmptyState(doc, 'No renewals in the selected horizon.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'month',  header: 'Month',         width: totalWidth * 0.18, align: 'left'  },
      { key: 'count',  header: 'Contracts',     width: totalWidth * 0.12, align: 'right' },
      { key: 'value',  header: 'Renewal Value', width: totalWidth * 0.20, align: 'right' },
      { key: 'cum',    header: 'Cumulative',    width: totalWidth * 0.20, align: 'right' },
      { key: 'auton',  header: 'Auto-Renew #',  width: totalWidth * 0.14, align: 'right' },
      { key: 'autov',  header: 'Auto-Renew $',  width: totalWidth * 0.16, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    months.forEach((m, mi) => {
      drawRowWithPagination(doc, (yStart) => {
        const autoColor = m.autoRenewValue > 0 ? '#d97706' : COLORS.textMuted;
        drawTableRow(doc, cols, [
          { text: fmtMonthShort(m.yyyy_mm), font: FONT_BOLD, color: COLORS.text },
          { text: String(m.contractCount || 0),               color: COLORS.text },
          { text: fmtMoney(m.renewalValue), font: FONT_BOLD,  color: COLORS.text },
          { text: fmtMoney(m.cumulativeValue),                color: COLORS.textMuted },
          { text: String(m.autoRenewCount || 0),              color: autoColor },
          { text: fmtMoney(m.autoRenewValue),                 color: autoColor },
        ], mi, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Renewal Commitment Forecast  -  ${data.companyName || 'Your Company'}  -  Next ${data.horizon} months`);
  doc.end();
}

// -- Vendor Portfolio Heat Map -----------------------------------------------

function streamVendorPortfolioHeatMapPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Vendor Portfolio Heat Map`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Vendor Portfolio Heat Map',
    title:       `${data.companyName || 'Your Company'}  -  Criticality x Spend`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Vendors Tracked', value: String(data.vendorCount || 0),                                                    subtitle: 'with active contracts' },
    { label: 'Tier-1 Coverage', value: data.tier1CoveragePct != null ? `${data.tier1CoveragePct.toFixed(1)}%` : '-',     subtitle: 'with criticalityTier set', valueColor: COLORS.accent },
    { label: 'Tier-4 Spend',    value: fmtMoney(data.tier4Spend),                                                        subtitle: data.tier4Pct != null ? `${data.tier4Pct.toFixed(1)}% of portfolio` : '-', valueColor: (data.tier4Pct || 0) >= 20 ? '#d97706' : COLORS.text },
    { label: 'Unset Vendors',   value: String(data.unsetCount || 0),                                                      subtitle: 'data-quality nudge' },
  ]);

  doc.moveDown(0.8);
  drawSectionTitle(doc, 'Criticality x Spend', '4x4 cell grid');

  const TIER_ORDER = ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'unset'];
  const TIER_LABELS = {
    tier_1: 'Tier 1',
    tier_2: 'Tier 2',
    tier_3: 'Tier 3',
    tier_4: 'Tier 4',
    unset:  'Unset',
  };
  const BUCKETS = [
    { id: 'gt_1m',    label: '> $1M' },
    { id: '100k_1m',  label: '$100K-$1M' },
    { id: '10k_100k', label: '$10K-$100K' },
    { id: 'lt_10k',   label: '< $10K' },
  ];

  const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = [
    { key: 'tier', header: 'Tier',         width: totalWidth * 0.20, align: 'left'  },
    { key: 'b1',   header: BUCKETS[0].label, width: totalWidth * 0.20, align: 'right' },
    { key: 'b2',   header: BUCKETS[1].label, width: totalWidth * 0.20, align: 'right' },
    { key: 'b3',   header: BUCKETS[2].label, width: totalWidth * 0.20, align: 'right' },
    { key: 'b4',   header: BUCKETS[3].label, width: totalWidth * 0.20, align: 'right' },
  ];
  drawTableHeader(doc, cols);
  TIER_ORDER.forEach((tier, ti) => {
    const row = data.grid?.[tier] || {};
    drawRowWithPagination(doc, (yStart) => {
      const cells = [{ text: TIER_LABELS[tier], font: FONT_BOLD, color: COLORS.text }];
      BUCKETS.forEach(b => {
        const cell = row[b.id] || { vendorCount: 0, spend: 0 };
        const text = cell.vendorCount > 0
          ? `${cell.vendorCount}  /  ${fmtMoney(cell.spend)}`
          : '-';
        const isStrategicGap = tier === 'tier_1' && b.id === 'lt_10k';
        const isRationalize  = tier === 'tier_4' && (b.id === 'gt_1m' || b.id === '100k_1m');
        const color = isStrategicGap ? COLORS.accent
                    : isRationalize  ? '#d97706'
                    : cell.vendorCount > 0 ? COLORS.text : COLORS.textMuted;
        cells.push({ text, color, font: (isStrategicGap || isRationalize) ? FONT_BOLD : FONT_REG });
      });
      drawTableRow(doc, cols, cells, ti, yStart);
    }, cols);
  });

  // Callouts
  doc.moveDown(0.8);
  drawSectionTitle(doc, 'Rationalization candidates', `Tier-4 vendors over $100K (${(data.rationalizationCandidates || []).length})`);
  if (!(data.rationalizationCandidates || []).length) {
    drawEmptyState(doc, 'None. Tier-4 spend is contained.');
  } else {
    const ccols = [
      { key: 'v', header: 'Vendor', width: totalWidth * 0.70, align: 'left'  },
      { key: 's', header: 'Spend',  width: totalWidth * 0.30, align: 'right' },
    ];
    drawTableHeader(doc, ccols);
    data.rationalizationCandidates.forEach((v, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, ccols, [
          { text: v.vendorName, font: FONT_BOLD, color: COLORS.text },
          { text: fmtMoney(v.spend), color: '#d97706', font: FONT_BOLD },
        ], i, yStart);
      }, ccols);
    });
  }

  doc.moveDown(0.8);
  drawSectionTitle(doc, 'Strategic gaps', `Tier-1 vendors under $10K (${(data.strategicGaps || []).length})`);
  if (!(data.strategicGaps || []).length) {
    drawEmptyState(doc, 'None. Tier-1 coverage looks healthy.');
  } else {
    const sgcols = [
      { key: 'v', header: 'Vendor', width: totalWidth * 0.70, align: 'left'  },
      { key: 's', header: 'Spend',  width: totalWidth * 0.30, align: 'right' },
    ];
    drawTableHeader(doc, sgcols);
    data.strategicGaps.forEach((v, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, sgcols, [
          { text: v.vendorName, font: FONT_BOLD, color: COLORS.text },
          { text: fmtMoney(v.spend), color: COLORS.accent, font: FONT_BOLD },
        ], i, yStart);
      }, sgcols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Vendor Portfolio Heat Map  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// -- Audit Evidence Pack -----------------------------------------------------

function streamAuditEvidencePackPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Audit Evidence Pack`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Audit Evidence Pack',
    title:       `${data.companyName || 'Your Company'}  -  SOC2 / SOX-style composition`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Active Contracts',  value: String(data.activeCount || 0),         subtitle: `${data.vendorCount || 0} vendors` },
    { label: 'Past Cancel-By',    value: String(data.pastCancelByCount || 0),   subtitle: 'still active', valueColor: (data.pastCancelByCount || 0) > 0 ? COLORS.negative : COLORS.text },
    { label: 'Missing Signer',    value: String(data.missingSignerCount || 0),  subtitle: 'active contracts', valueColor: (data.missingSignerCount || 0) > 0 ? '#d97706' : COLORS.text },
    { label: 'Missing End Date',  value: String(data.missingEndDateCount || 0), subtitle: 'active contracts' },
  ]);

  doc.moveDown(0.8);

  // Section 1 - Active inventory (truncate to a sensible page count)
  const inv = data.activeInventory || [];
  drawSectionTitle(doc, 'Active contracts inventory', `${inv.length} row${inv.length === 1 ? '' : 's'}`);
  if (!inv.length) {
    drawEmptyState(doc, 'No active contracts.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'vendor',  header: 'Vendor',     width: totalWidth * 0.18, align: 'left'  },
      { key: 'product', header: 'Product',    width: totalWidth * 0.22, align: 'left'  },
      { key: 'signer',  header: 'Signer',     width: totalWidth * 0.15, align: 'left'  },
      { key: 'end',     header: 'End Date',   width: totalWidth * 0.11, align: 'right' },
      { key: 'auto',    header: 'Auto',       width: totalWidth * 0.06, align: 'right' },
      { key: 'cancel',  header: 'Cancel By',  width: totalWidth * 0.11, align: 'right' },
      { key: 'value',   header: 'Value',      width: totalWidth * 0.17, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    inv.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const signerColor = r.signerName ? COLORS.text : '#d97706';
        const autoColor   = r.autoRenewal ? '#d97706' : COLORS.textMuted;
        drawTableRow(doc, cols, [
          { text: r.vendorName || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.product    || '-',                  color: COLORS.text },
          { text: r.signerName || 'missing',            color: signerColor },
          { text: fmtDate(r.endDate),                   color: COLORS.text },
          { text: r.autoRenewal ? 'Y' : 'N',            color: autoColor },
          { text: fmtDate(r.cancelByDate),              color: COLORS.text },
          { text: fmtMoney(r.value), font: FONT_BOLD,   color: COLORS.text },
        ], i, yStart);
      }, cols);
    });
  }

  // Section 2 - Sensitive data
  doc.moveDown(0.8);
  ensureSpace(doc, 60);
  const sens = data.sensitiveDataVendors || [];
  drawSectionTitle(doc, 'Sensitive-data flagged vendors', `${sens.length} vendor${sens.length === 1 ? '' : 's'}`);
  if (!sens.length) {
    drawEmptyState(doc, 'No vendors match the heuristic.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',           width: totalWidth * 0.40, align: 'left'  },
      { key: 'r',  header: 'Heuristic reason', width: totalWidth * 0.45, align: 'left'  },
      { key: 'c',  header: 'Contracts',        width: totalWidth * 0.15, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    sens.forEach((v, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: v.vendorName, font: FONT_BOLD, color: COLORS.text },
          { text: v.reason,                       color: COLORS.textMuted },
          { text: String(v.contractCount || 0),   color: COLORS.text },
        ], i, yStart);
      }, cols);
    });
  }

  // Section 3 - Past cancel-by
  doc.moveDown(0.8);
  ensureSpace(doc, 60);
  const pcb = data.pastCancelBy || [];
  drawSectionTitle(doc, 'Past cancel-by, still active', `${pcb.length} contract${pcb.length === 1 ? '' : 's'}`);
  if (!pcb.length) {
    drawEmptyState(doc, 'No active contracts have rolled past their cancel-by date.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',       width: totalWidth * 0.22, align: 'left'  },
      { key: 'p',  header: 'Product',      width: totalWidth * 0.28, align: 'left'  },
      { key: 'd',  header: 'Cancel By',    width: totalWidth * 0.16, align: 'right' },
      { key: 'o',  header: 'Days Overdue', width: totalWidth * 0.16, align: 'right' },
      { key: 'va', header: 'Value',        width: totalWidth * 0.18, align: 'right' },
    ];
    drawTableHeader(doc, cols);
    pcb.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: r.vendorName || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.product    || '-',                  color: COLORS.text },
          { text: fmtDate(r.cancelByDate),              color: COLORS.text },
          { text: r.daysOverdue != null ? String(r.daysOverdue) : '-', color: COLORS.negative, font: FONT_BOLD },
          { text: fmtMoney(r.value), font: FONT_BOLD,   color: COLORS.text },
        ], i, yStart);
      }, cols);
    });
  }

  // Section 4 - Support contacts
  doc.moveDown(0.8);
  ensureSpace(doc, 60);
  const sc = data.supportContacts || [];
  drawSectionTitle(doc, 'Vendor support contacts', `${sc.length} vendor${sc.length === 1 ? '' : 's'}`);
  if (!sc.length) {
    drawEmptyState(doc, 'No vendor contact info on file.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v', header: 'Vendor',  width: totalWidth * 0.30, align: 'left' },
      { key: 'e', header: 'Email',   width: totalWidth * 0.30, align: 'left' },
      { key: 'p', header: 'Phone',   width: totalWidth * 0.20, align: 'left' },
      { key: 'u', header: 'Portal',  width: totalWidth * 0.20, align: 'left' },
    ];
    drawTableHeader(doc, cols);
    sc.forEach((v, i) => {
      drawRowWithPagination(doc, (yStart) => {
        drawTableRow(doc, cols, [
          { text: v.vendorName, font: FONT_BOLD, color: COLORS.text },
          { text: v.email     || 'missing', color: v.email ? COLORS.text : '#d97706' },
          { text: v.phone     || 'missing', color: v.phone ? COLORS.text : COLORS.textMuted },
          { text: v.portalUrl ? 'on file' : 'missing', color: v.portalUrl ? COLORS.text : COLORS.textMuted },
        ], i, yStart);
      }, cols);
    });
  }

  // Section 5 - Missing evidence
  doc.moveDown(0.8);
  ensureSpace(doc, 60);
  drawSectionTitle(doc, 'Missing evidence callouts', `${(data.missingEvidence || []).length} item${(data.missingEvidence || []).length === 1 ? '' : 's'}`);
  if (!(data.missingEvidence || []).length) {
    drawEmptyState(doc, 'No callouts.');
  } else {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    (data.missingEvidence || []).forEach((m) => {
      ensureSpace(doc, 30);
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(10);
      doc.text(m.field + ':', left, doc.y);
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(9);
      doc.text(m.note, left + 12, doc.y, { width: right - left - 12 });
      doc.moveDown(0.3);
    });
  }

  drawGenericFooters(doc, `LapseIQ Audit Evidence Pack  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// Helper: short month label like "Jan 2026"
function fmtMonthShort(yyyy_mm) {
  if (!yyyy_mm) return '-';
  const [y, m] = yyyy_mm.split('-');
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}


// ── Application Portfolio Overlap (v0.60.0) ─────────────────────────────────

function streamApplicationOverlapPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   `LapseIQ Application Portfolio Overlap`,
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Application Portfolio Overlap',
    title:       `${data.companyName || 'Your Company'}  -  Consolidation candidates`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Overlap Groups',    value: String(data.groupCount || 0),         subtitle: `${data.contractCount || 0} contract${data.contractCount === 1 ? '' : 's'}` },
    { label: 'Addressable Spend', value: fmtMoney(data.totalAddressableSpend), subtitle: 'across overlap groups' },
    { label: 'Biggest Overlap',   value: data.biggestOverlap ? fmtMoney(data.biggestOverlap.spend) : '-', subtitle: data.biggestOverlap ? data.biggestOverlap.label : '-', valueColor: COLORS.accent },
    { label: 'SaaS Buckets',      value: String(data.saasBucketCount || 0),    subtitle: 'functional clusters' },
  ]);

  doc.moveDown(0.8);
  const groups = data.groups || [];
  if (!groups.length) {
    drawSectionTitle(doc, 'Overlap groups', '0');
    drawEmptyState(doc, 'No overlap detected. Every category + functional bucket has a single vendor.');
  } else {
    groups.forEach((g) => {
      ensureSpace(doc, 70);
      const heurLabel = g.heuristic === 'saas-bucket' ? 'SaaS bucket' : 'Category';
      drawSectionTitle(doc, `${g.label}  [${heurLabel}]`, `${g.vendorCount} vendors  -  ${g.members.length} contracts  -  ${fmtMoney(g.totalSpend)} addressable`);

      const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const cols = [
        { key: 'v',  header: 'Vendor',     width: totalWidth * 0.22, align: 'left'  },
        { key: 'p',  header: 'Product',    width: totalWidth * 0.30, align: 'left'  },
        { key: 'd',  header: 'Department', width: totalWidth * 0.18, align: 'left'  },
        { key: 'o',  header: 'Owner',      width: totalWidth * 0.16, align: 'left'  },
        { key: 's',  header: 'Spend',      width: totalWidth * 0.14, align: 'right' },
      ];
      drawTableHeader(doc, cols);
      g.members.forEach((m, mi) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, cols, [
            { text: m.vendorName,        font: FONT_BOLD, color: COLORS.text },
            { text: m.product || '-',                     color: COLORS.text },
            { text: m.department || '-',                  color: COLORS.textMuted },
            { text: m.ownerDisplay || '-',                color: COLORS.textMuted },
            { text: fmtMoney(m.spend),   font: FONT_BOLD, color: COLORS.text },
          ], mi, yStart);
        }, cols);
      });
      doc.moveDown(0.4);
    });

    if (data.saasUnbucketedCount > 0) {
      ensureSpace(doc, 30);
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8);
      doc.text(
        `Note: ${data.saasUnbucketedCount} SaaS contract${data.saasUnbucketedCount === 1 ? '' : 's'} did not match any functional bucket. Add a recognisable product name (e.g. include "Slack" or "Salesforce") to bring them into the overlap groups.`,
        doc.page.margins.left, doc.y + 4,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right }
      );
    }
  }

  drawGenericFooters(doc, `LapseIQ Application Portfolio Overlap  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}



function streamM365OverlapPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Microsoft 365 Overlap',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Microsoft 365 Overlap',
    title:       `${data.companyName || 'Your Company'}  -  Tools already bundled in Microsoft 365`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  const anchorLabel = data.anchor ? (data.anchor.vendorName + ' ' + data.anchor.product).trim() : '-';

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Displaceable Tools', value: String(data.overlapCount || 0),    subtitle: 'covered by M365' },
    { label: 'Spend At Stake',     value: fmtMoney(data.totalSpendAtStake),  subtitle: 'annual' },
    { label: 'M365 Anchor',        value: anchorLabel,                       subtitle: data.anchorTier ? ('Tier ' + data.anchorTier) : '-', valueColor: COLORS.accent },
    { label: 'License Tier',       value: data.anchorTier || '-',            subtitle: data.anchorTier === 'E5' ? 'security + BI + compliance' : 'productivity + identity' },
  ]);

  doc.moveDown(0.8);
  const members = (data.groups[0] && data.groups[0].members) || [];
  if (!data.hasAnchor || members.length === 0) {
    drawSectionTitle(doc, 'Overlap', '0');
    drawEmptyState(doc, data.hasAnchor
      ? 'No overlap detected. Nothing in the portfolio duplicates a capability bundled in your Microsoft 365 license.'
      : 'No Microsoft 365 anchor found. Add your Microsoft 365 (E3 or E5) contract to surface tools it could replace.');
  } else {
    const byCap = new Map();
    for (const m of members) {
      const key = m.capability || 'Other';
      if (!byCap.has(key)) byCap.set(key, { capability: key, note: m.note || '', requiresTier: m.requiresTier || 'E3', members: [], totalSpend: 0 });
      const g = byCap.get(key);
      g.members.push(m);
      g.totalSpend += (m.spend || 0);
    }
    const capGroups = [...byCap.values()].sort((a, b) => b.totalSpend - a.totalSpend);

    capGroups.forEach((g) => {
      ensureSpace(doc, 70);
      drawSectionTitle(doc, `${g.capability}  [${g.requiresTier}]`, `${g.members.length} tool${g.members.length === 1 ? '' : 's'}  -  ${fmtMoney(g.totalSpend)} at stake`);
      if (g.note) {
        doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8);
        doc.text(g.note, doc.page.margins.left, doc.y + 2, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        doc.moveDown(0.3);
      }

      const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const cols = [
        { key: 'v', header: 'Vendor',     width: totalWidth * 0.24, align: 'left'  },
        { key: 'p', header: 'Product',    width: totalWidth * 0.38, align: 'left'  },
        { key: 'd', header: 'Department', width: totalWidth * 0.22, align: 'left'  },
        { key: 's', header: 'Spend',      width: totalWidth * 0.16, align: 'right' },
      ];
      drawTableHeader(doc, cols);
      g.members.forEach((m, mi) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, cols, [
            { text: m.vendorName || '-', font: FONT_BOLD, color: COLORS.text },
            { text: m.product || '-',                     color: COLORS.text },
            { text: m.department || '-',                  color: COLORS.textMuted },
            { text: fmtMoney(m.spend),   font: FONT_BOLD, color: COLORS.text },
          ], mi, yStart);
        }, cols);
      });
      doc.moveDown(0.4);
    });
  }

  drawGenericFooters(doc, `LapseIQ Microsoft 365 Overlap  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}



// ── Walkaway Calculator PDF ───────────────────────────────────────────────────
function streamWalkawayCalculatorPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Walkaway Calculator',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  const horizonMonths = (data.params && data.params.horizonMonths) || 12;
  const switchCostPct = (data.params && data.params.switchCostPctOverride != null)
    ? data.params.switchCostPctOverride : null;

  drawGenericHeader(doc, {
    reportLabel: 'Walkaway Calculator',
    title:       `${data.companyName || 'Your Company'}  -  Switch-cost analysis`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 `   -   Horizon: ${horizonMonths} months` +
                 (switchCostPct != null ? `   -   Switch cost override: ${switchCostPct}%` : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Contracts Assessed', value: String(data.summary.contractCount || 0),    subtitle: `in ${horizonMonths}-month horizon` },
    { label: 'Investigate',        value: String(data.summary.investigateCount || 0),  subtitle: 'walkaway candidates',        valueColor: COLORS.negative },
    { label: 'Total Renewal Cost', value: fmtMoney(data.summary.totalRenewalCost),    subtitle: 'across horizon contracts' },
    { label: 'Renew',              value: String((data.summary.contractCount || 0) - (data.summary.investigateCount || 0)), subtitle: 'renew recommended', valueColor: COLORS.positive },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Walkaway analysis', `${rows.length} contract${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No contracts fall within the selected renewal horizon.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',        width: totalWidth * 0.18, align: 'left'  },
      { key: 'p',  header: 'Product',       width: totalWidth * 0.20, align: 'left'  },
      { key: 'c',  header: 'Category',      width: totalWidth * 0.12, align: 'left'  },
      { key: 'r',  header: 'Renewal Cost',  width: totalWidth * 0.13, align: 'right' },
      { key: 's',  header: 'Switch Cost',   width: totalWidth * 0.13, align: 'right' },
      { key: 'd',  header: 'Days to Renew', width: totalWidth * 0.11, align: 'right' },
      { key: 'x',  header: 'Recommendation',width: totalWidth * 0.13, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const recColor = r.recommendation === 'investigate' ? COLORS.negative : COLORS.positive;
        drawTableRow(doc, cols, [
          { text: r.vendorName  || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.productName || '-',                  color: COLORS.text },
          { text: r.category    || '-',                  color: COLORS.textMuted },
          { text: fmtMoney(r.renewalCost),               color: COLORS.text },
          { text: fmtMoney(r.switchCost),                color: COLORS.textMuted },
          { text: r.daysToRenewal != null ? String(r.daysToRenewal) : '-', color: COLORS.text },
          { text: r.recommendation === 'investigate' ? 'Investigate' : 'Renew', font: FONT_BOLD, color: recColor },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Walkaway Calculator  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// ── Portfolio Decision Dashboard PDF ─────────────────────────────────────────
function streamPortfolioDecisionDashboardPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Portfolio Decision Dashboard',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Portfolio Decision Dashboard',
    title:       `${data.companyName || 'Your Company'}  -  AI-assisted renewal decisions`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  const vc = data.summary.verdictCounts || {};
  drawSimpleSummaryCards(doc, [
    { label: 'Contracts',       value: String(data.summary.contractCount || 0),   subtitle: `${data.summary.analyzedCount || 0} AI-analyzed` },
    { label: 'Critical',        value: String(data.summary.criticalCount || 0),   subtitle: 'urgent attention needed', valueColor: COLORS.negative },
    { label: 'Renew',           value: String(vc.renew     || 0),                 subtitle: 'AI verdict: renew',      valueColor: COLORS.positive },
    { label: 'Negotiate / Esc', value: String((vc.negotiate || 0) + (vc.escalate || 0)), subtitle: 'negotiate or escalate' },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Contract decisions', `${rows.length} contract${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No contracts found.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',   width: totalWidth * 0.18, align: 'left'  },
      { key: 'c',  header: 'Category', width: totalWidth * 0.13, align: 'left'  },
      { key: 'o',  header: 'Owner',    width: totalWidth * 0.14, align: 'left'  },
      { key: 'e',  header: 'End Date', width: totalWidth * 0.10, align: 'right' },
      { key: 't',  header: 'Value',    width: totalWidth * 0.12, align: 'right' },
      { key: 'u',  header: 'Urgency',  width: totalWidth * 0.10, align: 'left'  },
      { key: 'a',  header: 'AI Score', width: totalWidth * 0.09, align: 'right' },
      { key: 'x',  header: 'Verdict',  width: totalWidth * 0.14, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const urgencyColor = r.urgency === 'critical' ? COLORS.negative
          : r.urgency === 'high' ? '#d97706'
          : COLORS.textMuted;
        const verdictColor = r.aiVerdict === 'renew' ? COLORS.positive
          : r.aiVerdict === 'escalate' ? COLORS.negative
          : r.aiVerdict ? COLORS.accent
          : COLORS.textMuted;
        drawTableRow(doc, cols, [
          { text: r.vendorName    || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.category      || '-',                  color: COLORS.textMuted },
          { text: r.contractOwner || '-',                  color: COLORS.textMuted },
          { text: fmtDate(r.endDate),                      color: COLORS.text },
          { text: fmtMoney(r.totalValue),                  color: COLORS.text },
          { text: r.urgency ? (r.urgency.charAt(0).toUpperCase() + r.urgency.slice(1)) : '-', color: urgencyColor, font: r.urgency === 'critical' ? FONT_BOLD : FONT_REG },
          { text: r.aiScore != null ? String(r.aiScore) : '-', color: COLORS.text },
          { text: r.aiVerdict ? (r.aiVerdict.charAt(0).toUpperCase() + r.aiVerdict.slice(1)) : (r.aiAnalyzed ? '-' : 'Pending'), font: FONT_BOLD, color: verdictColor },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Portfolio Decision Dashboard  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// ── Contract Health Score PDF ─────────────────────────────────────────────────
function streamContractHealthScorePdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Contract Health Score',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Contract Health Score',
    title:       `${data.companyName || 'Your Company'}  -  Data completeness & compliance`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  const avgScore = data.summary.avgScore != null ? Math.round(data.summary.avgScore) : 0;
  const avgColor = avgScore >= 75 ? COLORS.positive : avgScore >= 50 ? '#d97706' : COLORS.negative;
  drawSimpleSummaryCards(doc, [
    { label: 'Contracts Scored', value: String(data.summary.contractCount || 0), subtitle: 'in portfolio' },
    { label: 'Avg Health Score', value: `${avgScore}`,                           subtitle: 'out of 100', valueColor: avgColor },
    { label: 'Good',             value: String(data.summary.goodCount || 0),     subtitle: 'score ≥ 75',  valueColor: COLORS.positive },
    { label: 'Critical',         value: String(data.summary.criticalCount || 0), subtitle: 'score < 50',  valueColor: COLORS.negative },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Contract health scores', `${rows.length} contract${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No contracts found.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',     width: totalWidth * 0.18, align: 'left'  },
      { key: 'p',  header: 'Product',    width: totalWidth * 0.18, align: 'left'  },
      { key: 'c',  header: 'Category',   width: totalWidth * 0.12, align: 'left'  },
      { key: 'o',  header: 'Owner',      width: totalWidth * 0.13, align: 'left'  },
      { key: 'e',  header: 'End Date',   width: totalWidth * 0.10, align: 'right' },
      { key: 't',  header: 'Value',      width: totalWidth * 0.11, align: 'right' },
      { key: 's',  header: 'Score',      width: totalWidth * 0.08, align: 'right' },
      { key: 'x',  header: 'Tier',       width: totalWidth * 0.10, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const score = r.healthScore != null ? r.healthScore : 0;
        const scoreColor = score >= 75 ? COLORS.positive : score >= 50 ? '#d97706' : COLORS.negative;
        const tierColor  = r.tier === 'good' ? COLORS.positive : r.tier === 'critical' ? COLORS.negative : '#d97706';
        const tierLabel  = r.tier === 'good' ? 'Good' : r.tier === 'critical' ? 'Critical' : 'Needs Work';
        drawTableRow(doc, cols, [
          { text: r.vendorName     || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.productName    || '-',                  color: COLORS.text },
          { text: r.category       || '-',                  color: COLORS.textMuted },
          { text: r.contractOwner  || '-',                  color: COLORS.textMuted },
          { text: fmtDate(r.endDate),                       color: COLORS.text },
          { text: fmtMoney(r.totalValue),                   color: COLORS.text },
          { text: String(score),                            font: FONT_BOLD, color: scoreColor },
          { text: tierLabel,                                font: FONT_BOLD, color: tierColor },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Contract Health Score  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// ── Price Escalation Radar PDF ────────────────────────────────────────────────
function streamPriceEscalationRadarPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Price Escalation Radar',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  const thresholdPct = (data.params && data.params.thresholdPct != null) ? data.params.thresholdPct : 10;

  drawGenericHeader(doc, {
    reportLabel: 'Price Escalation Radar',
    title:       `${data.companyName || 'Your Company'}  -  Cost creep detection`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 `   -   Threshold: ${thresholdPct}%` +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Contracts Checked', value: String(data.summary.contractCount || 0), subtitle: 'with pricing data' },
    { label: 'High Escalation',   value: String(data.summary.highCount    || 0),  subtitle: `above ${thresholdPct * 2}% threshold`, valueColor: COLORS.negative },
    { label: 'Medium Escalation', value: String(data.summary.mediumCount  || 0),  subtitle: `above ${thresholdPct}% threshold`,     valueColor: '#d97706' },
    { label: 'Total Exposure',    value: fmtMoney(data.summary.totalExposure),    subtitle: 'cumulative overspend',                  valueColor: COLORS.negative },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];
  drawSectionTitle(doc, 'Price escalation detail', `${rows.length} contract${rows.length === 1 ? '' : 's'}`);

  if (!rows.length) {
    drawEmptyState(doc, 'No price escalation detected above the threshold.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cols = [
      { key: 'v',  header: 'Vendor',       width: totalWidth * 0.17, align: 'left'  },
      { key: 'p',  header: 'Product',      width: totalWidth * 0.17, align: 'left'  },
      { key: 'c',  header: 'Category',     width: totalWidth * 0.11, align: 'left'  },
      { key: 'oa', header: 'Original',     width: totalWidth * 0.12, align: 'right' },
      { key: 'cv', header: 'Current',      width: totalWidth * 0.12, align: 'right' },
      { key: 'ep', header: 'Escalation',   width: totalWidth * 0.11, align: 'right' },
      { key: 'ed', header: 'Delta $',      width: totalWidth * 0.10, align: 'right' },
      { key: 'x',  header: 'Tier',         width: totalWidth * 0.10, align: 'left'  },
    ];
    drawTableHeader(doc, cols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const tierColor = r.tier === 'high' ? COLORS.negative : r.tier === 'medium' ? '#d97706' : COLORS.textMuted;
        const tierLabel = r.tier === 'high' ? 'High' : r.tier === 'medium' ? 'Medium' : 'Low';
        const escPct    = r.escalationPct != null ? `${r.escalationPct >= 0 ? '+' : ''}${Number(r.escalationPct).toFixed(1)}%` : '-';
        drawTableRow(doc, cols, [
          { text: r.vendorName  || '-', font: FONT_BOLD, color: COLORS.text },
          { text: r.productName || '-',                  color: COLORS.text },
          { text: r.category    || '-',                  color: COLORS.textMuted },
          { text: fmtMoney(r.originalAsk),               color: COLORS.text },
          { text: fmtMoney(r.currentValue),              color: COLORS.text },
          { text: escPct,                                font: FONT_BOLD, color: tierColor },
          { text: fmtMoney(r.escalationDelta),           color: tierColor },
          { text: tierLabel,                             font: FONT_BOLD, color: tierColor },
        ], i, yStart);
      }, cols);
    });
  }

  drawGenericFooters(doc, `LapseIQ Price Escalation Radar  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

// ── Department Budget Allocation PDF ─────────────────────────────────────────
function streamDepartmentBudgetAllocationPdf(res, data) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 0, bottom: 24, left: 48, right: 48 },
    info: {
      Title:   'LapseIQ Department Budget Allocation',
      Author:  'LapseIQ',
      Creator: 'LapseIQ',
    },
    bufferPages: true,
  });
  doc.pipe(res);

  drawGenericHeader(doc, {
    reportLabel: 'Department Budget Allocation',
    title:       `${data.companyName || 'Your Company'}  -  Spend by department`,
    meta:        `Generated: ${fmtDate(data.generatedAt)}` +
                 (data.generatedBy ? `   -   By: ${data.generatedBy}` : '') +
                 (data.scopeRestricted ? '   -   Scope: your contracts only' : ''),
  });

  doc.moveDown(0.5);
  drawSimpleSummaryCards(doc, [
    { label: 'Total Portfolio',  value: fmtMoney(data.summary.totalPortfolio),     subtitle: 'annual contract spend' },
    { label: 'Departments',      value: String(data.summary.departmentCount || 0), subtitle: 'with assigned contracts' },
    { label: 'Unassigned',       value: String(data.summary.unassignedCount || 0), subtitle: 'no department set', valueColor: (data.summary.unassignedCount || 0) > 0 ? '#d97706' : COLORS.text },
    { label: 'Contracts',        value: String((data.rows || []).reduce((s, r) => s + (r.contractCount || 0), 0)), subtitle: 'across all departments' },
  ]);

  doc.moveDown(0.8);
  const rows = data.rows || [];

  // Summary table by department
  drawSectionTitle(doc, 'Department summary', `${rows.length} department${rows.length === 1 ? '' : 's'}`);
  if (!rows.length) {
    drawEmptyState(doc, 'No department data available.');
  } else {
    const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const sumCols = [
      { key: 'dept', header: 'Department',      width: totalWidth * 0.28, align: 'left'  },
      { key: 'cnt',  header: 'Contracts',        width: totalWidth * 0.13, align: 'right' },
      { key: 'sp',   header: 'Total Spend',      width: totalWidth * 0.18, align: 'right' },
      { key: 'r90',  header: 'Renewals in 90d',  width: totalWidth * 0.16, align: 'right' },
      { key: 'pct',  header: 'Portfolio %',      width: totalWidth * 0.13, align: 'right' },
    ];
    drawTableHeader(doc, sumCols);
    rows.forEach((r, i) => {
      drawRowWithPagination(doc, (yStart) => {
        const pctStr = r.portfolioPct != null ? `${Number(r.portfolioPct).toFixed(1)}%` : '-';
        drawTableRow(doc, sumCols, [
          { text: r.department || 'Unassigned', font: FONT_BOLD, color: COLORS.text },
          { text: String(r.contractCount || 0),                  color: COLORS.text },
          { text: fmtMoney(r.totalSpend),       font: FONT_BOLD, color: COLORS.text },
          { text: String(r.renewalsIn90d || 0),                  color: r.renewalsIn90d > 0 ? '#d97706' : COLORS.textMuted },
          { text: pctStr,                                        color: COLORS.textMuted },
        ], i, yStart);
      }, sumCols);
    });

    // Per-department contract breakdowns
    rows.forEach((dept) => {
      const contracts = dept.contracts || [];
      if (!contracts.length) return;

      doc.moveDown(0.8);
      ensureSpace(doc, 70);
      drawSectionTitle(doc, dept.department || 'Unassigned', `${contracts.length} contract${contracts.length === 1 ? '' : 's'}  -  ${fmtMoney(dept.totalSpend)}`);

      const totalWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const detCols = [
        { key: 'v',  header: 'Vendor',    width: totalWidth * 0.27, align: 'left'  },
        { key: 'e',  header: 'End Date',  width: totalWidth * 0.16, align: 'right' },
        { key: 't',  header: 'Value',     width: totalWidth * 0.18, align: 'right' },
        { key: 'o',  header: 'Owner',     width: totalWidth * 0.27, align: 'left'  },
      ];
      drawTableHeader(doc, detCols);
      contracts.forEach((c, ci) => {
        drawRowWithPagination(doc, (yStart) => {
          drawTableRow(doc, detCols, [
            { text: c.vendorName     || '-', font: FONT_BOLD, color: COLORS.text },
            { text: fmtDate(c.endDate),                       color: COLORS.text },
            { text: fmtMoney(c.totalValue),                   color: COLORS.text },
            { text: c.contractOwner  || '-',                  color: COLORS.textMuted },
          ], ci, yStart);
        }, detCols);
      });
    });
  }

  drawGenericFooters(doc, `LapseIQ Department Budget Allocation  -  ${data.companyName || 'Your Company'}`);
  doc.end();
}

module.exports = {
  streamAutoRenewalExposurePdf,
  streamVendorConcentrationPdf,
  streamNonSaaSCategoriesPdf,
  streamExecutiveSpendPdf,
  streamRenewalHorizonPdf,
  streamRiskRadarPdf,
  streamSavingsLedgerPdf,
  streamLicenseWastagePdf,
  streamSpendLedgerPdf,
  streamCoTermOpportunityPdf,
  streamRenewalCommitmentForecastPdf,
  streamVendorPortfolioHeatMapPdf,
  streamAuditEvidencePackPdf,
  streamApplicationOverlapPdf,
  streamM365OverlapPdf,
  streamWalkawayCalculatorPdf,
  streamPortfolioDecisionDashboardPdf,
  streamContractHealthScorePdf,
  streamPriceEscalationRadarPdf,
  streamDepartmentBudgetAllocationPdf,
};

export {};
