/**
 * leaveBehindPdf.ts — Service Completion Leave-Behind PDF renderer.
 *
 * Task 28: Three-section PDF left with the customer at inspection close.
 *
 *   Section 1 — What We Found
 *     Deficiencies logged during this inspection (C1/C2/C3/IMMEDIATE) with
 *     condition ratings. Photo thumbnails omitted (byte-budget concern at
 *     field scale; add in future iteration when S3 presigned URL pattern
 *     is available in the field app).
 *
 *   Section 2 — What We Fixed
 *     Corrective actions marked complete on this work order, parts replaced.
 *
 *   Section 3 — What to Budget For  ← the revenue/lead-gen section
 *     Open QuoteRequests for this account + assets with modernizationRiskScore
 *     >= 0.70 for this account. Shows min–max rate card ranges (not point
 *     estimates). Field tech leaves this with the facilities manager/CFO.
 *
 * Uses pdfkit (already in dependencies via compliancePdf.ts).
 */

const PDFDocument = require('pdfkit');
import { coBrandLine, type PartnerBranding } from './partnerBranding';
// C2a: locked palette + house fonts/geometry/footer come from the shared theme
// module (docs/design/EXPORT_SURFACE_INVENTORY_2026-07-13.md callout 6).
const { PDF_COLORS, PDF_FONTS, PDF_PAGE, finalizeFooters } = require('./pdfStyle');

// ── Palette (matches compliancePdf.ts house style) ───────────────────────────
// Legacy aliases onto the locked palette (values from lib/pdfStyle.ts).
// ON_DARK_MUTED: on-dark muted text for the co-brandable header band -- the
// locked palette has no on-dark slot. SECTION3_PURPLE: the Section 3 chip
// color, kept verbatim pending the open purple-family decision (not a locked
// palette color).
const ON_DARK_MUTED = '#9aa3b2';
const SECTION3_PURPLE = '#7c3aed';
const C = {
  bg:          PDF_COLORS.ink,
  textOnDark:  PDF_COLORS.card,
  textMuted:   ON_DARK_MUTED,      // used on the dark header band only
  text:        PDF_COLORS.ink,
  subtext:     PDF_COLORS.textMuted,
  border:      PDF_COLORS.border,
  accent:      PDF_COLORS.petrol,  // was the hover shade #0d4f6e
  danger:      PDF_COLORS.danger,
  warning:     PDF_COLORS.warning,
  success:     PDF_COLORS.success,
  purple:      SECTION3_PURPLE,
  cardBg:      PDF_COLORS.pageBg,
};

const FONT_REG  = PDF_FONTS.sans;
const FONT_BOLD = PDF_FONTS.sansBold;
const FONT_OBL  = PDF_FONTS.sansOblique;

const PAGE = PDF_PAGE; // same LETTER / 54pt-margin / 504pt-content geometry

// ── severity display ──────────────────────────────────────────────────────────

// [NETA-8-6] Show the NETA condition terminology a facility/PE expects, and give
// each severity its own colour (the old code rendered every non-immediate badge
// in the same grey, so a C2 "repair as scheduled" looked identical to a C1
// advisory). Map ServiceCycle severities to NETA condition classes:
//   IMMEDIATE   -> NETA C3 / Defective: de-energize / repair now
//   RECOMMENDED -> NETA C2 / Deteriorated: repair as scheduled
//   ADVISORY    -> NETA C1 / Monitor: advisory
function severityColor(severity: string): string {
  if (severity === 'IMMEDIATE') return C.danger;
  if (severity === 'RECOMMENDED') return C.warning;
  if (severity === 'ADVISORY') return C.accent;   // distinct from IMMEDIATE/RECOMMENDED
  return C.subtext;
}

function severityLabel(severity: string): string {
  if (severity === 'IMMEDIATE') return 'C3 · IMMEDIATE';
  if (severity === 'RECOMMENDED') return 'C2 · REPAIR';
  if (severity === 'ADVISORY') return 'C1 · MONITOR';
  return 'ADVISORY';
}

// One-line plain-English gloss of the NETA condition class, shown under the badge.
function severityConditionNote(severity: string): string {
  if (severity === 'IMMEDIATE') return 'NETA Condition C3 (Defective) — de-energize / repair now.';
  if (severity === 'RECOMMENDED') return 'NETA Condition C2 (Deteriorated) — repair as scheduled.';
  if (severity === 'ADVISORY') return 'NETA Condition C1 — monitor; advisory only.';
  return '';
}

// ── helpers ───────────────────────────────────────────────────────────────────

// [CFO-8-3] Format cents → dollars with 2 decimals and NO lossy rounding of the
// underlying figure, so the "What to Budget For" ranges tie to the rate card and
// to every other PDF/CSV that reads the same minCents/maxCents. (e.g. 1234550
// cents prints "$12,345.50", not "$12,346".)
function fmtMoney(cents: number): string {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '$0.00';
  return '$' + (n / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function assetLabel(a: any): string {
  const parts: string[] = [];
  if (a.equipmentType) parts.push((a.equipmentType as string).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()));
  if (a.manufacturer)  parts.push(a.manufacturer);
  if (a.model)         parts.push(a.model);
  if (a.serialNumber)  parts.push(`S/N ${a.serialNumber}`);
  return parts.join(' ') || 'Unknown asset';
}

// ── PDF renderer ─────────────────────────────────────────────────────────────

export interface LeaveBehindData {
  workOrder: {
    id: string;
    scheduledDate: Date | null;
    completedDate: Date | null;
    asset: any;
    account: { companyName: string; serviceRepName?: string | null; serviceRepPhone?: string | null };
    // [NETA-8-7] contractor carries NETA-accreditation for the certification line;
    // technician is the assigned ContractorTech or login user who performed the work.
    contractor: { name: string; netaAccredited?: boolean | null } | null;
    technicianName?: string | null;
    netaDecal?: string | null;
    asLeftCondition?: string | null;
  };
  deficiencies: Array<{
    severity: string;
    description: string;
    correctiveAction: string | null;
    resolvedAt: Date | null;
  }>;
  openQuoteRequests: Array<{
    triggerType: string | null;
    notes: string | null;
    asset: any;
    createdAt: Date;
  }>;
  modernizationAssets: Array<{
    equipmentType: string;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    modernizationRiskScore: number | null;
    site: { name: string } | null;
    rateMin: number | null;
    rateMax: number | null;
    rateServiceType: string | null;
  }>;
  // #15 co-branding — null for direct (non-channel) accounts.
  branding?: PartnerBranding | null;
}

export function renderLeaveBehindPdf(data: LeaveBehindData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin }, autoFirstPage: true, bufferPages: true });

    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end',  () => settle(() => resolve(Buffer.concat(chunks))));
    doc.on('error', (e: Error) => settle(() => reject(e)));

    let y = PAGE.margin;
    const M = PAGE.margin;
    const W = PAGE.contentW;

    // ── Header band ──────────────────────────────────────────────────────────
    // #15 co-brand: use the contractor's accent color for the band when present.
    const headerBg = data.branding?.primaryColor || C.bg;
    doc.rect(0, 0, PAGE.width, 78).fill(headerBg);
    // Thin brand accent rule grounds the band and reads as a finished masthead.
    doc.rect(0, 78, PAGE.width, 3).fill(data.branding?.primaryColor ? C.bg : C.accent);
    doc.font(FONT_BOLD).fontSize(17).fillColor(C.textOnDark)
       .text('Service Completion Report', M, 18, { width: W });
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(C.textOnDark)
       .text(data.workOrder.account.companyName, M, 40, { width: W });
    doc.font(FONT_REG).fontSize(8.5).fillColor(C.textMuted)
       .text(`Work Order ${data.workOrder.id.slice(-8).toUpperCase()}  ·  Completed ${data.workOrder.completedDate ? new Date(data.workOrder.completedDate).toLocaleDateString() : '—'}`, M, 53, { width: W });

    doc.font(FONT_REG).fontSize(7.5).fillColor(C.textMuted)
       .text(`${coBrandLine(data.branding)} · Summary leave-behind for the facility representative.`, M, 65, { width: W });

    y = 96;

    // ── Asset summary bar ────────────────────────────────────────────────────
    // Light card panel makes the equipment identity read as one grounded block.
    const asset = data.workOrder.asset;
    const cardY = y;
    let cardLines = 1;
    if (asset?.site?.name) cardLines++;
    if (data.workOrder.contractor) cardLines++;
    const cardH = 22 + cardLines * 13 + 4;
    doc.rect(M, cardY, W, cardH).fill(C.cardBg);
    doc.rect(M, cardY, 3, cardH).fill(C.accent);
    doc.rect(M, cardY, W, cardH).strokeColor(C.border).lineWidth(0.75).stroke();
    let cy = cardY + 9;
    doc.font(FONT_REG).fontSize(7).fillColor(C.subtext).text('ASSET', M + 12, cy);
    doc.font(FONT_BOLD).fontSize(10.5).fillColor(C.text).text(assetLabel(asset), M + 12, cy + 8, { width: W - 24 });
    cy += 24;
    if (asset?.site?.name) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('Site: ', M + 12, cy, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(asset.site.name);
      cy += 13;
    }
    if (data.workOrder.contractor) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('Performed by: ', M + 12, cy, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(data.workOrder.contractor.name);
      cy += 13;
    }
    y = cardY + cardH + 16;

    // ── SECTION 1: What We Found ─────────────────────────────────────────────
    // Numbered chip + heading reads as a clean executive section marker.
    doc.rect(M, y, 18, 18).fill(C.accent);
    doc.font(FONT_BOLD).fontSize(11).fillColor('#fff').text('1', M, y + 4, { width: 18, align: 'center' });
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.accent).text('What We Found', M + 26, y + 2);
    y += 26;

    const found = data.deficiencies;
    if (found.length === 0) {
      doc.font(FONT_OBL).fontSize(10).fillColor(C.subtext)
         .text('No deficiencies were recorded during this inspection.', M, y);
      y += 20;
    } else {
      for (const def of found) {
        if (y > PAGE.height - 120) { doc.addPage(); y = PAGE.margin; }

        const sColor = severityColor(def.severity);
        const sLabel = severityLabel(def.severity);

        // Severity badge — NETA condition class (C1/C2/C3), severity-coloured.
        const badgeW = 96;
        doc.rect(M, y, badgeW, 17).fill(sColor);
        doc.font(FONT_BOLD).fontSize(8).fillColor('#fff')
           .text(sLabel, M + 4, y + 5, { width: badgeW - 8, align: 'center' });

        // Description — height MEASURED so a 2-line description never collides
        // with the condition note beneath it. Advance past whichever is taller:
        // the severity badge (17) or the wrapped description.
        const descW = W - badgeW - 10;
        const descTxt = def.description.slice(0, 200);
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text);
        const descH = doc.heightOfString(descTxt, { width: descW });
        doc.text(descTxt, M + badgeW + 10, y + 4, { width: descW });
        y += Math.max(17, descH + 4) + 5;

        // [NETA-8-6] One-line NETA condition gloss so the C-code is self-explaining.
        const condNote = severityConditionNote(def.severity);
        if (condNote) {
          doc.font(FONT_OBL).fontSize(7.5).fillColor(sColor);
          const condH = doc.heightOfString(condNote, { width: descW });
          doc.text(condNote, M + badgeW + 10, y, { width: descW });
          y += condH + 4;
        }

        if (def.correctiveAction && !def.resolvedAt) {
          const caTxt = `Recommended corrective action: ${def.correctiveAction.slice(0, 200)}`;
          doc.font(FONT_REG).fontSize(8).fillColor(C.subtext);
          const caH = doc.heightOfString(caTxt, { width: descW });
          doc.text(caTxt, M + badgeW + 10, y, { width: descW });
          y += caH + 4;
        }
        y += 8;
      }
    }
    y += 8;

    // ── SECTION 2: What We Fixed ─────────────────────────────────────────────
    if (y > PAGE.height - 80) { doc.addPage(); y = PAGE.margin; }

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 14;
    doc.rect(M, y, 18, 18).fill(C.success);
    doc.font(FONT_BOLD).fontSize(11).fillColor('#fff').text('2', M, y + 4, { width: 18, align: 'center' });
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.success).text('What We Fixed', M + 26, y + 2);
    y += 26;

    const fixed = data.deficiencies.filter((d) => d.resolvedAt !== null);
    if (fixed.length === 0) {
      doc.font(FONT_OBL).fontSize(10).fillColor(C.subtext)
         .text('No corrective actions were completed during this visit.', M, y);
      y += 20;
    } else {
      for (const def of fixed) {
        if (y > PAGE.height - 80) { doc.addPage(); y = PAGE.margin; }

        doc.rect(M, y, 8, 8).fill(C.success);
        const fDescTxt = def.description.slice(0, 200);
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text);
        const fDescH = doc.heightOfString(fDescTxt, { width: W - 14 });
        doc.text(fDescTxt, M + 14, y, { width: W - 14 });
        y += Math.max(10, fDescH) + 4;
        if (def.correctiveAction) {
          const actTxt = `Action taken: ${def.correctiveAction.slice(0, 200)}`;
          doc.font(FONT_REG).fontSize(8).fillColor(C.subtext);
          const actH = doc.heightOfString(actTxt, { width: W - 14 });
          doc.text(actTxt, M + 14, y, { width: W - 14 });
          y += actH + 4;
        }
        y += 6;
      }
    }
    y += 8;

    // ── SECTION 3: What to Budget For ────────────────────────────────────────
    if (y > PAGE.height - 120) { doc.addPage(); y = PAGE.margin; }

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 14;
    doc.rect(M, y, 18, 18).fill(C.purple);
    doc.font(FONT_BOLD).fontSize(11).fillColor('#fff').text('3', M, y + 4, { width: 18, align: 'center' });
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.purple).text('What to Budget For', M + 26, y + 2);
    y += 12;
    const discTxt = 'BUDGET PLANNING ESTIMATES ONLY. Figures are probabilistic ranges derived from IEEE/NFPA/NETA equipment-life models and published service benchmarks. Actual costs vary by site, equipment configuration, and local labor. These estimates are not formal quotes, engineering assessments, or guarantees of equipment condition or remaining useful life. Consult a licensed electrical engineer before making capital replacement decisions.';
    doc.font(FONT_OBL).fontSize(8).fillColor(C.subtext);
    const discH = doc.heightOfString(discTxt, { width: W });
    doc.text(discTxt, M, y + 14, { width: W });
    // Measured disclaimer height + gap so the ASSET column header never draws on
    // top of the disclaimer's last lines.
    y += 14 + discH + 10;

    const budgetItems: Array<{ label: string; range: string; note: string }> = [];

    // From open QuoteRequests
    for (const qr of data.openQuoteRequests) {
      const label = assetLabel(qr.asset);
      const trigger = qr.triggerType ?? 'Service needed';
      budgetItems.push({
        label,
        range: 'Contact rep for estimate',
        note:  trigger.replace(/_/g, ' '),
      });
    }

    // From modernization risk assets
    for (const a of data.modernizationAssets) {
      const label     = assetLabel(a);
      const scoreStr  = a.modernizationRiskScore != null ? `Risk score: ${(a.modernizationRiskScore * 100).toFixed(0)}%` : '';
      const rangeStr  = (a.rateMin != null && a.rateMax != null)
        ? `${fmtMoney(a.rateMin)} – ${fmtMoney(a.rateMax)}`
        : 'Contact rep for estimate';
      budgetItems.push({
        label,
        range: rangeStr,
        note:  scoreStr,
      });
    }

    if (budgetItems.length === 0) {
      doc.font(FONT_OBL).fontSize(10).fillColor(C.subtext)
         .text('No open service opportunities or at-risk assets identified for this account at this time.', M, y);
      y += 20;
    } else {
      // List EVERY at-risk asset — the customer deserves the full findings even
      // if Section 3 flows onto additional pages. Capping the list reads like we
      // are hiding something. Items arrive QuoteRequests-first, then modernization
      // assets in descending risk order.
      const ROW_H = 16;

      // Deterministic single-line fit: measure with widthOfString and trim with
      // an ellipsis. pdfkit's lineBreak:false + ellipsis options proved unreliable
      // here (a too-wide label still wrapped to a 2nd line and overlapped the next
      // row), so we truncate to the column width ourselves before drawing.
      const fitOneLine = (s: any, maxW: number, font: string, size: number): string => {
        doc.font(font).fontSize(size);
        const str = String(s ?? '');
        if (doc.widthOfString(str) <= maxW) return str;
        let t = str;
        while (t.length > 1 && doc.widthOfString(t + '…') > maxW) t = t.slice(0, -1);
        return t.replace(/\s+$/, '') + '…';
      };

      // Column-header band. Extracted so it can be redrawn after a page break —
      // a continued table must never show headerless rows.
      const drawBudgetHeader = () => {
        doc.rect(M, y - 2, W, 15).fill(C.cardBg);
        doc.font(FONT_BOLD).fontSize(7.5).fillColor(C.subtext)
           .text('ASSET', M + 4, y + 1, { lineBreak: false })
           .text('ESTIMATED RANGE', M + 228, y + 1, { lineBreak: false })
           .text('NOTE', M + 376, y + 1, { lineBreak: false });
        y += 15;
        doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).lineWidth(0.75).stroke();
        y += 6;
      };
      drawBudgetHeader();

      for (const item of budgetItems) {
        // Break BEFORE any row that would cross the bottom margin, with a full
        // row of headroom so no single cell can auto-paginate on its own (the
        // old bug: a row's three cells scattered across three pages). Redraw the
        // header on the continuation page.
        if (y + ROW_H > PAGE.height - PAGE.margin) {
          doc.addPage();
          y = PAGE.margin;
          drawBudgetHeader();
        }

        // Each cell pre-fitted to its column width -> exactly one line: no wrap
        // (which used to overlap the next row) and no auto-pagination.
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text)
           .text(fitOneLine(item.label, 214, FONT_BOLD, 9), M + 4, y, { lineBreak: false });
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.accent)
           .text(fitOneLine(item.range, 140, FONT_BOLD, 9), M + 228, y, { lineBreak: false });
        doc.font(FONT_OBL).fontSize(8).fillColor(C.subtext)
           .text(fitOneLine(item.note, W - 376 - 4, FONT_OBL, 8), M + 376, y, { lineBreak: false });
        y += ROW_H;
        doc.moveTo(M, y - 4).lineTo(M + W, y - 4).strokeColor(PDF_COLORS.borderSubtle).lineWidth(0.5).stroke();
      }
    }

    y += 16;

    // ── Performed-by / certification / signature block ───────────────────────
    // [NETA-8-7] A leave-behind a customer can rely on must record WHO performed
    // the work, their company + NETA accreditation, the as-left condition / decal,
    // and carry a signature line. Uses data already on the work order — no schema.
    if (y > PAGE.height - 150) { doc.addPage(); y = PAGE.margin; }
    // Formal sign-off panel — petrol header bar sets it apart as the certification block.
    doc.rect(M, y, W, 22).fill(C.accent);
    doc.font(FONT_BOLD).fontSize(11).fillColor(C.textOnDark).text('Performed By & Certification', M + 12, y + 6);
    y += 32;

    const company = data.workOrder.contractor?.name || data.workOrder.account.companyName;
    const accredited = !!data.workOrder.contractor?.netaAccredited;
    doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
       .text('Company: ', M + 4, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(company);
    y += 14;
    doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
       .text('Certification: ', M + 4, y, { continued: true })
       .font(FONT_BOLD).fillColor(accredited ? C.success : C.text)
       .text(accredited ? 'NETA-accredited company' : 'Per company qualification program (NFPA 70E qualified person)');
    y += 14;
    if (data.workOrder.technicianName) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('Technician: ', M + 4, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(data.workOrder.technicianName);
      y += 14;
    }
    const asLeft = data.workOrder.asLeftCondition || data.workOrder.netaDecal;
    if (asLeft) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('As-left condition (NETA MTS): ', M + 4, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(String(asLeft));
      y += 14;
    }
    y += 12;

    // Signature + date lines (two columns).
    const colGap = 24;
    const sigW = (W - colGap) / 2;
    const sigY = y + 18;
    doc.moveTo(M, sigY).lineTo(M + sigW, sigY).strokeColor(C.border).stroke();
    doc.moveTo(M + sigW + colGap, sigY).lineTo(M + W, sigY).strokeColor(C.border).stroke();
    doc.font(FONT_REG).fontSize(7.5).fillColor(C.subtext)
       .text('Technician signature', M, sigY + 3, { width: sigW })
       .text('Date', M + sigW + colGap, sigY + 3, { width: sigW });
    y = sigY + 20;

    // ── Footer ────────────────────────────────────────────────────────────────
    if (y > PAGE.height - 60) { doc.addPage(); y = PAGE.margin; }

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 8;

    const repLine = data.workOrder.account.serviceRepName
      ? `Questions? Contact your service rep: ${data.workOrder.account.serviceRepName}${data.workOrder.account.serviceRepPhone ? ` · ${data.workOrder.account.serviceRepPhone}` : ''}`
      : 'Log in to ServiceCycle to view your full compliance calendar and request a quote.';

    doc.font(FONT_REG).fontSize(8).fillColor(C.subtext)
       .text(repLine, M, y, { width: W });
    y += 11;
    doc.font(FONT_OBL).fontSize(7).fillColor(PDF_COLORS.textFaint)
       .text('DISCLAIMER: This report was generated by ServiceCycle using IEEE/NFPA/NETA equipment-life models and condition ratings provided by the service technician. RUL scores and cost ranges are probabilistic estimates, not engineering opinions or guarantees. Equipment may fail before or after any modeled threshold. Do not rely solely on this report for life-safety or capital replacement decisions — engage a licensed professional engineer for critical assessments.', M, y, { width: W });

    // C2a: standard page footers (PAGE N OF M) via the shared theme; the doc
    // is created with bufferPages so finalizeFooters can stamp totals.
    finalizeFooters(doc, {
      generatedAtIso: new Date().toISOString(),
      docId: `WO ${data.workOrder.id.slice(-8).toUpperCase()}`,
    });
    doc.end();
  });
}
