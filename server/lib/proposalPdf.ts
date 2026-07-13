'use strict';

/**
 * proposalPdf.ts — renders a multi-year maintenance proposal (#5) to a PDF
 * Buffer. Mirrors lib/cfoReport pdfkit stream-hardening (error handler bound
 * before any write, footer recursion guard, settled flag) and co-brand support.
 *
 *   renderProposalPdf(data, meta) -> Promise<Buffer>
 */

const PDFDocument = require('pdfkit');
// C2a: locked palette, house fonts/geometry, and the standard footer now come
// from the shared theme module (lib/pdfStyle.ts) instead of a local COLORS
// block (docs/design/EXPORT_SURFACE_INVENTORY_2026-07-13.md callout 6).
const { PDF_COLORS, PDF_FONTS, PDF_PAGE, attachFooter, drawMasthead } = require('./pdfStyle');

// On-dark muted text for the co-brandable masthead band -- the locked palette
// has no on-dark slot (the band itself may be a partner brandColor).
const ON_DARK_MUTED = '#9aa3b2';

// Legacy aliases onto the locked palette (accent/rec-colors move to the locked
// petrol/status values; the old accent #0d4f6e was the hover shade).
const COLORS = {
  bgDark: PDF_COLORS.ink, textOnDark: PDF_COLORS.card, textOnDarkMuted: ON_DARK_MUTED,
  text: PDF_COLORS.ink, textMuted: PDF_COLORS.textMuted, textSubtle: PDF_COLORS.textFaint,
  border: PDF_COLORS.border, accent: PDF_COLORS.petrol, cardBg: PDF_COLORS.pageBg,
  replace: PDF_COLORS.danger, repair: PDF_COLORS.warning, defer: PDF_COLORS.textMuted, warnBg: PDF_COLORS.warningBg,
};
const FONT_REG = PDF_FONTS.sans, FONT_BOLD = PDF_FONTS.sansBold, FONT_OBL = PDF_FONTS.sansOblique;
const PAGE = PDF_PAGE;
const BOTTOM = PDF_PAGE.bottom;

function fmtMoney(n: any) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
const range = (r: any) => `${fmtMoney(r.min)} – ${fmtMoney(r.max)}`;

// C2a: the bespoke per-file footer was replaced by lib/pdfStyle's shared
// drawFooter/attachFooter (same recursion-guarded, cursor-neutral pattern).

function optionCard(doc: any, x: number, y: number, w: number, opt: any, highlight: boolean) {
  const h = 64;
  doc.rect(x, y, w, h).fill(highlight ? PDF_COLORS.petrolTint : COLORS.cardBg);
  doc.rect(x, y, w, h).strokeColor(highlight ? COLORS.accent : COLORS.border).lineWidth(highlight ? 1.25 : 0.75).stroke();
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(10).text(opt.label, x + 8, y + 8, { width: w - 16, lineBreak: false });
  doc.fillColor(COLORS.accent).font(FONT_BOLD).fontSize(13).text(range(opt.total), x + 8, y + 24, { width: w - 16, lineBreak: false });
  doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8).text(`${opt.count} line item${opt.count === 1 ? '' : 's'}`, x + 8, y + 44, { width: w - 16, lineBreak: false });
}

function renderProposalPdf(data: any, meta: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: { Title: `Multi-Year Maintenance Proposal — ${data.accountName}`, Author: 'ServiceCycle', Creator: 'ServiceCycle proposal builder' },
    });

    const chunks: any[] = [];
    let settled = false;
    const fail = (err: any) => { if (settled) return; settled = true; try { doc.destroy(); } catch {} reject(err instanceof Error ? err : new Error(String(err))); };
    doc.on('error', fail);
    doc.on('data', (c: any) => chunks.push(c));
    doc.on('end', () => { if (settled) return; settled = true; resolve(Buffer.concat(chunks)); });

    try {
      attachFooter(doc, meta); // shared footer: page 1 now + every pageAdded
      // C2i (G6): bespoke co-brand band replaced by the shared field-report
      // masthead (lib/pdfStyle.drawMasthead); brandColor passes through for the
      // partner co-brand band, else the standard ink-on-white masthead renders.
      let y = drawMasthead(doc, {
        title: 'Multi-Year Maintenance Proposal',
        org: meta.brandName || 'ServiceCycle',
        brandColor: meta.brandColor,
      });
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(16).text(`Prepared for ${data.accountName}`, PAGE.margin, y, { width: PAGE.contentW });
      y = doc.y + 2;
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(10).text(`${data.scope.siteName ? data.scope.siteName + ' · ' : ''}Generated ${meta.generatedAtIso}`, PAGE.margin, y, { width: PAGE.contentW });
      y = doc.y + 16;

      // Option cards.
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('Program options', PAGE.margin, y); y = doc.y + 8;
      const gw = (PAGE.contentW - 24) / 3;
      (data.options || []).slice(0, 3).forEach((opt: any, i: number) => {
        optionCard(doc, PAGE.margin + i * (gw + 12), y, gw, opt, opt.key === 'recommended');
      });
      y += 64 + 18;

      // Line item table.
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('Scope of work', PAGE.margin, y); y = doc.y + 8;
      const cols = [
        { k: 'asset', w: 210, label: 'Asset' },
        { k: 'rec', w: 70, label: 'Action' },
        { k: 'year', w: 50, label: 'Year' },
        { k: 'cost', w: 174, label: 'Est. cost' },
      ];
      const drawHeader = () => {
        doc.font(FONT_BOLD).fontSize(8).fillColor(COLORS.textMuted);
        let cx = PAGE.margin;
        for (const c of cols) { doc.text(c.label.toUpperCase(), cx, y, { width: c.w, lineBreak: false }); cx += c.w; }
        y = doc.y + 4;
        doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + PAGE.contentW, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += 4;
      };
      drawHeader();
      for (const li of data.lineItems) {
        if (y > BOTTOM - 44) { doc.addPage(); y = PAGE.margin; drawHeader(); }
        const recColor = COLORS[li.recommendation as 'replace' | 'repair' | 'defer'] || COLORS.text;
        const rowTop = y;
        let cx = PAGE.margin;
        doc.font(FONT_REG).fontSize(9).fillColor(COLORS.text).text(li.assetLabel + (li.siteName ? ` (${li.siteName})` : ''), cx, rowTop, { width: cols[0].w - 6 });
        const assetBottom = doc.y; // capture the wrapped asset-label bottom BEFORE the single-line cells reset doc.y
        cx += cols[0].w;
        doc.font(FONT_BOLD).fontSize(9).fillColor(recColor).text(li.recommendation.toUpperCase(), cx, rowTop, { width: cols[1].w - 6, lineBreak: false }); cx += cols[1].w;
        doc.font(FONT_REG).fontSize(9).fillColor(COLORS.text).text(String(li.year), cx, rowTop, { width: cols[2].w - 6, lineBreak: false }); cx += cols[2].w;
        doc.font(FONT_REG).fontSize(9).fillColor(COLORS.text).text(`${fmtMoney(li.costMin)} – ${fmtMoney(li.costMax)}`, cx, rowTop, { width: cols[3].w, lineBreak: false });
        y = Math.max(assetBottom, rowTop + 12) + 4;
      }
      y += 8;

      // Total.
      if (y > BOTTOM - 30) { doc.addPage(); y = PAGE.margin; }
      doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.text).text(`Total program (5-year): ${range(data.summary.total)}`, PAGE.margin, y, { width: PAGE.contentW });
      y = doc.y + 14;

      // Disclaimer.
      if (y > BOTTOM - 70) { doc.addPage(); y = PAGE.margin; }
      const disText = data.disclaimer;
      doc.font(FONT_REG).fontSize(9);
      const disH = doc.heightOfString(disText, { width: PAGE.contentW - 24, lineGap: 2 }) + 28;
      doc.rect(PAGE.margin, y, PAGE.contentW, disH).fill(COLORS.warnBg);
      doc.rect(PAGE.margin, y, 3, disH).fill(COLORS.repair);
      doc.rect(PAGE.margin, y, PAGE.contentW, disH).strokeColor(COLORS.border).lineWidth(0.75).stroke();
      doc.fillColor(COLORS.repair).font(FONT_BOLD).fontSize(9).text('SCOPE & LIMITATIONS', PAGE.margin + 12, y + 8, { width: PAGE.contentW - 24, lineBreak: false });
      doc.fillColor(COLORS.text).font(FONT_REG).fontSize(9).text(disText, PAGE.margin + 12, y + 22, { width: PAGE.contentW - 24, lineGap: 2 });

      doc.end();
    } catch (err) { fail(err); }
  });
}

module.exports = { renderProposalPdf };

export {};
