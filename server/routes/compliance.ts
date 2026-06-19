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
const { generateSnapshot, persistSnapshot, utcStamp } = require('../lib/snapshotPipeline');
const { buildEmpData, renderEmpPdf } = require('../lib/empDocument');
const { getAccountBranding } = require('../lib/partnerBranding');
const { buildCustomerDigest } = require('../lib/customerDigest');
const { buildCfoReportData, renderCfoReportPdf } = require('../lib/cfoReport');

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

// ── GET /summary?siteId= ──────────────────────────────────────────────────────
// Per-standard compliance summary for the account (optionally one site).

router.get('/summary', async (req, res) => {
  try {
    const siteId = req.query.siteId ? String(req.query.siteId) : null;
    const standards = await buildStandardsSummary(prisma, req.user.accountId, { siteId });
    return res.json({ success: true, data: { standards } });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/summary]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build compliance summary.' });
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
    return res.json({ success: true, data: { report } });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/overdue-report]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to build overdue report.' });
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
router.get('/maintenance-debt', async (req, res) => {
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
router.get('/maintenance-debt.csv', async (req, res) => {
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
router.get('/cfo-report.pdf', async (req, res) => {
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
      buf = await downloadFile(snap.filePath);
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
