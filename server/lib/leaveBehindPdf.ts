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

function severityColor(severity: string): string {
  if (severity === 'IMMEDIATE') return C.danger;
  if (severity === 'RECOMMENDED') return C.warning;
  return C.subtext;
}

function severityLabel(severity: string): string {
  if (severity === 'IMMEDIATE') return 'IMMEDIATE';
  if (severity === 'RECOMMENDED') return 'Recommended';
  return 'Advisory';
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(cents: number): string {
  return '$' + Math.round(cents / 100).toLocaleString();
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
    contractor: { name: string } | null;
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
    doc.rect(0, 0, PAGE.width, 72).fill(C.bg);
    doc.font(FONT_BOLD).fontSize(16).fillColor(C.textOnDark)
       .text('Service Completion Report', M, 18, { width: W });
    doc.font(FONT_REG).fontSize(9).fillColor(C.textMuted)
       .text(data.workOrder.account.companyName, M, 36)
       .text(`Work Order ${data.workOrder.id.slice(-8).toUpperCase()} · Completed ${data.workOrder.completedDate ? new Date(data.workOrder.completedDate).toLocaleDateString() : '—'}`, M, 48);

    doc.font(FONT_REG).fontSize(8).fillColor(C.textMuted)
       .text('Prepared by ServiceCycle · This document is a summary leave-behind for the facility representative.', M, 60, { width: W });

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

        // Severity badge
        const badgeW = 80;
        doc.rect(M, y, badgeW, 16).fill(sColor);
        doc.font(FONT_BOLD).fontSize(8).fillColor('#fff')
           .text(sLabel, M + 4, y + 4, { width: badgeW - 8, align: 'center' });

        // Description
        doc.font(FONT_BOLD).fontSize(9).fillColor(C.text)
           .text(def.description.slice(0, 200), M + badgeW + 8, y, { width: W - badgeW - 8 });
        y += 20;

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
       .text('Estimated CapEx exposure based on asset age, condition, and platform rate benchmarks. Ranges, not point estimates — site conditions, complexity, and lead times affect final pricing.', M, y + 14, { width: W });
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
       .text('This report was generated by ServiceCycle. Rate ranges are platform benchmarks; actual costs depend on site conditions and are not binding quotes.', M, y, { width: W });

    doc.end();
  });
}
