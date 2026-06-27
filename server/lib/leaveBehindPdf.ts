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

// ── Palette (matches compliancePdf.ts house style) ───────────────────────────
const C = {
  bg:          '#0a0d12',
  textOnDark:  '#ffffff',
  textMuted:   '#9aa3b2',
  text:        '#0a0d12',
  subtext:     '#5b6373',
  border:      '#dde2eb',
  accent:      '#0d4f6e',
  danger:      '#b91c1c',
  warning:     '#b45309',
  success:     '#15803d',
  purple:      '#7c3aed',
  cardBg:      '#fafbfd',
};

const FONT_REG  = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_OBL  = 'Helvetica-Oblique';

const PAGE = {
  margin:   54,
  width:    612,
  height:   792,
  contentW: 612 - 54 * 2,  // 504
};

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
    doc.rect(0, 0, PAGE.width, 72).fill(headerBg);
    doc.font(FONT_BOLD).fontSize(16).fillColor(C.textOnDark)
       .text('Service Completion Report', M, 18, { width: W });
    doc.font(FONT_REG).fontSize(9).fillColor(C.textMuted)
       .text(data.workOrder.account.companyName, M, 36)
       .text(`Work Order ${data.workOrder.id.slice(-8).toUpperCase()} · Completed ${data.workOrder.completedDate ? new Date(data.workOrder.completedDate).toLocaleDateString() : '—'}`, M, 48);

    doc.font(FONT_REG).fontSize(8).fillColor(C.textMuted)
       .text(`${coBrandLine(data.branding)} · This document is a summary leave-behind for the facility representative.`, M, 60, { width: W });

    y = 84;

    // ── Asset summary bar ────────────────────────────────────────────────────
    const asset = data.workOrder.asset;
    doc.font(FONT_BOLD).fontSize(10).fillColor(C.text)
       .text('Asset: ', M, y, { continued: true })
       .font(FONT_REG).text(assetLabel(asset));
    y += 14;
    if (asset?.site?.name) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text(`Site: ${asset.site.name}`, M, y);
      y += 12;
    }
    if (data.workOrder.contractor) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text(`Performed by: ${data.workOrder.contractor.name}`, M, y);
      y += 12;
    }
    y += 8;

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 12;

    // ── SECTION 1: What We Found ─────────────────────────────────────────────
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.accent)
       .text('1  What We Found', M, y);
    y += 18;

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
        doc.rect(M, y, badgeW, 16).fill(sColor);
        doc.font(FONT_BOLD).fontSize(8).fillColor('#fff')
           .text(sLabel, M + 4, y + 4, { width: badgeW - 8, align: 'center' });

        // Description
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text)
           .text(def.description.slice(0, 200), M + badgeW + 8, y, { width: W - badgeW - 8 });
        y += 20;

        // [NETA-8-6] One-line NETA condition gloss so the C-code is self-explaining.
        const condNote = severityConditionNote(def.severity);
        if (condNote) {
          doc.font(FONT_OBL).fontSize(7.5).fillColor(sColor)
             .text(condNote, M + badgeW + 8, y, { width: W - badgeW - 8 });
          y += 11;
        }

        if (def.correctiveAction && !def.resolvedAt) {
          doc.font(FONT_REG).fontSize(8).fillColor(C.subtext)
             .text(`Recommended corrective action: ${def.correctiveAction.slice(0, 200)}`, M + badgeW + 8, y, { width: W - badgeW - 8 });
          y += 14;
        }
        y += 4;
      }
    }
    y += 8;

    // ── SECTION 2: What We Fixed ─────────────────────────────────────────────
    if (y > PAGE.height - 80) { doc.addPage(); y = PAGE.margin; }

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 12;
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.success)
       .text('2  What We Fixed', M, y);
    y += 18;

    const fixed = data.deficiencies.filter((d) => d.resolvedAt !== null);
    if (fixed.length === 0) {
      doc.font(FONT_OBL).fontSize(10).fillColor(C.subtext)
         .text('No corrective actions were completed during this visit.', M, y);
      y += 20;
    } else {
      for (const def of fixed) {
        if (y > PAGE.height - 80) { doc.addPage(); y = PAGE.margin; }

        doc.rect(M, y, 8, 8).fill(C.success);
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text)
           .text(def.description.slice(0, 200), M + 14, y, { width: W - 14 });
        y += 14;
        if (def.correctiveAction) {
          doc.font(FONT_REG).fontSize(8).fillColor(C.subtext)
             .text(`Action taken: ${def.correctiveAction.slice(0, 200)}`, M + 14, y, { width: W - 14 });
          y += 12;
        }
        y += 4;
      }
    }
    y += 8;

    // ── SECTION 3: What to Budget For ────────────────────────────────────────
    if (y > PAGE.height - 120) { doc.addPage(); y = PAGE.margin; }

    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 12;
    doc.font(FONT_BOLD).fontSize(13).fillColor(C.purple)
       .text('3  What to Budget For', M, y);
    y += 6;
    doc.font(FONT_OBL).fontSize(8).fillColor(C.subtext)
       .text('BUDGET PLANNING ESTIMATES ONLY. Figures are probabilistic ranges derived from IEEE/NFPA/NETA equipment-life models and published service benchmarks. Actual costs vary by site, equipment configuration, and local labor. These estimates are not formal quotes, engineering assessments, or guarantees of equipment condition or remaining useful life. Consult a licensed electrical engineer before making capital replacement decisions.', M, y + 14, { width: W });
    y += 34;

    const budgetItems: Array<{ label: string; range: string; note: string }> = [];

    // From open QuoteRequests
    for (const qr of data.openQuoteRequests) {
      const label = assetLabel(qr.asset);
      const trigger = qr.triggerType ?? 'Service needed';
      budgetItems.push({
        label,
        range: '— contact rep for estimate',
        note:  trigger.replace(/_/g, ' '),
      });
    }

    // From modernization risk assets
    for (const a of data.modernizationAssets) {
      const label     = assetLabel(a);
      const scoreStr  = a.modernizationRiskScore != null ? `Risk score: ${(a.modernizationRiskScore * 100).toFixed(0)}%` : '';
      const rangeStr  = (a.rateMin != null && a.rateMax != null)
        ? `${fmtMoney(a.rateMin)} – ${fmtMoney(a.rateMax)}`
        : '— contact rep for estimate';
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
      // Column header row
      doc.font(FONT_BOLD).fontSize(8).fillColor(C.subtext)
         .text('ASSET', M, y, { width: 220 })
         .text('ESTIMATED RANGE', M + 228, y, { width: 140 })
         .text('NOTE', M + 376, y, { width: W - 376 });
      y += 14;
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
      y += 6;

      for (const item of budgetItems) {
        if (y > PAGE.height - 60) { doc.addPage(); y = PAGE.margin; }

        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text)
           .text(item.label.slice(0, 45), M, y, { width: 220 });
        doc.font(FONT_REG).fontSize(9).fillColor(C.text)
           .text(item.range, M + 228, y, { width: 140 });
        doc.font(FONT_OBL).fontSize(8).fillColor(C.subtext)
           .text(item.note.slice(0, 60), M + 376, y, { width: W - 376 });
        y += 16;
      }
    }

    y += 16;

    // ── Performed-by / certification / signature block ───────────────────────
    // [NETA-8-7] A leave-behind a customer can rely on must record WHO performed
    // the work, their company + NETA accreditation, the as-left condition / decal,
    // and carry a signature line. Uses data already on the work order — no schema.
    if (y > PAGE.height - 140) { doc.addPage(); y = PAGE.margin; }
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(C.border).stroke();
    y += 12;
    doc.font(FONT_BOLD).fontSize(11).fillColor(C.text).text('Performed By & Certification', M, y);
    y += 16;

    const company = data.workOrder.contractor?.name || data.workOrder.account.companyName;
    const accredited = !!data.workOrder.contractor?.netaAccredited;
    doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
       .text('Company: ', M, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(company);
    y += 13;
    doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
       .text('Certification: ', M, y, { continued: true })
       .font(FONT_BOLD).fillColor(accredited ? C.success : C.text)
       .text(accredited ? 'NETA-accredited company' : 'Per company qualification program (NFPA 70E qualified person)');
    y += 13;
    if (data.workOrder.technicianName) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('Technician: ', M, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(data.workOrder.technicianName);
      y += 13;
    }
    const asLeft = data.workOrder.asLeftCondition || data.workOrder.netaDecal;
    if (asLeft) {
      doc.font(FONT_REG).fontSize(9).fillColor(C.subtext)
         .text('As-left condition (NETA MTS): ', M, y, { continued: true }).font(FONT_BOLD).fillColor(C.text).text(String(asLeft));
      y += 13;
    }
    y += 10;

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
    doc.font(FONT_OBL).fontSize(7).fillColor('#9ca3af')
       .text('DISCLAIMER: This report was generated by ServiceCycle using IEEE/NFPA/NETA equipment-life models and condition ratings provided by the service technician. RUL scores and cost ranges are probabilistic estimates, not engineering opinions or guarantees. Equipment may fail before or after any modeled threshold. Do not rely solely on this report for life-safety or capital replacement decisions — engage a licensed professional engineer for critical assessments.', M, y, { width: W });

    doc.end();
  });
}
