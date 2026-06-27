'use strict';

/**
 * cfoReport.ts — #30 quarterly board-grade CFO report.
 *
 *   buildCfoReportData(prisma, accountId) -> data bundle
 *   renderCfoReportPdf(data, meta)        -> Promise<Buffer>
 *
 * A budget-season artifact: compliance trajectory, this-quarter activity, open
 * risk by severity, and an estimated remediation spend. Honest-by-construction
 * (carries the same ESTIMATE / NOT-A-CERTIFICATION framing as compliancePdf)
 * and accumulates into a Buffer so the caller can hash + attach it.
 *
 * pdfkit stream-hardening mirrors lib/compliancePdf (error handler bound before
 * any write, footer recursion guard, settled flag).
 */

const PDFDocument = require('pdfkit');
const { buildComplianceGap } = require('./complianceReport');
const { buildMaintenanceDebtData } = require('./maintenanceDebt');

const MS_PER_DAY = 86_400_000;

const COLORS = {
  bgDark: '#0a0d12', textOnDark: '#ffffff', textOnDarkMuted: '#9aa3b2',
  text: '#0a0d12', textMuted: '#5b6373', textSubtle: '#9aa3b2',
  border: '#dde2eb', accent: '#0d4f6e', cardBg: '#fafbfd',
  danger: '#b91c1c', warn: '#b45309', ok: '#15803d',
};
const FONT_REG = 'Helvetica', FONT_BOLD = 'Helvetica-Bold', FONT_OBL = 'Helvetica-Oblique';
const PAGE = { margin: 54, width: 612, height: 792, contentW: 504 };
const BOTTOM = PAGE.height - PAGE.margin;

// Locale helpers — default to en-US/USD; override via env vars for non-US customers.
import { DEFAULT_LOCALE, DEFAULT_CURRENCY } from './locale';

function fmtDate(d: any) { if (!d) return '—'; try { return new Date(d).toISOString().slice(0, 10); } catch { return '—'; } }
function fmtMoney(n: any) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: DEFAULT_CURRENCY, maximumFractionDigits: 0 }).format(Math.round(Number(n)));
}

// ── data builder ────────────────────────────────────────────────────────────────

async function buildCfoReportData(prisma: any, accountId: string) {
  const now = new Date();
  const quarterAgo = new Date(now.getTime() - 90 * MS_PER_DAY);
  const assetScope = { archivedAt: null, inService: true };

  const [account, gap, defsBySeverity, wosThisQuarter, quarterWoCosts, defsOpened, defsClosed, snapshots, openDefs, debt] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } }),
    buildComplianceGap(prisma, accountId, {}),
    prisma.deficiency.groupBy({ by: ['severity'], where: { accountId, resolvedAt: null }, _count: true }),
    prisma.workOrder.count({ where: { accountId, status: 'COMPLETE', completedDate: { gte: quarterAgo, lte: now } } }),
    // CFO-8-13: realized spend lives on work orders in CENTS (laborCostCents +
    // Σ partsUsed.unitCostCents × quantityUsed). Fetch the quarter's completed
    // WOs with their cost fields so we can report ACTUAL spend (cents→dollars,
    // converted once) alongside the repairCostEstimate forecast (already dollars)
    // — the two had never been reconciled and live in different units.
    prisma.workOrder.findMany({
      where: { accountId, status: 'COMPLETE', completedDate: { gte: quarterAgo, lte: now } },
      select: { laborCostCents: true, partsUsed: { select: { unitCostCents: true, quantityUsed: true } } },
    }),
    prisma.deficiency.count({ where: { accountId, createdAt: { gte: quarterAgo, lte: now } } }),
    prisma.deficiency.count({ where: { accountId, resolvedAt: { gte: quarterAgo, lte: now } } }),
    prisma.complianceSnapshot.findMany({
      where: { accountId, kind: 'compliance' },
      orderBy: { createdAt: 'desc' }, take: 6,
      select: { createdAt: true, stats: true },
    }),
    prisma.deficiency.findMany({ where: { accountId, resolvedAt: null }, select: { assetId: true } }),
    buildMaintenanceDebtData(prisma, accountId),
  ]);

  const severity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  for (const r of defsBySeverity) severity[r.severity] = r._count;

  // CFO-8-13: sum realized work-order spend in CENTS, then convert to dollars
  // ONCE so it shares the same unit as every other figure in this report.
  let realizedCents = 0;
  for (const wo of (quarterWoCosts as any[])) {
    realizedCents += Number(wo.laborCostCents) || 0;
    for (const p of (wo.partsUsed || [])) {
      realizedCents += (Number(p.unitCostCents) || 0) * (Number(p.quantityUsed) || 0);
    }
  }
  const realizedQuarterSpend = Math.round(realizedCents / 100); // dollars

  // Estimated remediation spend: sum repairCostEstimate (DOLLARS) over the
  // distinct assets that carry at least one open deficiency. CFO-8-8: this is a
  // KNOWN-SCOPED SUBSET ONLY — assets without an estimate are excluded, so the
  // figure is a floor, not the full exposure. We surface the coverage counts
  // (assetsWithCostEstimate of assetsWithOpenDeficiencies) so the PDF can show
  // the basis with equal visual weight rather than burying it.
  const assetIds = Array.from(new Set(openDefs.map((d: any) => d.assetId)));
  let estimatedSpend = 0;
  let assetsWithEstimate = 0;
  if (assetIds.length > 0) {
    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds }, accountId },
      select: { repairCostEstimate: true },
    });
    for (const a of assets) {
      if (a.repairCostEstimate != null) { estimatedSpend += Number(a.repairCostEstimate); assetsWithEstimate++; }
    }
  }
  const assetsWithoutEstimate = assetIds.length - assetsWithEstimate;

  // Compliance trajectory (CFO-8-12): the snapshot row is the tamper-evident,
  // hash-anchored record of what the customer was shown on that date, so the
  // trend MUST reflect the snapshot's own numbers — never a freshly-recomputed
  // rate under a different definition. Prefer a rate the snapshot recorded
  // as-stored (stats.complianceRate / stats.rate) if present; otherwise derive
  // it with the SAME formula the snapshot's PDF used — summarizeSchedules:
  // schedule compliance = current / (current + overdue), one decimal, excluding
  // unbaselined (this is the documented "schedule compliance" basis labeled in
  // the PDF below). Oldest first for a left-to-right read.
  const trajectory = snapshots.map((s: any) => {
    const st = s.stats || {};
    let rate: number | null;
    const storedRate = st.complianceRate ?? st.rate;
    if (storedRate != null && Number.isFinite(Number(storedRate))) {
      rate = Number(storedRate);
    } else {
      const cur = Number(st.current ?? 0), ovd = Number(st.overdue ?? 0);
      const denom = cur + ovd;
      rate = denom > 0 ? Math.round((cur / denom) * 1000) / 10 : null;
    }
    return { date: s.createdAt, rate, assets: st.assets ?? null, overdue: st.overdue ?? null };
  }).reverse();

  return {
    accountName: account?.companyName || 'Account',
    generatedAt: now,
    overallRate: gap.overallRate,
    coverageRate: gap.coverage?.rate ?? null,
    openActions: gap.summary?.totalActions ?? 0,
    severity,
    quarter: {
      workOrdersCompleted: wosThisQuarter,
      deficienciesOpened: defsOpened,
      deficienciesClosed: defsClosed,
      realizedSpend: realizedQuarterSpend, // CFO-8-13: ACTUAL WO spend, dollars
    },
    spend: {
      estimatedRemediation: estimatedSpend, // dollars; KNOWN-SCOPED SUBSET only
      assetsWithOpenDeficiencies: assetIds.length,
      assetsWithCostEstimate: assetsWithEstimate,
      assetsWithoutCostEstimate: assetsWithoutEstimate, // CFO-8-8: uncovered count
      coverageComplete: assetIds.length > 0 && assetsWithoutEstimate === 0,
    },
    debtPlan: {
      year1: debt.plan.year1,
      year3: debt.plan.year3,
      year5: debt.plan.year5,
      totals: debt.totals,
      siteCount: debt.bySite.length,
    },
    trajectory,
  };
}

// ── PDF renderer ──────────────────────────────────────────────────────────────

function drawFooter(doc: any, meta: any, pageNum: number) {
  if (doc._renderingFooter) return;
  doc._renderingFooter = true;
  try {
    const y = doc.page.height - PAGE.margin + 10;
    doc.moveTo(PAGE.margin, y).lineTo(doc.page.width - PAGE.margin, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8)
       .text(`${meta.brandName ? meta.brandName + ' · ' : ''}Generated by ServiceCycle — ${meta.generatedAtIso}`, PAGE.margin, y + 4, { align: 'left', lineBreak: false });
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8)
       .text(`Page ${pageNum}`, PAGE.margin, y + 4, { align: 'right', lineBreak: false });
  } finally { doc._renderingFooter = false; }
}

function statCard(doc: any, x: number, y: number, w: number, value: string, label: string, color: string) {
  const h = 56;
  doc.rect(x, y, w, h).fill(COLORS.cardBg);
  doc.rect(x, y, w, h).strokeColor(COLORS.border).lineWidth(0.75).stroke();
  doc.fillColor(color).font(FONT_BOLD).fontSize(18).text(value, x, y + 10, { width: w, align: 'center', lineBreak: false });
  doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(8).text(label, x, y + 36, { width: w, align: 'center', lineBreak: false });
}

function renderCfoReportPdf(data: any, meta: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: { Title: `ServiceCycle Quarterly Compliance & Budget Report — ${data.accountName}`, Author: 'ServiceCycle', Creator: 'ServiceCycle compliance engine' },
    });

    const chunks: any[] = [];
    let settled = false;
    const fail = (err: any) => { if (settled) return; settled = true; try { doc.destroy(); } catch {} reject(err instanceof Error ? err : new Error(String(err))); };
    doc.on('error', fail);
    doc.on('data', (c: any) => chunks.push(c));
    doc.on('end', () => { if (settled) return; settled = true; resolve(Buffer.concat(chunks)); });

    let pageNum = 1;
    doc.on('pageAdded', () => { pageNum += 1; drawFooter(doc, meta, pageNum); });

    try {
      // Header band
      doc.rect(0, 0, doc.page.width, 96).fill(meta.brandColor || COLORS.bgDark);
      doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(22).text('ServiceCycle', PAGE.margin, 26, { lineBreak: false });
      doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(12).text('Quarterly Compliance & Budget Report', PAGE.margin, 56, { lineBreak: false });

      let y = 124;
      if (meta.brandName) {
        doc.font(FONT_REG).fontSize(10).fillColor(COLORS.textMuted).text(`Prepared by ${meta.brandName} · powered by ServiceCycle`, PAGE.margin, y, { width: PAGE.contentW });
        y = doc.y + 8;
      }
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(18).text(data.accountName, PAGE.margin, y, { width: PAGE.contentW });
      y = doc.y + 4;
      doc.fillColor(COLORS.textMuted).font(FONT_REG).fontSize(10).text(`Generated ${meta.generatedAtIso}`, PAGE.margin, y, { width: PAGE.contentW });
      y = doc.y + 16;

      // Headline stat cards
      const gw = (PAGE.contentW - 24) / 3;
      const rateColor = data.overallRate >= 90 ? COLORS.ok : data.overallRate >= 70 ? COLORS.warn : COLORS.danger;
      statCard(doc, PAGE.margin, y, gw, `${data.overallRate}%`, 'Overall readiness', rateColor);
      statCard(doc, PAGE.margin + gw + 12, y, gw, data.coverageRate == null ? 'n/a' : `${data.coverageRate}%`, 'Asset coverage', COLORS.text);
      statCard(doc, PAGE.margin + (gw + 12) * 2, y, gw, String(data.openActions), 'Open items to 100%', data.openActions > 0 ? COLORS.warn : COLORS.ok);
      y += 56 + 22;

      // This quarter
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('This quarter (last 90 days)', PAGE.margin, y); y = doc.y + 8;
      const q = data.quarter;
      doc.font(FONT_REG).fontSize(11).fillColor(COLORS.textMuted);
      doc.text(`Work orders completed: ${q.workOrdersCompleted}`, PAGE.margin, y); y = doc.y + 2;
      doc.text(`Deficiencies opened: ${q.deficienciesOpened}    closed: ${q.deficienciesClosed}`, PAGE.margin, y); y = doc.y + 2;
      // CFO-8-13: actual recorded WO spend this quarter (labor + parts, dollars).
      doc.text(`Recorded work-order spend: ${fmtMoney(q.realizedSpend)} (labor + parts on completed WOs)`, PAGE.margin, y); y = doc.y + 16;

      // Open risk by severity
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('Open risk by severity', PAGE.margin, y); y = doc.y + 8;
      const sev = data.severity;
      doc.font(FONT_REG).fontSize(11);
      doc.fillColor(COLORS.danger).text(`Immediate: ${sev.IMMEDIATE}`, PAGE.margin, y, { continued: true }).fillColor(COLORS.textMuted).text(`    Recommended: ${sev.RECOMMENDED}    Advisory: ${sev.ADVISORY}`);
      y = doc.y + 16;

      // Spend forecast (CFO-8-8: the headline is a KNOWN-SCOPED FLOOR, not the
      // full exposure. Title + an equal-weight coverage line make that explicit
      // so a board never reads the number as the total remediation cost.)
      const sp = data.spend;
      const spendTitle = sp.coverageComplete
        ? 'Estimated remediation spend'
        : 'Estimated remediation spend (scoped subset — floor)';
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text(spendTitle, PAGE.margin, y); y = doc.y + 8;
      doc.font(FONT_BOLD).fontSize(16).fillColor(COLORS.accent).text(fmtMoney(sp.estimatedRemediation), PAGE.margin, y); y = doc.y + 4;
      // Coverage stated at body weight (not buried in fine print) when incomplete.
      if (!sp.coverageComplete && sp.assetsWithoutCostEstimate > 0) {
        doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.warn)
           .text(`Covers ${sp.assetsWithCostEstimate} of ${sp.assetsWithOpenDeficiencies} deficient asset(s); ${sp.assetsWithoutCostEstimate} have no estimate and are NOT included — true exposure is higher.`, PAGE.margin, y, { width: PAGE.contentW, lineGap: 1 });
        y = doc.y + 4;
      }
      doc.font(FONT_OBL).fontSize(9).fillColor(COLORS.textMuted)
         .text(`Based on ${sp.assetsWithCostEstimate} of ${sp.assetsWithOpenDeficiencies} asset(s) with open deficiencies that carry a repair-cost estimate. Assets without an estimate are not included.`, PAGE.margin, y, { width: PAGE.contentW, lineGap: 1 });
      y = doc.y + 16;

      // Maintenance Debt Ledger — cumulative capital plan
      if (data.debtPlan) {
        if (y > BOTTOM - 90) { doc.addPage(); y = PAGE.margin; }
        const dp = data.debtPlan;
        const range = (r: any) => `${fmtMoney(r.min)} – ${fmtMoney(r.max)}`;
        doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('Maintenance debt — capital plan', PAGE.margin, y); y = doc.y + 8;
        doc.font(FONT_REG).fontSize(11).fillColor(COLORS.textMuted);
        doc.text(`Fund by year 1: ${range(dp.year1)}`, PAGE.margin, y); y = doc.y + 2;
        doc.text(`Cumulative by year 3: ${range(dp.year3)}`, PAGE.margin, y); y = doc.y + 2;
        doc.text(`Cumulative by year 5: ${range(dp.year5)}`, PAGE.margin, y); y = doc.y + 6;
        doc.font(FONT_OBL).fontSize(9).fillColor(COLORS.textMuted)
           .text(`Deferred maintenance ${range(dp.totals.deferredMaintenance)} · repair backlog ${fmtMoney(dp.totals.repairBacklog.amount)} · modernization ${range(dp.totals.modernization)} across ${dp.siteCount} site(s).`, PAGE.margin, y, { width: PAGE.contentW, lineGap: 1 });
        y = doc.y + 16;
      }

      // Compliance trajectory
      if (y > BOTTOM - 40) { doc.addPage(); y = PAGE.margin; }
      doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13).text('Compliance trajectory', PAGE.margin, y); y = doc.y + 8;
      if (!data.trajectory || data.trajectory.length === 0) {
        doc.font(FONT_OBL).fontSize(10).fillColor(COLORS.textMuted).text('No compliance snapshots recorded yet. Generate snapshots to build a trend line.', PAGE.margin, y, { width: PAGE.contentW });
        y = doc.y + 8;
      } else {
        doc.font(FONT_REG).fontSize(10).fillColor(COLORS.textMuted);
        for (const t of data.trajectory) {
          if (y > BOTTOM - 20) { doc.addPage(); y = PAGE.margin; }
          doc.text(`${fmtDate(t.date)}  —  ${t.rate == null ? 'n/a' : t.rate + '%'} schedule compliance${t.overdue != null ? ` (${t.overdue} overdue)` : ''}`, PAGE.margin, y, { width: PAGE.contentW });
          y = doc.y + 2;
        }
        y = doc.y + 8;
      }

      // Disclaimer
      if (y > BOTTOM - 70) { doc.addPage(); y = PAGE.margin; }
      const disText = 'ESTIMATE — NOT A CERTIFICATION. Figures are estimates computed from the data configured in ServiceCycle on the generation date and may lag the current published standard editions. The spend forecast reflects only assets with recorded repair-cost estimates. Have a qualified professional review before relying on it for budget commitments.';
      doc.font(FONT_REG).fontSize(9);
      const disH = doc.heightOfString(disText, { width: PAGE.contentW - 24, lineGap: 2 }) + 28;
      doc.rect(PAGE.margin, y, PAGE.contentW, disH).fill('#fffbeb');
      doc.rect(PAGE.margin, y, 3, disH).fill(COLORS.warn);
      doc.rect(PAGE.margin, y, PAGE.contentW, disH).strokeColor('#fde68a').lineWidth(0.75).stroke();
      doc.fillColor('#92400e').font(FONT_BOLD).fontSize(9).text('SCOPE & LIMITATIONS', PAGE.margin + 12, y + 8, { width: PAGE.contentW - 24, lineBreak: false });
      doc.fillColor(COLORS.text).font(FONT_REG).fontSize(9).text(disText, PAGE.margin + 12, y + 22, { width: PAGE.contentW - 24, lineGap: 2 });

      drawFooter(doc, meta, 1);
      doc.end();
    } catch (err) { fail(err); }
  });
}

module.exports = { buildCfoReportData, renderCfoReportPdf };

export {};
