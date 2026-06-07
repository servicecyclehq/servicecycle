'use strict';

/**
 * lib/empDocument.js
 * ------------------
 * The generated written Electrical Maintenance Program (EMP) document —
 * NFPA 70B:2023 §4.2 requires every facility to HAVE a documented EMP; this
 * module assembles one from the live system data the platform already holds
 * so the document is a faithful description of the program as actually run,
 * not a binder template that drifts from reality.
 *
 *   buildEmpData(prisma, accountId)        → Promise<empData>
 *   renderEmpPdf(empData, meta)            → Promise<Buffer>
 *
 * Eleven numbered sections map the §4.2 program elements:
 *    1. Program Ownership & Responsibilities
 *    2. Equipment Survey & Analysis
 *    3. Condition of Maintenance Criteria
 *    4. Maintenance Procedures & Intervals
 *    5. Inspection & Test Plan
 *    6. Personnel Qualifications & Training
 *    7. Corrective Measures Process
 *    8. Incident Feedback & Investigations
 *    9. Records Retention & Program Review
 *   10. Design for Maintainability            (documented outside this platform)
 *   11. Electrical Safety Program Interface   (documented outside this platform)
 *
 * Sections 10 and 11 cover §4.2 elements the platform holds no data for —
 * they render with honest placeholder text the program owner must complete,
 * rather than pretending the generated document is the whole program.
 *
 * Inputs read from AccountSetting (managed via /api/compliance/emp-settings):
 *   EMP_COORDINATOR_USER_ID — program owner (same-account user id)
 *   RETENTION_POLICY_TEXT   — adopted records-retention policy text
 *   EMP_LAST_REVIEWED_AT    — ISO date of the last formal program review
 *
 * The PDF renderer reuses the hardened pdfkit patterns from
 * lib/compliancePdf (error handler bound before first write, settled flag,
 * recursion-guarded footer, per-row try/catch, measured-row page breaks).
 * Like that renderer it accumulates a Buffer — the caller needs the bytes
 * for SHA-256 + storage before anything is sent to the client.
 *
 * Every query is scoped by accountId — hard tenant boundary.
 */

const PDFDocument = require('pdfkit');

// ── constants ─────────────────────────────────────────────────────────────────

const DEFAULT_RETENTION_TEXT =
  'DEFAULT TEMPLATE — NOT YET CUSTOMIZED. Maintenance, inspection, and test ' +
  'records (work orders, test measurements, lab samples, deficiency records, ' +
  'and compliance snapshots) are retained in ServiceCycle for the service ' +
  'life of the associated equipment. Point-in-time compliance snapshots are ' +
  'immutable once generated and their SHA-256 hashes are anchored in the ' +
  'tamper-evident audit log. The program owner MUST replace this default ' +
  'text with the organization’s formally adopted retention policy ' +
  '(including any insurer-, contract-, or jurisdiction-specific retention ' +
  'periods) via the EMP settings before presenting this document to an ' +
  'auditor.';

const CONDITION_MODEL_TEXT =
  'Each asset carries a three-axis condition assessment per NFPA 70B:2023 — ' +
  'physical condition, operational criticality, and operating environment — ' +
  'each rated C1 (good), C2 (fair), or C3 (poor). The governing condition is ' +
  'the worst of the three axes and selects the maintenance interval applied ' +
  'to every task on that asset: C1 stretches the base interval (×2.5, ' +
  'ceiling 60 months), C2 applies the base published interval (NETA MTS ' +
  'Appendix B), and C3 compresses it (×0.25, ceiling 12 months). ' +
  'Condition ratings default to C2 until a qualified person assesses the ' +
  'asset, and the governing condition is recomputed on every condition ' +
  'write. As-found / as-left condition is recorded on each completed work ' +
  'order, feeding the next interval selection.';

const REVIEW_RULE_TEXT =
  'The complete program is formally reviewed by the program owner at ' +
  'intervals not exceeding 5 years, and additionally after any major system ' +
  'change, incident, or standards-edition revision affecting maintenance ' +
  'intervals.';

const OUTSIDE_PLATFORM_PREFIX =
  'DOCUMENTED OUTSIDE THIS PLATFORM — this program element is not ' +
  'tracked in ServiceCycle and the generated text below is a placeholder ' +
  'the program owner must complete. ';

// ── buildEmpData ──────────────────────────────────────────────────────────────

function isoDay(d) {
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return null; }
}

/**
 * Assemble the EMP document content from live system data.
 * @returns {Promise<object>} empData — consumed by renderEmpPdf
 */
async function buildEmpData(prisma, accountId) {
  const now = new Date();

  // ── account + EMP settings + coordinator ──
  const [account, settingRows] = await Promise.all([
    prisma.account.findUnique({
      where:  { id: accountId },
      select: { companyName: true, fteCount: true },
    }),
    prisma.accountSetting.findMany({
      where: {
        accountId,
        key: { in: ['EMP_COORDINATOR_USER_ID', 'RETENTION_POLICY_TEXT', 'EMP_LAST_REVIEWED_AT'] },
      },
    }),
  ]);
  const settings: any = {};
  for (const r of settingRows) settings[r.key] = r.value;

  let coordinator = null;
  if (settings.EMP_COORDINATOR_USER_ID) {
    coordinator = await prisma.user.findFirst({
      where:  { id: settings.EMP_COORDINATOR_USER_ID, accountId },
      select: { id: true, name: true, email: true, role: true },
    });
  }

  // ── equipment survey: live assets by type / site / condition ──
  const assets = await prisma.asset.findMany({
    where:  { accountId, archivedAt: null },
    select: {
      equipmentType:      true,
      governingCondition: true,
      inService:          true,
      site: { select: { id: true, name: true } },
    },
  });

  const byType = new Map();
  const bySite = new Map();
  const byCondition = { C1: 0, C2: 0, C3: 0 };
  for (const a of assets) {
    byType.set(a.equipmentType, (byType.get(a.equipmentType) || 0) + 1);
    const siteName = a.site ? a.site.name : 'Unknown site';
    bySite.set(siteName, (bySite.get(siteName) || 0) + 1);
    if (byCondition[a.governingCondition] !== undefined) byCondition[a.governingCondition] += 1;
  }
  const equipmentSurvey = {
    totalAssets: assets.length,
    inService:   assets.filter((a) => a.inService).length,
    byType:      [...byType.entries()].sort((x, y) => x[0].localeCompare(y[0]))
                   .map(([type, count]) => ({ type, count })),
    bySite:      [...bySite.entries()].sort((x, y) => x[0].localeCompare(y[0]))
                   .map(([site, count]) => ({ site, count })),
    byCondition,
  };

  // ── maintenance procedures: the task-definition matrix applicable to the
  //    account's equipment types (global seed rows + tenant custom rows) ──
  const equipmentTypes = [...byType.keys()];
  const taskDefinitions = equipmentTypes.length === 0 ? [] : await prisma.maintenanceTaskDefinition.findMany({
    where: {
      archivedAt:    null,
      equipmentType: { in: equipmentTypes },
      OR: [{ accountId: null }, { accountId }],
    },
    select: {
      equipmentType:    true,
      taskName:         true,
      taskCode:         true,
      intervalC1Months: true,
      intervalC2Months: true,
      intervalC3Months: true,
      requiresOutage:   true,
      requiresNetaCertified: true,
      standardRef:      true,
      accountId:        true, // null = global seed row, set = tenant custom
    },
    orderBy: [{ equipmentType: 'asc' }, { taskName: 'asc' }],
  });
  const procedures = taskDefinitions.map((t) => ({
    equipmentType: t.equipmentType,
    taskName:      t.taskName,
    intervalC1:    t.intervalC1Months,
    intervalC2:    t.intervalC2Months,
    intervalC3:    t.intervalC3Months,
    requiresOutage:        t.requiresOutage,
    requiresNetaCertified: t.requiresNetaCertified,
    standardRef:   t.standardRef,
    custom:        t.accountId !== null,
  }));

  // ── inspection/test plan: active schedules + next-due horizon ──
  const scheduleRows = await prisma.maintenanceSchedule.findMany({
    where:  { accountId, isActive: true, asset: { archivedAt: null } },
    select: { nextDueDate: true },
  });
  const horizonDays = (days) => {
    const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return scheduleRows.filter((s) => s.nextDueDate && s.nextDueDate >= now && s.nextDueDate <= cutoff).length;
  };
  let earliestNextDue = null;
  for (const s of scheduleRows) {
    if (s.nextDueDate && s.nextDueDate >= now && (!earliestNextDue || s.nextDueDate < earliestNextDue)) {
      earliestNextDue = s.nextDueDate;
    }
  }
  const inspectionPlan = {
    activeSchedules: scheduleRows.length,
    unbaselined:     scheduleRows.filter((s) => !s.nextDueDate).length,
    overdue:         scheduleRows.filter((s) => s.nextDueDate && s.nextDueDate < now).length,
    dueNext30:       horizonDays(30),
    dueNext90:       horizonDays(90),
    dueNext365:      horizonDays(365),
    earliestNextDue,
  };

  // ── personnel: contractors + techs with NETA levels / qualification dates ──
  const contractors = await prisma.contractor.findMany({
    where:  { accountId },
    select: {
      name:           true,
      isInternal:     true,
      netaAccredited: true,
      techs: {
        select: {
          name:                        true,
          title:                       true,
          netaCertLevel:               true,
          qualifiedPersonDesignatedAt: true,
          trainingExpiresAt:           true,
          thermographerCertLevel:      true,
        },
      },
    },
    orderBy: [{ isInternal: 'desc' }, { name: 'asc' }],
  });
  const personnel = {
    contractors: contractors.map((c) => ({
      name:           c.name,
      isInternal:     c.isInternal,
      netaAccredited: c.netaAccredited,
      techs:          c.techs,
    })),
    contractorCount: contractors.filter((c) => !c.isInternal).length,
    internalCrewCount: contractors.filter((c) => c.isInternal).length,
    techCount: contractors.reduce((n, c) => n + c.techs.length, 0),
  };

  // ── corrective measures: deficiency counts + workflow ──
  const [openBySeverity, resolvedCount] = await Promise.all([
    prisma.deficiency.groupBy({
      by:     ['severity'],
      where:  { accountId, resolvedAt: null },
      _count: { _all: true },
    }),
    prisma.deficiency.count({ where: { accountId, resolvedAt: { not: null } } }),
  ]);
  const openCounts = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  for (const g of openBySeverity) openCounts[g.severity] = g._count._all;
  const correctiveMeasures = {
    open:     openCounts,
    openTotal: openCounts.IMMEDIATE + openCounts.RECOMMENDED + openCounts.ADVISORY,
    resolved: resolvedCount,
  };

  // ── incident feedback: regulatory-breach flags + deficiency stats ──
  const regulatoryBreachFlags = await prisma.activityLog.count({
    where: { accountId, action: 'regulatory_breach_flagged' },
  });
  const incidentFeedback = {
    regulatoryBreachFlags,
    openDeficiencies:     correctiveMeasures.openTotal,
    resolvedDeficiencies: resolvedCount,
  };

  // ── records retention + program review ──
  const retention = {
    text:      settings.RETENTION_POLICY_TEXT || DEFAULT_RETENTION_TEXT,
    isDefault: !settings.RETENTION_POLICY_TEXT,
  };

  let lastReviewedAt = null;
  if (settings.EMP_LAST_REVIEWED_AT) {
    const d = new Date(settings.EMP_LAST_REVIEWED_AT);
    if (!Number.isNaN(d.getTime())) lastReviewedAt = d;
  }
  let nextReviewDue = null;
  if (lastReviewedAt) {
    nextReviewDue = new Date(lastReviewedAt);
    nextReviewDue.setUTCFullYear(nextReviewDue.getUTCFullYear() + 5);
  }
  const programReview = {
    lastReviewedAt,
    nextReviewDue,
    reviewOverdue: nextReviewDue ? nextReviewDue < now : null, // null = never reviewed
  };

  return {
    accountName: account ? account.companyName : 'Account',
    fteCount:    account ? account.fteCount : null,
    generatedAt: now,
    coordinator,            // { id, name, email, role } | null
    equipmentSurvey,
    procedures,
    inspectionPlan,
    personnel,
    correctiveMeasures,
    incidentFeedback,
    retention,
    programReview,
    conditionModelText: CONDITION_MODEL_TEXT,
    // Snapshot-row stats (same spirit as compliance snapshots).
    stats: {
      assets:           equipmentSurvey.totalAssets,
      schedules:        inspectionPlan.activeSchedules,
      overdue:          inspectionPlan.overdue,
      openDeficiencies: correctiveMeasures.openTotal,
      contractors:      personnel.contractorCount,
      internalCrews:    personnel.internalCrewCount,
      techs:            personnel.techCount,
      procedures:       procedures.length,
    },
  };
}

// ── PDF rendering ─────────────────────────────────────────────────────────────
// Palette / page geometry identical to lib/compliancePdf so the two
// documents read as one product family.

const COLORS = {
  bgDark:          '#0a0d12',
  textOnDark:      '#ffffff',
  textOnDarkMuted: '#9aa3b2',
  text:            '#0a0d12',
  textMuted:       '#5b6373',
  textSubtle:      '#9aa3b2',
  border:          '#dde2eb',
  accent:          '#0d4f6e',
  cardBg:          '#fafbfd',
  danger:          '#b91c1c',
  warnBg:          '#fef9ec',
  warn:            '#92600a',
};

const FONT_REG  = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_OBL  = 'Helvetica-Oblique';

const PAGE = {
  margin:   54,
  width:    612,
  height:   792,
  contentW: 612 - 54 * 2, // 504
};
const BOTTOM = PAGE.height - PAGE.margin;

const CELL_PAD = 3;
const TABLE_FS = 8;
const MAX_CELL = 220;

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return '—'; }
}

function clip(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_CELL ? t.slice(0, MAX_CELL - 1) + '…' : t;
}

// ── footer — every page, recursion-guarded (compliancePdf pattern) ────────────

function drawFooter(doc, meta, pageNum) {
  if (doc._renderingFooter) return;
  doc._renderingFooter = true;
  try {
    const y = doc.page.height - PAGE.margin + 10;
    doc.moveTo(PAGE.margin, y).lineTo(doc.page.width - PAGE.margin, y)
       .strokeColor(COLORS.border).lineWidth(0.5).stroke();
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8)
       .text(
         `Generated by ServiceCycle — ${meta.generatedAtIso} — document ${meta.snapshotId}`,
         PAGE.margin, y + 4,
         { align: 'left', lineBreak: false }
       );
    doc.fillColor(COLORS.textSubtle).font(FONT_REG).fontSize(8)
       .text(
         `Page ${pageNum}`,
         PAGE.margin, y + 4,
         { align: 'right', lineBreak: false }
       );
  } finally {
    doc._renderingFooter = false;
  }
}

// ── layout helpers ────────────────────────────────────────────────────────────
// A tiny cursor object (ctx.y) threads vertical position through the section
// writers; ensureSpace() page-breaks when the next block won't fit.

function ensureSpace(doc, ctx, need) {
  if (ctx.y + need > BOTTOM - 6) {
    doc.addPage();
    ctx.y = PAGE.margin;
  }
}

function sectionHeading(doc, ctx, number, title) {
  ensureSpace(doc, ctx, 50);
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(13)
     .text(`${number}. ${title}`, PAGE.margin, ctx.y, { width: PAGE.contentW });
  const lineY = doc.y + 4;
  doc.moveTo(PAGE.margin, lineY).lineTo(PAGE.margin + PAGE.contentW, lineY)
     .strokeColor(COLORS.accent).lineWidth(1).stroke();
  ctx.y = lineY + 10;
}

function subHeading(doc, ctx, title) {
  ensureSpace(doc, ctx, 28);
  doc.fillColor(COLORS.text).font(FONT_BOLD).fontSize(10)
     .text(title, PAGE.margin, ctx.y, { width: PAGE.contentW });
  ctx.y = doc.y + 4;
}

function paragraph(doc, ctx, text, opts: any = {}) {
  const fs    = opts.fontSize || 9.5;
  const font  = opts.oblique ? FONT_OBL : FONT_REG;
  const color = opts.color || COLORS.text;
  doc.font(font).fontSize(fs);
  const h = doc.heightOfString(text, { width: PAGE.contentW, lineGap: 2 });
  // Page-break unless the paragraph is taller than a page — then let pdfkit
  // auto-flow it (the pageAdded footer listener covers continuation pages).
  if (h < BOTTOM - PAGE.margin - 12) ensureSpace(doc, ctx, h + 4);
  doc.fillColor(color).font(font).fontSize(fs)
     .text(text, PAGE.margin, ctx.y, { width: PAGE.contentW, lineGap: 2 });
  ctx.y = doc.y + (opts.gap != null ? opts.gap : 8);
}

// Highlight box for "must complete / must customize" warnings.
function warnBox(doc, ctx, label, text) {
  doc.font(FONT_REG).fontSize(9);
  const innerW = PAGE.contentW - 24;
  const bodyH  = doc.heightOfString(text, { width: innerW, lineGap: 2 });
  const boxH   = bodyH + 36;
  ensureSpace(doc, ctx, boxH + 6);
  const y = ctx.y;
  doc.rect(PAGE.margin, y, PAGE.contentW, boxH).fill(COLORS.warnBg);
  doc.rect(PAGE.margin, y, 3, boxH).fill(COLORS.warn);
  doc.rect(PAGE.margin, y, PAGE.contentW, boxH)
     .strokeColor(COLORS.border).lineWidth(0.75).stroke();
  doc.fillColor(COLORS.warn).font(FONT_BOLD).fontSize(9)
     .text(label, PAGE.margin + 12, y + 10, { width: innerW, lineBreak: false });
  doc.fillColor(COLORS.text).font(FONT_REG).fontSize(9)
     .text(text, PAGE.margin + 12, y + 24, { width: innerW, lineGap: 2 });
  ctx.y = y + boxH + 10;
}

// Generic measured-row table with page-break + repeated header
// (compliancePdf drawAssetTaskTable pattern, generalized over `cols`).
function drawTableHeader(doc, cols, y) {
  doc.rect(PAGE.margin, y, PAGE.contentW, 16).fill(COLORS.bgDark);
  let x = PAGE.margin;
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(COLORS.textOnDark);
  for (const col of cols) {
    doc.text(col.label, x + CELL_PAD, y + 4, { width: col.w - CELL_PAD * 2, lineBreak: false });
    x += col.w;
  }
  doc.fillColor(COLORS.text);
  return y + 16;
}

function table(doc, ctx, cols, rows) {
  if (!rows || rows.length === 0) {
    paragraph(doc, ctx, 'None recorded.', { oblique: true, color: COLORS.textMuted, fontSize: 9 });
    return;
  }
  ensureSpace(doc, ctx, 16 + 18);
  let y = drawTableHeader(doc, cols, ctx.y);
  for (const row of rows) {
    // Per-row try/catch — one malformed row must not take the document down.
    try {
      doc.font(FONT_REG).fontSize(TABLE_FS);
      let h = 0;
      for (const col of cols) {
        const cellH = doc.heightOfString(String(row[col.key] ?? '—'), {
          width: col.w - CELL_PAD * 2,
          lineGap: 1,
        });
        if (cellH > h) h = cellH;
      }
      h = Math.max(h + CELL_PAD * 2, 14);
      if (y + h > BOTTOM - 6) {
        doc.addPage();
        y = drawTableHeader(doc, cols, PAGE.margin);
      }
      let x = PAGE.margin;
      for (const col of cols) {
        doc.font(col.bold ? FONT_BOLD : FONT_REG).fontSize(TABLE_FS).fillColor(COLORS.text)
           .text(String(row[col.key] ?? '—'), x + CELL_PAD, y + CELL_PAD, {
             width: col.w - CELL_PAD * 2,
             lineGap: 1,
           });
        x += col.w;
      }
      doc.moveTo(PAGE.margin, y + h).lineTo(PAGE.margin + PAGE.contentW, y + h)
         .strokeColor(COLORS.border).lineWidth(0.5).stroke();
      y += h;
    } catch (err) {
      try {
        console.error('[empDocument] table row render failed; skipping.',
          err && err.message ? err.message : err);
      } catch (_) { /* noop */ }
    }
  }
  ctx.y = y + 10;
}

// ── cover page ────────────────────────────────────────────────────────────────

function drawCoverPage(doc, empData, meta) {
  doc.rect(0, 0, doc.page.width, 96).fill(COLORS.bgDark);
  doc.fillColor(COLORS.textOnDark).font(FONT_BOLD).fontSize(22)
     .text('ServiceCycle', PAGE.margin, 30, { lineBreak: false });
  doc.fillColor(COLORS.textOnDarkMuted).font(FONT_REG).fontSize(12)
     .text('Electrical Maintenance Program — NFPA 70B §4.2', PAGE.margin, 60, { lineBreak: false });

  doc.fillColor(COLORS.text);
  let y = 140;

  doc.font(FONT_BOLD).fontSize(18).text(clip(meta.accountName || 'Account'), PAGE.margin, y, { width: PAGE.contentW });
  y = doc.y + 18;

  const kv = (label, value) => {
    doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.textMuted)
       .text(label, PAGE.margin, y, { width: 150, lineBreak: false });
    doc.font(FONT_REG).fontSize(10).fillColor(COLORS.text)
       .text(clip(value), PAGE.margin + 150, y, { width: PAGE.contentW - 150 });
    y = Math.max(doc.y, y + 14) + 6;
  };

  kv('Program owner',      empData.coordinator
                             ? `${empData.coordinator.name} (${empData.coordinator.email})`
                             : 'NOT ASSIGNED — set via EMP settings');
  kv('Generated at (UTC)', meta.generatedAtIso);
  kv('Generated by',       meta.generatedByName || 'Unknown user');
  kv('Document ID',        meta.snapshotId);
  kv('Last formal review', empData.programReview.lastReviewedAt
                             ? fmtDate(empData.programReview.lastReviewedAt)
                             : 'Never recorded');

  // Integrity note — same product promise, verbatim posture, as the
  // compliance snapshot cover.
  y += 18;
  const noteText =
    'The SHA-256 of this document is recorded in the ServiceCycle ' +
    'tamper-evident audit log at generation time. Recompute the hash of ' +
    `this file and compare against audit log entry ${meta.snapshotId} ` +
    'to verify it has not been altered. This document was assembled from ' +
    'live system data at the generation timestamp above; regenerate it to ' +
    'reflect the current program state.';
  const noteInnerW = PAGE.contentW - 24;
  doc.font(FONT_REG).fontSize(10);
  const noteH = doc.heightOfString(noteText, { width: noteInnerW, lineGap: 2 }) + 40;

  doc.rect(PAGE.margin, y, PAGE.contentW, noteH).fill(COLORS.cardBg);
  doc.rect(PAGE.margin, y, 3, noteH).fill(COLORS.accent);
  doc.rect(PAGE.margin, y, PAGE.contentW, noteH)
     .strokeColor(COLORS.border).lineWidth(0.75).stroke();

  doc.fillColor(COLORS.accent).font(FONT_BOLD).fontSize(10)
     .text('DOCUMENT INTEGRITY', PAGE.margin + 12, y + 12, { width: noteInnerW, lineBreak: false });
  doc.fillColor(COLORS.text).font(FONT_REG).fontSize(10)
     .text(noteText, PAGE.margin + 12, y + 28, { width: noteInnerW, lineGap: 2 });
}

// ── section writers ───────────────────────────────────────────────────────────

function writeSection1Ownership(doc, ctx, empData) {
  sectionHeading(doc, ctx, 1, 'Program Ownership & Responsibilities');
  if (empData.coordinator) {
    paragraph(doc, ctx,
      `The Electrical Maintenance Program for ${empData.accountName} is owned by ` +
      `${empData.coordinator.name} (${empData.coordinator.email}), who is responsible for ` +
      'implementing each element of this program: maintaining the equipment inventory, ' +
      'approving maintenance intervals and condition assessments, assigning corrective ' +
      'work, responding to audit recommendations, and conducting the periodic program ' +
      'review described in Section 9.');
  } else {
    warnBox(doc, ctx, 'PROGRAM OWNER NOT ASSIGNED',
      'No EMP coordinator is assigned for this account. NFPA 70B §4.2 requires the ' +
      'program to identify the personnel responsible for implementing each program ' +
      'element. Assign a program owner via Settings → EMP settings ' +
      '(EMP_COORDINATOR_USER_ID) and regenerate this document.');
  }
  paragraph(doc, ctx,
    'Day-to-day execution is shared between the qualified personnel listed in Section 6 ' +
    '(internal crews and NETA testing contractors) and the account’s managers, who ' +
    'schedule work orders, record test results, and disposition deficiencies inside ' +
    'ServiceCycle. All program records referenced by this document are produced and ' +
    'retained by the platform.');
}

function writeSection2Survey(doc, ctx, empData) {
  const s = empData.equipmentSurvey;
  sectionHeading(doc, ctx, 2, 'Equipment Survey & Analysis');
  paragraph(doc, ctx,
    `The program covers ${s.totalAssets} electrical asset${s.totalAssets === 1 ? '' : 's'} ` +
    `(${s.inService} in service) across ${s.bySite.length} site${s.bySite.length === 1 ? '' : 's'}. ` +
    'The inventory below reflects the live asset register at generation time; archived ' +
    'assets are excluded.');
  subHeading(doc, ctx, 'Assets by equipment type');
  table(doc, ctx,
    [{ key: 'type', label: 'Equipment type', w: 380 }, { key: 'count', label: 'Count', w: 124 }],
    s.byType.map((r) => ({ type: r.type, count: String(r.count) })));
  subHeading(doc, ctx, 'Assets by site');
  table(doc, ctx,
    [{ key: 'site', label: 'Site', w: 380 }, { key: 'count', label: 'Count', w: 124 }],
    s.bySite.map((r) => ({ site: clip(r.site), count: String(r.count) })));
  subHeading(doc, ctx, 'Assets by governing condition');
  table(doc, ctx,
    [{ key: 'cond', label: 'Governing condition', w: 380 }, { key: 'count', label: 'Count', w: 124 }],
    [
      { cond: 'C1 — good (extended intervals)',    count: String(s.byCondition.C1) },
      { cond: 'C2 — fair (base intervals)',        count: String(s.byCondition.C2) },
      { cond: 'C3 — poor (compressed intervals)',  count: String(s.byCondition.C3) },
    ]);
}

function writeSection3Condition(doc, ctx, empData) {
  sectionHeading(doc, ctx, 3, 'Condition of Maintenance Criteria');
  paragraph(doc, ctx, empData.conditionModelText);
}

function writeSection4Procedures(doc, ctx, empData) {
  sectionHeading(doc, ctx, 4, 'Maintenance Procedures & Intervals');
  paragraph(doc, ctx,
    'The following task matrix lists every maintenance procedure applicable to the ' +
    'equipment types in the Section 2 inventory, with the interval (in months) applied ' +
    'at each condition rating and the governing standard reference. Rows marked ' +
    '"custom" are account-defined tasks; all others derive from the seeded ' +
    'NFPA 70B / NETA MTS interval matrix.');
  table(doc, ctx,
    [
      { key: 'equipmentType', label: 'Equipment type',  w: 95  },
      { key: 'taskName',      label: 'Task',            w: 155 },
      { key: 'c1',            label: 'C1 (mo)',         w: 40  },
      { key: 'c2',            label: 'C2 (mo)',         w: 40  },
      { key: 'c3',            label: 'C3 (mo)',         w: 40  },
      { key: 'standardRef',   label: 'Standard ref',    w: 134 },
    ],
    empData.procedures.map((p) => ({
      equipmentType: p.equipmentType,
      taskName:      clip(p.taskName) +
                     (p.custom ? ' (custom)' : '') +
                     (p.requiresOutage ? ' [outage]' : '') +
                     (p.requiresNetaCertified ? ' [NETA]' : ''),
      c1:            p.intervalC1 != null ? String(p.intervalC1) : '—',
      c2:            p.intervalC2 != null ? String(p.intervalC2) : '—',
      c3:            p.intervalC3 != null ? String(p.intervalC3) : '—',
      standardRef:   clip(p.standardRef || '—'),
    })));
}

function writeSection5Inspection(doc, ctx, empData) {
  const p = empData.inspectionPlan;
  sectionHeading(doc, ctx, 5, 'Inspection & Test Plan');
  paragraph(doc, ctx,
    `${p.activeSchedules} active maintenance schedule${p.activeSchedules === 1 ? '' : 's'} ` +
    'pair the inventoried assets with the Section 4 procedures. Each schedule carries a ' +
    'stored next-due date recomputed on every completion or condition change, and drives ' +
    'the tiered alert ladder (180/120/90/60/30/7 days before due, with overdue and ' +
    'escalation notices after).');
  table(doc, ctx,
    [{ key: 'metric', label: 'Plan status at generation time', w: 380 }, { key: 'value', label: 'Count', w: 124 }],
    [
      { metric: 'Active schedules',                       value: String(p.activeSchedules) },
      { metric: 'Due within 30 days',                     value: String(p.dueNext30) },
      { metric: 'Due within 90 days',                     value: String(p.dueNext90) },
      { metric: 'Due within 365 days',                    value: String(p.dueNext365) },
      { metric: 'Overdue',                                value: String(p.overdue) },
      { metric: 'Not yet baselined (no first completion)', value: String(p.unbaselined) },
      { metric: 'Earliest upcoming due date',             value: fmtDate(p.earliestNextDue) },
    ]);
}

function writeSection6Personnel(doc, ctx, empData) {
  const p = empData.personnel;
  sectionHeading(doc, ctx, 6, 'Personnel Qualifications & Training');
  paragraph(doc, ctx,
    `Maintenance and testing are performed by ${p.internalCrewCount} internal ` +
    `crew${p.internalCrewCount === 1 ? '' : 's'} and ${p.contractorCount} external ` +
    `contractor${p.contractorCount === 1 ? '' : 's'} (${p.techCount} field ` +
    `technician${p.techCount === 1 ? '' : 's'} on record). ANSI/NETA ETT certification ` +
    'levels, employer qualified-person designations (NFPA 70E 110.2(A)(1)), and ' +
    'training expiry dates are tracked per technician.');
  const rows = [];
  for (const c of p.contractors) {
    const employer = `${clip(c.name)}${c.isInternal ? ' (internal)' : ''}${c.netaAccredited ? ' • NETA accredited' : ''}`;
    if (c.techs.length === 0) {
      rows.push({ tech: '— (no technicians on record)', employer, neta: '—', qual: '—', training: '—' });
    }
    for (const t of c.techs) {
      rows.push({
        tech:     clip(t.name) + (t.thermographerCertLevel ? ` (thermographer L${t.thermographerCertLevel})` : ''),
        employer,
        neta:     t.netaCertLevel ? t.netaCertLevel.replace('LEVEL_', 'Level ') : '—',
        qual:     fmtDate(t.qualifiedPersonDesignatedAt),
        training: fmtDate(t.trainingExpiresAt),
      });
    }
  }
  table(doc, ctx,
    [
      { key: 'tech',     label: 'Technician',          w: 150 },
      { key: 'employer', label: 'Employer',            w: 164 },
      { key: 'neta',     label: 'NETA level',          w: 60  },
      { key: 'qual',     label: 'Qualified designated', w: 65 },
      { key: 'training', label: 'Training expires',     w: 65 },
    ],
    rows);
}

function writeSection7Corrective(doc, ctx, empData) {
  const c = empData.correctiveMeasures;
  sectionHeading(doc, ctx, 7, 'Corrective Measures Process');
  paragraph(doc, ctx,
    'Findings from testing, inspection, and walkthroughs are recorded as deficiencies ' +
    'and classified per the NETA MTS scheme: IMMEDIATE (safety or operational risk now ' +
    '— correct before re-energizing), RECOMMENDED (correct at the next maintenance ' +
    'opportunity), and ADVISORY (monitor and trend). Each deficiency carries a ' +
    'description and corrective action; resolution is an explicit lifecycle action that ' +
    'records the resolver’s identity and timestamp and cannot be forged through a ' +
    'field edit. Open IMMEDIATE findings are surfaced on the dashboard until resolved.');
  table(doc, ctx,
    [{ key: 'metric', label: 'Deficiency status at generation time', w: 380 }, { key: 'value', label: 'Count', w: 124 }],
    [
      { metric: 'Open — IMMEDIATE',    value: String(c.open.IMMEDIATE) },
      { metric: 'Open — RECOMMENDED',  value: String(c.open.RECOMMENDED) },
      { metric: 'Open — ADVISORY',     value: String(c.open.ADVISORY) },
      { metric: 'Open — total',        value: String(c.openTotal) },
      { metric: 'Resolved (all time)',      value: String(c.resolved) },
    ]);
}

function writeSection8Incidents(doc, ctx, empData) {
  const i = empData.incidentFeedback;
  sectionHeading(doc, ctx, 8, 'Incident Feedback & Investigations');
  paragraph(doc, ctx,
    'Program feedback is driven by two live signals. First, schedules that fall 90 or ' +
    'more days overdue are flagged as regulatory-breach risks by the alert engine and ' +
    'recorded in the tamper-evident activity log ' +
    `(${i.regulatoryBreachFlags} flag${i.regulatoryBreachFlags === 1 ? '' : 's'} recorded to date). ` +
    'Second, deficiency outcomes feed back into condition assessments: as-found ' +
    `conditions and open findings (currently ${i.openDeficiencies} open, ` +
    `${i.resolvedDeficiencies} resolved) inform condition re-ratings, which in turn ` +
    'compress or extend maintenance intervals per Section 3.');
  paragraph(doc, ctx,
    'Formal incident investigations (equipment failure events, electrical incidents, ' +
    'near misses) that occur outside the platform should be summarized by the program ' +
    'owner and reflected here — attach investigation reports as documents against ' +
    'the affected assets so they are retained with the maintenance record.',
    { oblique: true, color: COLORS.textMuted, fontSize: 9 });
}

function writeSection9Records(doc, ctx, empData) {
  sectionHeading(doc, ctx, 9, 'Records Retention & Program Review');
  subHeading(doc, ctx, 'Records retention policy');
  if (empData.retention.isDefault) {
    warnBox(doc, ctx, 'DEFAULT RETENTION TEXT — MUST BE CUSTOMIZED', empData.retention.text);
  } else {
    paragraph(doc, ctx, empData.retention.text);
  }
  subHeading(doc, ctx, 'Program review');
  paragraph(doc, ctx, REVIEW_RULE_TEXT);
  const r = empData.programReview;
  if (!r.lastReviewedAt) {
    warnBox(doc, ctx, 'NO FORMAL REVIEW RECORDED',
      'No formal program review date is recorded for this account. Record the date of ' +
      'the last (or first) formal review via Settings → EMP settings ' +
      '(EMP_LAST_REVIEWED_AT). NFPA 70B expects the program to be reviewed at intervals ' +
      'not exceeding 5 years.');
  } else if (r.reviewOverdue) {
    warnBox(doc, ctx, 'PROGRAM REVIEW OVERDUE',
      `The last formal review was ${fmtDate(r.lastReviewedAt)}; the 5-year review window ` +
      `closed ${fmtDate(r.nextReviewDue)}. Schedule and record a program review.`);
  } else {
    paragraph(doc, ctx,
      `Last formal review: ${fmtDate(r.lastReviewedAt)}. Next review due no later than ` +
      `${fmtDate(r.nextReviewDue)}.`);
  }
}

function writeSection10Design(doc, ctx) {
  sectionHeading(doc, ctx, 10, 'Design for Maintainability');
  paragraph(doc, ctx,
    OUTSIDE_PLATFORM_PREFIX +
    'Design-for-maintainability practices — specifying equipment and installations ' +
    'so they can be maintained safely and effectively (working clearances, isolation ' +
    'points, draw-out construction, IR windows, labeling) — are governed by the ' +
    'organization’s engineering and procurement standards. The program owner should ' +
    'reference those standards here and ensure new installations are reviewed against ' +
    'them before energization.',
    { oblique: true, color: COLORS.textMuted });
}

function writeSection11Esp(doc, ctx) {
  sectionHeading(doc, ctx, 11, 'Electrical Safety Program Interface');
  paragraph(doc, ctx,
    OUTSIDE_PLATFORM_PREFIX +
    'The interface between this maintenance program and the organization’s ' +
    'electrical safety program (NFPA 70E) — energized-work permits, lockout/tagout ' +
    'procedures, arc-flash labeling, shock and arc-flash risk assessments, and the ' +
    'condition-of-maintenance input to risk assessment required by NFPA 70E 110.5(C) ' +
    '— is documented in the organization’s electrical safety program. The ' +
    'program owner should reference that document here. ServiceCycle contributes the ' +
    'condition-of-maintenance records (Section 3) and system studies that those risk ' +
    'assessments rely on.',
    { oblique: true, color: COLORS.textMuted });
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Render the EMP document PDF into a Buffer.
 *
 * @param {object} empData — output of buildEmpData()
 * @param {object} meta
 * @param {string} meta.snapshotId      — pre-generated ComplianceSnapshot id (footer + integrity note)
 * @param {string} meta.accountName
 * @param {string} meta.generatedByName
 * @param {string} meta.generatedAtIso  — UTC ISO timestamp string
 * @returns {Promise<Buffer>}
 */
function renderEmpPdf(empData, meta) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
      info: {
        Title:   `ServiceCycle Electrical Maintenance Program ${meta.snapshotId}`,
        Author:  'ServiceCycle',
        Subject: `Electrical Maintenance Program (NFPA 70B §4.2) — ${meta.accountName || 'Account'}`,
        Creator: 'ServiceCycle compliance engine',
      },
    });

    const chunks = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { doc.destroy(); } catch (_) { /* noop */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Hardening: error handler bound BEFORE any write — a pdfkit stream
    // error must reject the promise, not crash the process.
    doc.on('error', fail);
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    // Footer on every page; recursion-safe (lineBreak:false in drawFooter).
    let pageNum = 1;
    doc.on('pageAdded', () => {
      pageNum += 1;
      drawFooter(doc, meta, pageNum);
    });

    try {
      drawCoverPage(doc, empData, meta);
      drawFooter(doc, meta, 1); // pageAdded doesn't fire for page 1

      doc.addPage();
      const ctx = { y: PAGE.margin };

      writeSection1Ownership(doc, ctx, empData);
      writeSection2Survey(doc, ctx, empData);
      writeSection3Condition(doc, ctx, empData);
      writeSection4Procedures(doc, ctx, empData);
      writeSection5Inspection(doc, ctx, empData);
      writeSection6Personnel(doc, ctx, empData);
      writeSection7Corrective(doc, ctx, empData);
      writeSection8Incidents(doc, ctx, empData);
      writeSection9Records(doc, ctx, empData);
      writeSection10Design(doc, ctx);
      writeSection11Esp(doc, ctx);

      doc.end();
    } catch (err) {
      fail(err);
    }
  });
}

module.exports = { buildEmpData, renderEmpPdf };

export {};
