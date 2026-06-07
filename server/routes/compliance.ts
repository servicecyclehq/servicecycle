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
 *   POST   /snapshots                  — generate + persist a snapshot PDF (manager+)
 *   GET    /snapshots                  — list snapshots (paginated)
 *   GET    /snapshots/:id/download     — stream a snapshot PDF (integrity-checked)
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
const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { uploadFile, downloadFile, deleteFile } = require('../lib/storage');
const { buildStandardsSummary, buildStandardReport } = require('../lib/complianceReport');
const { renderSnapshotPdf } = require('../lib/compliancePdf');

const router = express.Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'all';
}

// yyyymmdd-hhmm in UTC, for the snapshot filename.
function utcStamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
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

// ── POST /snapshots ───────────────────────────────────────────────────────────
// Generate a snapshot PDF, persist it, and anchor its SHA-256 in the audit
// log. Body: { standardCode? (null = all standards), siteId? (null = all sites) }.
//
// Failure ordering matters here:
//   render → hash → store file → create snapshot row → audit anchor.
// If the snapshot row fails, the stored file is deleted. If the AUDIT
// ANCHOR fails, both the row and the file are deleted and the request
// fails — an unanchored snapshot is worse than no snapshot, because the
// whole product promise is "the hash is in the tamper-evident log".

router.post('/snapshots', requireManager, async (req, res) => {
  const { accountId, id: userId } = req.user;
  const body         = req.body || {};
  const standardCode = body.standardCode ? String(body.standardCode).trim() : null;
  const siteId       = body.siteId ? String(body.siteId) : null;

  let storageKey = null;
  let snapshotId = null;

  try {
    // Validate the site up front (also needed for the filename + scope text).
    let site = null;
    if (siteId) {
      site = await prisma.site.findFirst({
        where:  { id: siteId, accountId },
        select: { id: true, name: true },
      });
      if (!site) return res.status(404).json({ success: false, error: 'Site not found.' });
    }

    // 1. Assemble report bundle(s).
    let bundles;
    if (standardCode) {
      bundles = [await buildStandardReport(prisma, accountId, { standardCode, siteId })];
    } else {
      const summary = await buildStandardsSummary(prisma, accountId, { siteId });
      bundles = [];
      for (const entry of summary) {
        bundles.push(await buildStandardReport(prisma, accountId, {
          standardCode: entry.standard.code,
          siteId,
        }));
      }
    }
    if (bundles.length === 0) {
      return res.status(422).json({
        success: false,
        error: 'No compliance data in the selected scope — nothing to snapshot.',
      });
    }

    // 2. Aggregate stats across bundles (assets/deficiencies de-duplicated —
    //    one asset can carry schedules under several standards).
    const assetIds = new Set();
    const defIds   = new Set();
    let schedules = 0, current = 0, overdue = 0, unbaselined = 0;
    for (const b of bundles) {
      for (const r of b.rows) assetIds.add(r.asset.id);
      for (const d of b.openDeficiencies) defIds.add(d.id);
      schedules   += b.summary.scheduleCount;
      current     += b.summary.currentCount;
      overdue     += b.summary.overdueCount;
      unbaselined += b.summary.unbaselinedCount;
    }
    const stats = {
      standards:        bundles.length,
      assets:           assetIds.size,
      schedules,
      current,
      overdue,
      unbaselined,
      openDeficiencies: defIds.size,
    };

    // 3. Render. The snapshot id is pre-generated so it can be baked into
    //    the PDF footer + integrity note BEFORE the row exists.
    snapshotId = crypto.randomUUID();
    const generatedAt = new Date();
    const account = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { companyName: true },
    });

    const scopeDescription =
      `${standardCode || 'All standards'} — ${site ? site.name : 'all sites'}`;
    const pdfBuffer = await renderSnapshotPdf(bundles, {
      snapshotId,
      accountName:      account ? account.companyName : 'Account',
      generatedByName:  req.user.name || 'Unknown user',
      generatedAtIso:   generatedAt.toISOString(),
      scopeDescription,
      standardEditions: bundles.map((b) =>
        b.standard.edition ? `${b.standard.code} (${b.standard.edition})` : b.standard.code
      ),
    });

    // 4. Hash, then store via the Document.filePath storage conventions
    //    (storage key '{accountId}/misc/{ts}_{filename}').
    const sha256 = sha256Hex(pdfBuffer);
    const scopeSlug = [
      standardCode ? slugify(standardCode) : 'all-standards',
      site ? slugify(site.name) : null,
    ].filter(Boolean).join('-');
    const filename = `servicecycle-compliance-snapshot-${utcStamp(generatedAt)}-${scopeSlug}.pdf`;

    const uploaded = await uploadFile(accountId, null, filename, pdfBuffer, 'application/pdf');
    storageKey = uploaded.storageKey;

    // 5. Snapshot row. On failure, remove the now-orphaned file.
    let snapshot;
    try {
      snapshot = await prisma.complianceSnapshot.create({
        data: {
          id:            snapshotId,
          accountId,
          siteId:        site ? site.id : null,
          standardCode:  standardCode || null,
          generatedById: userId,
          filename,
          filePath:      storageKey,
          sizeBytes:     uploaded.sizeBytes,
          sha256,
          stats,
        },
      });
    } catch (rowErr) {
      try { await deleteFile(storageKey); } catch (_) { /* best-effort */ }
      throw rowErr;
    }

    // 6. THE INTEGRITY ANCHOR. This is a direct prisma.activityLog.create,
    //    NOT lib/activityLog.writeLog — writeLog is fire-and-forget and
    //    swallows its own errors by design, but here a silent failure would
    //    break the product promise (the snapshot's sha256 MUST land in the
    //    tamper-evident hash chain, which the activityLogChainSettler then
    //    seals). If the anchor write fails, the snapshot row and file are
    //    rolled back and the request fails.
    try {
      await prisma.activityLog.create({
        data: {
          assetId: null,
          userId,
          accountId,
          action: 'compliance_snapshot_generated',
          details: {
            snapshotId,
            sha256,
            standardCode: standardCode || null,
            siteId:       site ? site.id : null,
            stats,
          },
        },
      });
    } catch (anchorErr) {
      console.error('[compliance/snapshots] audit anchor failed — rolling back snapshot:',
        anchorErr.message);
      try { await prisma.complianceSnapshot.delete({ where: { id: snapshotId } }); } catch (_) { /* best-effort */ }
      try { await deleteFile(storageKey); } catch (_) { /* best-effort */ }
      return res.status(500).json({
        success: false,
        error: 'Snapshot could not be anchored in the audit log and was discarded. Please retry.',
      });
    }

    return res.status(201).json({
      success: true,
      data: {
        snapshot: {
          id:           snapshot.id,
          createdAt:    snapshot.createdAt,
          standardCode: snapshot.standardCode,
          siteId:       snapshot.siteId,
          siteName:     site ? site.name : null,
          filename:     snapshot.filename,
          sizeBytes:    snapshot.sizeBytes,
          sha256:       snapshot.sha256,
          stats:        snapshot.stats,
        },
      },
    });
  } catch (err) {
    if (handleBuilderError(res, err)) return;
    console.error('[compliance/snapshots]', err);
    return res.status(500).json({ success: false, error: 'Failed to generate compliance snapshot.' });
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

    const where = { accountId: req.user.accountId };
    const [rows, total] = await Promise.all([
      prisma.complianceSnapshot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, createdAt: true, standardCode: true, siteId: true,
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

module.exports = router;

export {};
