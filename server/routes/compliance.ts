'use strict';

/**
 * routes/compliance.js
 * --------------------
 * Per-standard compliance reporting + immutable audit snapshots.
 *
 * Mounted with auth at the app level:
 *   app.use('/api/compliance', authenticateToken, complianceRoutes);
 *
 * RBAC: reads are open to any authenticated role (viewer/consultant
 * included — compliance posture is exactly what a consultant is brought in
 * to look at). Snapshot GENERATION is requireManager: it writes evidence
 * into storage + the audit chain.
 *
 *   GET    /summary                    — per-standard summary counts
 *   GET    /report/:standardCode       — full evidence for one standard
 *   GET    /overdue-report             — cross-standard overdue punch list
 *   POST   /snapshots                  — generate + persist a snapshot PDF (manager+)
 *   GET    /snapshots                  — list snapshots (paginated, ?kind= filter)
 *   GET    /snapshots/:id/download     — stream a snapshot PDF (integrity-checked)
 *   POST   /emp-document               — generate the NFPA 70B §4.2 EMP document (manager+)
 *   GET    /emp-settings               — EMP program settings (admin)
 *   PUT    /emp-settings               — update EMP program settings (admin)
 *
 * Snapshot generation (both kinds) runs through lib/snapshotPipeline —
 * render → sha256 → store → row create → DIRECT activity-log anchor with
 * cleanup-on-failure. The pipeline lives in one place on purpose; do not
 * re-inline it here.
 *
 * NO DELETE ENDPOINT — intentional, not an omission. Snapshots are
 * point-in-time audit evidence whose SHA-256 is anchored in the
 * tamper-evident activity-log hash chain at generation time. Allowing
 * deletion would let a tenant quietly retract evidence they have already
 * presented to an auditor or insurance carrier, which defeats the entire
 * product promise ("show me your compliance posture from March" must have
 * one immutable answer). If retention/erasure pressure ever forces a
 * delete path, it must write its own chain-anchored tombstone entry —
 * that's a v2 design discussion, not a route to sneak in here.
 */

const express = require('express');
const crypto  = require('crypto');
const prisma  = require('../lib/prisma').default;
const { requireManager, requireAdmin } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { downloadFile } = require('../lib/storage');
const { buildStandardsSummary, buildStandardReport, buildOverdueReport, buildComplianceGap } = require('../lib/complianceReport');
const { buildMaturityScore } = require('../lib/maturityScore');
const { buildMaintenanceDebtData, debtLedgerToCsv } = require('../lib/maintenanceDebt');
const { buildChangeBrief } = require('../lib/changeBrief');
const { buildAssetEvidenceTrace, buildEvidenceGapSummary } = require('../lib/evidenceTrace');
const { buildDriftDetector } = require('../lib/driftDetector');
const { buildAuditFindings } = require('../lib/auditFindings');
const { buildForgottenAssets } = require('../lib/forgottenAssets');
const { buildUnderwritingPackage } = require('../lib/underwritingPackage');
const { generateSnapshot, persistSnapshot, utcStamp } = require('../lib/snapshotPipeline');
const { buildEmpData, renderEmpPdf } = require('../lib/empDocument');
const { getAccountBranding } = require('../lib/partnerBranding');
const { buildCustomerDigest } = require('../lib/customerDigest');
const { buildCfoReportData, renderCfoReportPdf } = require('../lib/cfoReport');
const { renderReportDocPdf } = require('../lib/reportsPdf');
const { formatTimestamp } = require('../lib/pdfStyle');

// #29 §7.4: ΔT reference frame as printed in the IR section. Mirrors the
// ThermographyReference enum; a bare ΔT is meaningless without its frame.
const IR_REF_LABEL: Record<string, string> = {
  AMBIENT: 'Over ambient', SIMILAR: 'Similar component', BASELINE: 'Vs. baseline',
};

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

const SNAPSHOT_KINDS = ['compliance', 'emp'];

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Map the lib's coded errors to 404s; everything else re-throws.
function handleBuilderError(res, err) {
  if (err && err.code === 'SITE_NOT_FOUND') {
    res.status(404).json({ success: false, error: 'Site not found.' });
    return true;
  }
  if (err && err.code === 'STANDARD_NOT_FOUND') {
    res.status(404).json({ success: false, error: 'Standard not found.' });
    return true;
  }
  return false;
}

// ── Field-report PDF renderers for the report endpoints below ─────────────────
// Block 1 #5: every report page carries the same Print + Download PDF pair.
// These back the Download PDF button (mirrors /standards.pdf). Live,
// non-anchored views -- for immutable evidence use the snapshot pipeline.
async function _acctSiteScope(accountId, siteId) {
  let org = '';
  try {
    const acct = await prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } });
    org = (acct && acct.companyName) || '';
  } catch (_) { /* org line is optional */ }
  let siteScope = 'All sites';
  if (siteId) {
    try {
      const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { name: true } });
      siteScope = site ? site.name : 'Selected site';
    } catch (_) { siteScope = 'Selected site'; }
  }
  return { org, siteScope };
}
const _pdfDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toISOString().slice(0, 10);
};
const _pdfAsset = (a) => {
  if (!a) return '—';
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset';
  return a.serialNumber ? `${base} (SN ${a.serialNumber})` : base;
};

async function renderOverduePdf(res, accountId, siteId, report) {
  const { org, siteScope } = await _acctSiteScope(accountId, siteId);
  const overdue = Array.isArray(report.overdueSchedules) ? report.overdueSchedules : [];
  const defGroups = Array.isArray(report.openDeficiencies) ? report.openDeficiencies : [];
  const totalDefs = defGroups.reduce((n, g) => n + ((g.items && g.items.length) || 0), 0);
  const immediate = (defGroups.find((g) => g.severity === 'IMMEDIATE') || {}).items;
  const genAt = report.generatedAt ? new Date(report.generatedAt) : new Date();
  const sections = [
    {
      title: 'Overdue posture',
      aux: siteScope,
      body: [
        'The cross-standard overdue punch list: every active maintenance schedule whose next-due date has passed (most overdue first), plus open deficiencies grouped by severity.',
        'A live, on-demand view. For immutable, SHA-256-anchored evidence suitable for an auditor or insurer, generate an Audit Evidence Snapshot from the Reports hub.',
      ],
      stats: [
        { label: 'Overdue tasks', value: overdue.length },
        { label: 'Open deficiencies', value: totalDefs },
        { label: 'Immediate', value: (immediate && immediate.length) || 0 },
      ],
    },
    {
      title: 'Overdue maintenance tasks',
      aux: `${overdue.length} overdue`,
      table: {
        columns: [
          { key: 'asset', label: 'Asset', w: 1.8, bold: true },
          { key: 'site', label: 'Site', w: 1.1 },
          { key: 'task', label: 'Task', w: 1.6 },
          { key: 'due', label: 'Due', w: 0.9, mono: true },
          { key: 'days', label: 'Days overdue', w: 0.8, numeric: true },
        ],
        rows: overdue.map((r) => ({
          asset: _pdfAsset(r.asset),
          site: (r.asset && r.asset.site && r.asset.site.name) || '—',
          task: (r.task && r.task.taskName) || '—',
          due: _pdfDate(r.nextDueDate),
          days: r.daysOverdue == null ? '—' : r.daysOverdue,
        })),
        emptyText: 'No overdue maintenance tasks in scope.',
      },
    },
    {
      title: 'Open deficiencies by severity',
      aux: `${totalDefs} open`,
      table: {
        columns: [
          { key: 'severity', label: 'Severity', w: 0.9, bold: true },
          { key: 'description', label: 'Description', w: 2.4 },
          { key: 'asset', label: 'Asset', w: 1.6 },
          { key: 'age', label: 'Age (days)', w: 0.8, numeric: true },
        ],
        rows: defGroups.flatMap((g) => (g.items || []).map((it) => ({
          severity: g.severity,
          description: it.description || '—',
          asset: _pdfAsset(it.asset),
          age: it.ageDays == null ? '—' : it.ageDays,
        }))),
        emptyText: 'No open deficiencies in scope.',
      },
    },
  ];
  return renderReportDocPdf(res, {
    title: 'Overdue Maintenance by Severity',
    org: org || undefined,
    metaLines: [siteScope, formatTimestamp(genAt)],
    generatedAt: genAt,
    filename: `Overdue_by_Severity_${genAt.toISOString().slice(0, 10)}`,
    sections,
  });
}

async function renderStandardReportPdf(res, accountId, siteId, report) {
  const { org } = await _acctSiteScope(accountId, siteId);
  const std = report.standard || {};
  const summary = report.summary || {};
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const defs = Array.isArray(report.openDeficiencies) ? report.openDeficiencies : [];
  const siteScope = (report.scope && report.scope.siteName) || 'All sites';
  const genAt = report.generatedAt ? new Date(report.generatedAt) : new Date();
  const code = std.code || 'Standard';
  const sections = [
    {
      title: `${code} compliance posture`,
      aux: siteScope,
      body: [
        std.title ? `${std.title}${std.keyMandate ? ' — ' + std.keyMandate : ''}` : (std.keyMandate || 'Per-standard maintenance compliance evidence.'),
        'A live, on-demand evidence view. For immutable, SHA-256-anchored evidence use the Audit Evidence Snapshot for this standard.',
      ],
      stats: [
        { label: 'Assets', value: summary.assetCount ?? 0 },
        { label: 'Schedules', value: summary.scheduleCount ?? 0 },
        { label: 'Current', value: summary.currentCount ?? 0 },
        { label: 'Overdue', value: summary.overdueCount ?? 0 },
        { label: 'Unbaselined', value: summary.unbaselinedCount ?? 0 },
        { label: 'Compliance', value: summary.complianceRate == null ? '—' : `${summary.complianceRate}%` },
      ],
    },
    {
      title: 'Evidence',
      aux: `${rows.length} schedule${rows.length === 1 ? '' : 's'}`,
      table: {
        columns: [
          { key: 'asset', label: 'Asset', w: 1.7, bold: true },
          { key: 'site', label: 'Site', w: 1.0 },
          { key: 'task', label: 'Task', w: 1.6 },
          { key: 'last', label: 'Last completed', w: 1.0, mono: true },
          { key: 'due', label: 'Next due', w: 1.0, mono: true },
          { key: 'status', label: 'Status', w: 0.9 },
        ],
        rows: rows.map((r) => ({
          asset: _pdfAsset(r.asset),
          site: (r.asset && r.asset.siteName) || '—',
          task: (r.task && r.task.taskName) || '—',
          last: _pdfDate(r.schedule && r.schedule.lastCompletedDate),
          due: _pdfDate(r.schedule && r.schedule.nextDueDate),
          status: (r.schedule && r.schedule.status) || '—',
        })),
        emptyText: 'No schedules under this standard.',
      },
    },
    {
      title: 'Open deficiencies',
      aux: `${defs.length} open`,
      table: {
        columns: [
          { key: 'severity', label: 'Severity', w: 0.9, bold: true },
          { key: 'description', label: 'Description', w: 2.6 },
          { key: 'asset', label: 'Asset', w: 1.6 },
          { key: 'logged', label: 'Logged', w: 1.0, mono: true },
        ],
        rows: defs.map((d) => ({
          severity: d.severity,
          description: d.description || '—',
          asset: _pdfAsset(d.asset),
          logged: _pdfDate(d.createdAt),
        })),
        emptyText: 'No open deficiencies on assets governed by this standard.',
      },
    },
  ];

  // #29 §7.4: IR thermography drill-down. Present only for NFPA 70B (the
  // builder returns null for every other standard), so the PDF gains a section
  // exactly where IR is actually mandated.
  const ir = report.irThermography;
  if (ir) {
    sections.push({
      title: 'IR thermography (NFPA 70B §7.4)',
      aux: `${ir.summary.scanned} scanned · ${ir.summary.neverScanned} never scanned · ${ir.summary.openFindings} open finding(s)`,
      table: {
        columns: [
          { key: 'component', label: 'Component', w: 2.2 },
          { key: 'deltaT', label: 'ΔT', w: 0.7, mono: true },
          { key: 'reference', label: 'Reference', w: 1.0 },
          { key: 'severity', label: 'NETA severity', w: 1.3, bold: true },
          { key: 'action', label: 'Corrective action', w: 2.0 },
        ],
        rows: ir.findings.map((f) => ({
          component: f.component || '—',
          deltaT: f.deltaT == null ? '—' : `${f.deltaT}°C`,
          reference: IR_REF_LABEL[f.referenceType] || f.referenceType || '—',
          severity: f.severity || 'Below threshold',
          action: f.correctiveAction || '—',
        })),
        emptyText: 'No open IR findings on assets governed by this standard.',
      },
    });
  }

  return renderReportDocPdf(res, {
    title: `${code} Compliance Report`,
    org: org || undefined,
    metaLines: [std.edition ? String(std.edition) : null, siteScope, formatTimestamp(genAt)].filter(Boolean),
    generatedAt: genAt,
    filename: `${code.replace(/[^\w-]+/g, '_')}_Compliance_${genAt.toISOString().slice(0, 10)}`,
    sections,
  });
}

// ── GET /summary?siteId= ──────────────────────────────────────────────────────
// Per-standard compliance summary for the account (optionally one site).

router.get('/summary', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    let asOf: any = null;
    if (req.query.asOf != null && req.query.asOf !== '') {
      const d = new Date(String(req.query.asOf));
      if (Number.isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Invalid asOf date; use ISO 8601 (e.g. 2026-03-01).' });
      const nowD = new Date();
      asOf = d > nowD ? nowD : d;
    }
    const standards = await buildStandardsSummary(prisma, req.user.accountId, { siteId, asOf });
    return res.json({ success: true, data: { standards, asOf: asOf ? asOf.toISOString() : null } });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/summary]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build compliance summary.' });
  }
});

// ── GET /standards.pdf?siteId= ────────────────────────────────────────────────
// On-demand "Compliance by Standard" summary as a Field Report PDF (masthead,
// posture narrative, per-standard summary table, page-N-of-M footer) via
// lib/reportsPdf.renderReportDocPdf. This is the Download PDF button on
// /reports/compliance -- a live, non-anchored view, NOT audit evidence: for
// immutable, SHA-256-anchored PDFs use POST /snapshots. Any authenticated role,
// same read tier as /summary.

router.get('/standards.pdf', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const standards = await buildStandardsSummary(prisma, accountId, { siteId });

    let companyName = '';
    try {
      const acct = await prisma.account.findUnique({ where: { id: accountId }, select: { companyName: true } });
      companyName = (acct && acct.companyName) || '';
    } catch (_) { /* org line is optional */ }
    let siteScope = 'All sites';
    if (siteId) {
      try {
        const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { name: true } });
        siteScope = site ? site.name : 'Selected site';
      } catch (_) { siteScope = 'Selected site'; }
    }

    const totals = standards.reduce((t: any, r: any) => ({
      assets:    t.assets + (r.assetCount || 0),
      schedules: t.schedules + (r.scheduleCount || 0),
      overdue:   t.overdue + (r.overdueCount || 0),
    }), { assets: 0, schedules: 0, overdue: 0 });

    const fmtDue = (d: any) => {
      if (!d) return '—';
      const dt = new Date(d);
      return isNaN(dt.getTime()) ? '—' : dt.toISOString().slice(0, 10);
    };

    const sections = [
      {
        title: 'Compliance posture',
        aux: `${standards.length} standard${standards.length === 1 ? '' : 's'}`,
        body: [
          `This report rolls maintenance compliance up by governing standard. Each row is one standard with the assets and schedules it governs, the share of schedules currently in compliance, and the count of overdue items. On screen the compliance rate is color-graded (green >= 90%, amber >= 70%, red below).`,
          `This is a live, on-demand view. For immutable evidence suitable for an auditor or insurer, generate an Audit Evidence Snapshot from the Reports hub — those PDFs are SHA-256-anchored and re-verified on every download; this summary is not.`,
        ],
        stats: [
          { label: 'Standards', value: standards.length },
          { label: 'Assets',    value: totals.assets },
          { label: 'Schedules', value: totals.schedules },
          { label: 'Overdue',   value: totals.overdue },
        ],
      },
      {
        title: 'Compliance summary by standard',
        aux: siteScope,
        table: {
          columns: [
            { key: 'code',       label: 'Standard',   w: 1.15, bold: true },
            { key: 'title',      label: 'Title',      w: 2.5 },
            { key: 'assets',     label: 'Assets',     w: 0.7, numeric: true },
            { key: 'schedules',  label: 'Schedules',  w: 0.85, numeric: true },
            { key: 'compliance', label: 'Compliance', w: 0.9, numeric: true },
            { key: 'overdue',    label: 'Overdue',    w: 0.7, numeric: true },
            { key: 'nextDue',    label: 'Next Due',   w: 1.0, mono: true },
          ],
          rows: standards.map((r: any) => {
            const std = r.standard || {};
            const code = std.code || 'Account-defined';
            return {
              code:       std.edition ? `${code} (${std.edition})` : code,
              title:      std.title || '—',
              assets:     r.assetCount || 0,
              schedules:  r.scheduleCount || 0,
              compliance: r.complianceRate == null ? '—' : `${r.complianceRate}%`,
              overdue:    r.overdueCount || 0,
              nextDue:    fmtDue(r.nextDue),
            };
          }),
          emptyText: 'No compliance data yet — add assets and apply maintenance schedules.',
        },
      },
    ];

    const genAt = new Date();
    return renderReportDocPdf(res, {
      title: 'Compliance by Standard',
      org: companyName || undefined,
      metaLines: [siteScope, formatTimestamp(genAt)],
      generatedAt: genAt,
      filename: `Compliance_by_Standard_${genAt.toISOString().slice(0, 10)}`,
      sections,
    });
  } catch (err: any) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/standards.pdf]', err && err.message);
    return res.status(500).json({ success: false, error: 'Failed to build compliance PDF.' });
  }
});

// ── GET /report/:standardCode?siteId= ─────────────────────────────────────────
// Full evidence report for one standard. :standardCode is URL-encoded
// (e.g. 'NFPA%2070B'); Express decodes it in req.params. The synthetic
// bucket is addressable as 'account-defined' (case-insensitive).

router.get('/report/:standardCode', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const report = await buildStandardReport(prisma, req.user.accountId, {
      standardCode: req.params.standardCode,
      siteId,
    });
    if (String(req.query.format || '').toLowerCase() === 'pdf') {
      return await renderStandardReportPdf(res, req.user.accountId, siteId, report);
    }
    return res.json({ success: true, data: { report } });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/report]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build compliance report.' });
  }
});

// ── GET /overdue-report?siteId= ───────────────────────────────────────────────
// Cross-standard overdue posture: every overdue active schedule (most-overdue
// first, with daysOverdue) plus open deficiencies grouped by severity. Any
// authenticated role — same read tier as /summary and /report (a consultant
// is brought in precisely to look at this).

router.get('/overdue-report', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const report = await buildOverdueReport(prisma, req.user.accountId, { siteId });
    if (String(req.query.format || '').toLowerCase() === 'pdf') {
      return await renderOverduePdf(res, req.user.accountId, siteId, report);
    }
    return res.json({ success: true, data: { report } });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/overdue-report]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build overdue report.' });
  }
});

// == GET /readings/:mid/history -- forensic edit/delete trail for one reading ==
// Pure read of the tamper-evident activity-log chain: every measurement_updated
// and measurement_deleted event committed for this reading, oldest-first, with
// the chain-committed before/after (or deleted) values and the actor. Echoes the
// account chain-head rowHash + rows-consumed so an auditor can independently
// verify the trail. Read-only. (Schedule-level as-of compliance is a separate
// path that needs historical nextDueDate == ScheduleStateHistory / P2.)
router.get('/readings/:mid/history', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const mid = String(req.params.mid);

    const measurement = await prisma.testMeasurement.findFirst({
      where: { id: mid, accountId },
      select: { id: true, workOrderId: true, deletedAt: true },
    });
    if (!measurement) {
      return res.status(404).json({ success: false, error: 'Reading not found.' });
    }

    const events = await prisma.activityLog.findMany({
      where: {
        accountId,
        action: { in: ['measurement_updated', 'measurement_deleted'] },
        details: { path: ['measurementId'], equals: mid },
      },
      orderBy: { createdAt: 'asc' },
      select: { action: true, details: true, userId: true, createdAt: true, rowHash: true, prevHash: true },
    });

    // Account chain head: latest SETTLED rowHash (the ~30s settler backfills it).
    // Auditor anchor -- recompute the chain and compare to this value.
    const head = await prisma.activityLog.findFirst({
      where: { accountId, rowHash: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { rowHash: true, createdAt: true },
    });

    return res.json({
      success: true,
      data: {
        measurementId: mid,
        workOrderId: measurement.workOrderId,
        currentlyDeleted: measurement.deletedAt != null,
        history: events.map((e) => {
          const d = (e.details || {});
          return {
            action: e.action,
            at: e.createdAt,
            userId: e.userId,
            before: d.before != null ? d.before : null,
            after: d.after != null ? d.after : null,
            deletedValues: d.deleted != null ? d.deleted : null,
            rowHash: e.rowHash,
            prevHash: e.prevHash,
            settled: e.rowHash != null,
          };
        }),
        rowsConsumed: events.length,
        chainHead: head ? head.rowHash : null,
        chainHeadAt: head ? head.createdAt : null,
      },
    });
  } catch (err) {
    console.error('[compliance/readings/:mid/history]', err && (err).message);
    return res.status(500).json({ success: false, error: 'Failed to build reading history.' });
  }
});

// ── GET /path-to-100?siteId= ──────────────────────────────────────────────────
// Gem N2 — the honest compliance picture + the ranked to-do list that closes
// it. Returns schedule complianceRate AND asset coverageRate (the flatter the
// headline hides), a blended overallRate, and the exact point-weighted actions
// (complete overdue / baseline / apply template) that walk the account to 100%.
// Any authenticated role — this is a read.

router.get('/path-to-100', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const gap = await buildComplianceGap(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data: gap });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/path-to-100]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build path-to-100.' });
  }
});

// ── GET /maturity?siteId= ─────────────────────────────────────────────────────
// B1 — NFPA 70B program-maturity score (customer-facing). Reframes the same
// obligation model behind /path-to-100 into a single 0-100 score vs what 70B
// REQUIRES (not vs other facilities), a 1-5 maturity level, and a per-dimension
// breakdown (coverage / on-time / baselining / written EMP §4.2). Any
// authenticated role — same read tier as /path-to-100.
router.get('/maturity', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const maturity = await buildMaturityScore(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data: maturity });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/maturity]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build maturity score.' });
  }
});

// ── GET /maintenance-debt ─────────────────────────────────────────────────────
// Maintenance Debt Ledger + capital plan: overdue/deferred maintenance, known
// repair backlog, and RUL-driven modernization quantified as accruing "$ debt"
// and rolled into a cumulative 1/3/5-year funding plan grouped by site. CFO-grade
// budget artifact (same family as /cfo-report.pdf). Any authenticated role.
router.get('/maintenance-debt', requireManager, async (req, res) => {
  try {
    const data = await buildMaintenanceDebtData(prisma, req.user.accountId);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[compliance/maintenance-debt]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build maintenance debt ledger.' });
  }
});

// ── GET /maintenance-debt.csv ─────────────────────────────────────────────────
// Exportable per-site funding plan. Any authenticated role.
router.get('/maintenance-debt.csv', requireManager, async (req, res) => {
  try {
    const data = await buildMaintenanceDebtData(prisma, req.user.accountId);
    const csv = debtLedgerToCsv(data);
    const filename = `servicecycle-maintenance-debt-${data.generatedAt.toISOString().slice(0, 10)}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    return res.send(csv);
  } catch (err) {
    console.error('[compliance/maintenance-debt.csv]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to export maintenance debt ledger.' });
  }
});

// ── GET /change-brief?siteId= ─────────────────────────────────────────────────
// "What changed since last cycle" — a per-site structured diff + short narrative
// of everything that moved since the previous compliance snapshot (assets
// added/removed, maintenance completed, newly overdue, deficiencies
// opened/resolved, condition + policy changes). Pairs with snapshots + the
// customer digest. Any authenticated role.
router.get('/change-brief', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const brief = await buildChangeBrief(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data: brief });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/change-brief]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build change brief.' });
  }
});

// ── GET /evidence-gaps?siteId= ────────────────────────────────────────────────
// #2 — account/site evidence-gap roll-up: how much of the 70B program is backed
// by documented test evidence, which test types are most under-evidenced, and
// which assets have the biggest gaps (the contractor's upsell list). Any auth role.
router.get('/evidence-gaps', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const data = await buildEvidenceGapSummary(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/evidence-gaps]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build evidence gaps.' });
  }
});

// ── GET /asset-evidence/:assetId ──────────────────────────────────────────────
// #2 — per-asset requirement → evidence trace map (which evidence satisfies
// which 70B requirement, and what's missing). Any authenticated role.
router.get('/asset-evidence/:assetId', async (req, res) => {
  try {
    const data = await buildAssetEvidenceTrace(prisma, req.user.accountId, String(req.params.assetId));
    return res.json({ success: true, data });
  } catch (err) {
    if (err && err.code === 'ASSET_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Asset not found.' });
    }
    console.error('[compliance/asset-evidence]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build evidence trace.' });
  }
});

// ── GET /drift?siteId= ────────────────────────────────────────────────────────
// #4 — repeat-failure / compliance-drift detector. Flags assets drifting out of
// tolerance across cycles, inspected-but-not-corrected, or repeatedly failing,
// and recommends a program change (shorten interval / close corrective / review
// procedure) instead of just another ticket. Any authenticated role.
router.get('/drift', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const data = await buildDriftDetector(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/drift]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build drift report.' });
  }
});

// ── GET /audit-findings?siteId= ───────────────────────────────────────────────
// Phase 1 #1 -- the "what will fail an audit" view. Aggregates Path-to-100 gaps,
// undocumented-work evidence gaps, and drift/uncorrected findings into ONE ranked
// list of likely NFPA 70B audit findings, with a headline readiness score. Pure
// re-presentation of signals already computed elsewhere. Any authenticated role.
router.get('/audit-findings', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    // 2026-07-13: ?fullKind=<kind> requests the unsliced examples list for one
    // category (the drill-down page) instead of the dashboard card's 5-item cap.
    const fullKind = req.query.fullKind ? String(req.query.fullKind) : null;
    const data = await buildAuditFindings(prisma, req.user.accountId, { siteId, fullKind });
    return res.json({ success: true, data });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/audit-findings]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build audit findings.' });
  }
});

// ── GET /forgotten-assets?siteId=&years= ──────────────────────────────────────
// Phase 1 #2 -- the "forgotten / untracked assets" lens. Two buckets: assets on
// NO maintenance program (untracked; same set as Path-to-100 uncovered) and
// assets on a program but not serviced in > N years / never serviced (forgotten).
// `years` defaults to 3 (clamped 1-20). Any authenticated role -- this is a read.
router.get('/forgotten-assets', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const years = req.query.years !== undefined ? Number(req.query.years) : undefined;
    const data = await buildForgottenAssets(prisma, req.user.accountId, { siteId, years });
    return res.json({ success: true, data });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/forgotten-assets]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build forgotten-assets view.' });
  }
});

// ── GET /underwriting-package ─────────────────────────────────────────────────
// Phase 1 #3 -- the one-click insurer underwriting packet: NFPA 70B compliance +
// maturity readiness, ranked risk posture (#1) + off-radar equipment (#2), the
// Maintenance Debt Ledger capital-plan $ ranges, and tamper-evident snapshot
// integrity. Same data behind the break-glass insurer share link. Any auth role.
router.get('/underwriting-package', requireManager, async (req, res) => {
  try {
    const data = await buildUnderwritingPackage(prisma, req.user.accountId);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[compliance/underwriting-package]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build underwriting package.' });
  }
});

// ── GET /customer-digest ──────────────────────────────────────────────────────
// #30 — the customer-side weekly heartbeat payload (preview of what the weekly
// digest email contains): compliance trend, this-week deltas, next outage, top
// items. Any authenticated role — this is a read.
router.get('/customer-digest', async (req, res) => {
  try {
    const digest = await buildCustomerDigest(prisma, req.user.accountId);
    return res.json({ success: true, data: digest });
  } catch (err) {
    console.error('[compliance/customer-digest]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build customer digest.' });
  }
});

// ── GET /cfo-report.pdf ───────────────────────────────────────────────────────
// #30 — the quarterly board-grade budget/compliance PDF, generated on demand.
// Co-branded (#15). Not persisted/anchored (it is a derived summary, not audit
// evidence — that's what /snapshots is for). Any authenticated role.
router.get('/cfo-report.pdf', requireManager, async (req, res) => {
  try {
    const data = await buildCfoReportData(prisma, req.user.accountId);
    const branding = await getAccountBranding(req.user.accountId);
    const pdf = await renderCfoReportPdf(data, {
      generatedAtIso: data.generatedAt.toISOString(),
      brandName:  branding?.name || null,
      brandColor: branding?.primaryColor || null,
    });
    const filename = `servicecycle-cfo-report-${data.generatedAt.toISOString().slice(0, 10)}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length', String(pdf.length));
    res.set('Cache-Control', 'private, no-store');
    return res.send(pdf);
  } catch (err) {
    console.error('[compliance/cfo-report]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build CFO report.' });
  }
});

// ── POST /snapshots ───────────────────────────────────────────────────────────
// Generate a snapshot PDF, persist it, and anchor its SHA-256 in the audit
// log. Body: { standardCode? (null = all standards), siteId? (null = all sites) }.
//
// The full render → hash → store → row → anchor sequence (including the
// cleanup-on-failure ordering) lives in lib/snapshotPipeline.generateSnapshot
// and is shared with POST /api/audits/:id/snapshots.

router.post('/snapshots', requireManager, async (req, res) => {
  const { accountId, id: userId } = req.user;
  const body         = req.body || {};
  const standardCode = body.standardCode ? String(body.standardCode).trim() : null;
  const siteId       = body.siteId ? String(body.siteId) : null;

  try {
    const { snapshot, site } = await generateSnapshot(prisma, {
      accountId,
      userId,
      userName: req.user.name || null,
      standardCode,
      siteId,
      kind: 'compliance',
    });

    return res.status(201).json({
      success: true,
      data: {
        snapshot: {
          id:           snapshot.id,
          createdAt:    snapshot.createdAt,
          standardCode: snapshot.standardCode,
          siteId:       snapshot.siteId,
          siteName:     site ? site.name : null,
          kind:         snapshot.kind,
          filename:     snapshot.filename,
          sizeBytes:    snapshot.sizeBytes,
          sha256:       snapshot.sha256,
          stats:        snapshot.stats,
        },
      },
    });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    if (err && err.code === 'NO_DATA') {
      return res.status(422).json({ success: false, error: err.message });
    }
    if (err && err.code === 'ANCHOR_FAILED') {
      return res.status(500).json({ success: false, error: err.message });
    }
    console.error('[compliance/snapshots]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate compliance snapshot.' });
  }
});

// ── POST /emp-document ────────────────────────────────────────────────────────
// Generate the written Electrical Maintenance Program document (NFPA 70B
// §4.2) from live system data and persist it through the SAME pipeline as
// compliance snapshots: kind='emp', standardCode null, hash anchored in the
// activity log (action compliance_snapshot_generated, details.kind='emp').

router.post('/emp-document', requireManager, async (req, res) => {
  const { accountId, id: userId } = req.user;

  try {
    const empData = await buildEmpData(prisma, accountId);

    // Pre-generate the id so it can be baked into the PDF footer +
    // integrity note BEFORE the row exists (same as compliance snapshots).
    const snapshotId  = crypto.randomUUID();
    const generatedAt = new Date();

    const branding = await getAccountBranding(accountId); // #15 co-brand
    const pdfBuffer = await renderEmpPdf(empData, {
      snapshotId,
      accountName:     empData.accountName,
      generatedByName: req.user.name || 'Unknown user',
      generatedAtIso:  generatedAt.toISOString(),
      brandName:       branding?.name || null,
      brandColor:      branding?.primaryColor || null,
    });

    const filename = `servicecycle-emp-document-${utcStamp(generatedAt)}.pdf`;

    const { snapshot } = await persistSnapshot(prisma, {
      accountId,
      userId,
      snapshotId,
      pdfBuffer,
      filename,
      standardCode: null,
      siteId:       null,
      kind:         'emp',
      auditVisitId: null,
      stats:        empData.stats,
    });

    return res.status(201).json({
      success: true,
      data: {
        snapshot: {
          id:           snapshot.id,
          createdAt:    snapshot.createdAt,
          standardCode: snapshot.standardCode,
          siteId:       snapshot.siteId,
          siteName:     null,
          kind:         snapshot.kind,
          filename:     snapshot.filename,
          sizeBytes:    snapshot.sizeBytes,
          sha256:       snapshot.sha256,
          stats:        snapshot.stats,
        },
      },
    });
  } catch (err) {
    if (err && err.code === 'ANCHOR_FAILED') {
      return res.status(500).json({ success: false, error: err.message });
    }
    console.error('[compliance/emp-document]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate EMP document.' });
  }
});

// ── GET /snapshots ────────────────────────────────────────────────────────────
// List snapshots, newest first. Canonical list-page pattern (page / limit,
// default 50, max 200 — same as routes/activity.js).

router.get('/snapshots', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || '1'),  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const skip  = (page - 1) * limit;

    const where: any = { accountId: req.user.accountId };
    if (req.query.kind !== undefined) {
      const kind = String(req.query.kind);
      if (!SNAPSHOT_KINDS.includes(kind)) {
        return res.status(400).json({
          success: false,
          error: `kind must be one of ${SNAPSHOT_KINDS.join(', ')}`,
        });
      }
      where.kind = kind;
    }
    const [rows, total] = await Promise.all([
      prisma.complianceSnapshot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, createdAt: true, standardCode: true, siteId: true,
          kind: true, auditVisitId: true,
          filename: true, sizeBytes: true, sha256: true, stats: true,
          site:        { select: { name: true } },
          generatedBy: { select: { name: true } },
        },
      }),
      prisma.complianceSnapshot.count({ where }),
    ]);

    const snapshots = rows.map((s) => ({
      id:              s.id,
      createdAt:       s.createdAt,
      standardCode:    s.standardCode,       // null = all standards
      siteId:          s.siteId,             // null = all sites
      siteName:        s.site ? s.site.name : null,
      kind:            s.kind,               // 'compliance' | 'emp'
      auditVisitId:    s.auditVisitId,       // null unless generated for an audit visit
      filename:        s.filename,
      sizeBytes:       s.sizeBytes,
      sha256:          s.sha256,
      sha256Short:     s.sha256 ? s.sha256.slice(0, 12) : null,
      generatedByName: s.generatedBy ? s.generatedBy.name : null,
      stats:           s.stats,
    }));

    return res.json({
      success: true,
      data: {
        snapshots,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error('[compliance/snapshots:list]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list snapshots.' });
  }
});

// ── GET /snapshots/:id/download ───────────────────────────────────────────────
// Stream the stored PDF. Before a single byte goes out, the file's SHA-256
// is recomputed and compared against the row — a stored file that no longer
// hashes to its anchored value is NOT evidence and must not be served as
// such. Mismatch (or a missing file) returns 409 integrity_check_failed and
// writes a compliance_snapshot_integrity_failure audit entry.

router.get('/snapshots/:id/download', async (req, res) => {
  try {
    const snap = await prisma.complianceSnapshot.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!snap) return res.status(404).json({ success: false, error: 'Snapshot not found.' });

    let buf;
    try {
      buf = await downloadFile(snap.filePath, req.user.accountId);
    } catch (readErr) {
      // Evidence file gone from storage — same class of failure as a hash
      // mismatch from the auditor's point of view.
      writeActivityLog({
        assetId:   null,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'compliance_snapshot_integrity_failure',
        details: {
          snapshotId:     snap.id,
          reason:         'file_missing',
          expectedSha256: snap.sha256,
          error:          readErr.message,
        },
      });
      return res.status(409).json({ success: false, error: 'integrity_check_failed' });
    }

    const actualSha256 = sha256Hex(buf);
    if (actualSha256 !== snap.sha256) {
      writeActivityLog({
        assetId:   null,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'compliance_snapshot_integrity_failure',
        details: {
          snapshotId:     snap.id,
          reason:         'sha256_mismatch',
          expectedSha256: snap.sha256,
          actualSha256,
        },
      });
      return res.status(409).json({ success: false, error: 'integrity_check_failed' });
    }

    // RFC 6266 dual-form filename, forced download + nosniff — same serving
    // posture as routes/documents.js GET /file.
    const safeAscii = (snap.filename || 'snapshot.pdf').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const rfc5987   = encodeURIComponent(snap.filename || 'snapshot.pdf');
    res.set('Content-Type',           'application/pdf');
    res.set('Content-Disposition',    `attachment; filename="${safeAscii}"; filename*=UTF-8''${rfc5987}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Length',         String(buf.length));
    res.set('Cache-Control',          'private, no-store');
    return res.send(buf);
  } catch (err) {
    console.error('[compliance/snapshots:download]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to download snapshot.' });
  }
});

// (No DELETE /snapshots/:id — see the file header for why snapshots are
// immutable in v1.)

// ── EMP settings ──────────────────────────────────────────────────────────────
// AccountSetting-backed knobs the EMP document generator reads:
//   EMP_COORDINATOR_USER_ID — program owner (must be a same-account user)
//   RETENTION_POLICY_TEXT   — records-retention policy text (free-form)
//   EMP_LAST_REVIEWED_AT    — ISO date of the last formal program review
// Admin-only on both verbs: this is account-level policy, same tier as the
// rest of account settings.

const EMP_SETTING_KEYS = ['EMP_COORDINATOR_USER_ID', 'RETENTION_POLICY_TEXT', 'EMP_LAST_REVIEWED_AT'];

router.get('/emp-settings', requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.accountSetting.findMany({
      where: { accountId: req.user.accountId, key: { in: EMP_SETTING_KEYS } },
    });
    const db: any = {};
    for (const r of rows) db[r.key] = r.value;

    // Resolve the coordinator's name for display. A stale id (user deleted
    // or moved accounts) resolves to null rather than erroring.
    let coordinator = null;
    if (db.EMP_COORDINATOR_USER_ID) {
      coordinator = await prisma.user.findFirst({
        where:  { id: db.EMP_COORDINATOR_USER_ID, accountId: req.user.accountId },
        select: { id: true, name: true, email: true },
      });
    }

    return res.json({
      success: true,
      data: {
        empCoordinatorUserId: db.EMP_COORDINATOR_USER_ID || null,
        empCoordinator:       coordinator, // { id, name, email } | null
        retentionPolicyText:  db.RETENTION_POLICY_TEXT || null,
        empLastReviewedAt:    db.EMP_LAST_REVIEWED_AT || null,
      },
    });
  } catch (err) {
    console.error('[compliance/emp-settings:get]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load EMP settings.' });
  }
});

router.put('/emp-settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const updates = []; // [key, value|null] — null clears the setting

    if (body.empCoordinatorUserId !== undefined) {
      if (body.empCoordinatorUserId === null || body.empCoordinatorUserId === '') {
        updates.push(['EMP_COORDINATOR_USER_ID', null]);
      } else {
        const user = await prisma.user.findFirst({
          where:  { id: String(body.empCoordinatorUserId), accountId: req.user.accountId },
          select: { id: true },
        });
        if (!user) {
          return res.status(404).json({ success: false, error: 'Coordinator user not found in this account.' });
        }
        updates.push(['EMP_COORDINATOR_USER_ID', user.id]);
      }
    }

    if (body.retentionPolicyText !== undefined) {
      const text = body.retentionPolicyText === null ? '' : String(body.retentionPolicyText);
      if (text.length > 20000) {
        return res.status(400).json({ success: false, error: 'retentionPolicyText is too long (max 20000 chars).' });
      }
      updates.push(['RETENTION_POLICY_TEXT', text.trim() || null]);
    }

    if (body.empLastReviewedAt !== undefined) {
      if (body.empLastReviewedAt === null || body.empLastReviewedAt === '') {
        updates.push(['EMP_LAST_REVIEWED_AT', null]);
      } else {
        const d = new Date(String(body.empLastReviewedAt));
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, error: 'empLastReviewedAt must be a valid date.' });
        }
        updates.push(['EMP_LAST_REVIEWED_AT', d.toISOString()]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No EMP settings provided.' });
    }

    for (const [key, value] of updates) {
      if (value === null) {
        await prisma.accountSetting.deleteMany({
          where: { accountId: req.user.accountId, key },
        });
      } else {
        await prisma.accountSetting.upsert({
          where:  { accountId_key: { accountId: req.user.accountId, key } },
          update: { value },
          create: { accountId: req.user.accountId, key, value },
        });
      }
    }

    writeActivityLog({
      assetId:   null,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'emp_settings_updated',
      details:   { keys: updates.map(([k]) => k) },
    });

    return res.json({ success: true, data: { updated: updates.map(([k]) => k) } });
  } catch (err) {
    console.error('[compliance/emp-settings:put]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update EMP settings.' });
  }
});

module.exports = router;

export {};
