'use strict';

/**
 * lib/snapshotPipeline.js
 * -----------------------
 * THE shared snapshot persistence pipeline. Extracted from
 * routes/compliance.ts POST /snapshots so the audit-visit convenience
 * endpoint (POST /api/audits/:id/snapshots) and the EMP document generator
 * (POST /api/compliance/emp-document) reuse the exact same
 * render → sha256 → store → row create → audit anchor sequence instead of
 * duplicating the anchor logic.
 *
 * Two layers:
 *
 *   persistSnapshot(prisma, opts) — the storage + integrity half. Takes an
 *     already-rendered PDF Buffer and runs:
 *       hash → store file → create ComplianceSnapshot row → DIRECT
 *       prisma.activityLog.create anchor (action
 *       'compliance_snapshot_generated').
 *     Failure ordering is the product promise and must not change:
 *       - row create fails  → stored file deleted, error re-thrown
 *       - anchor fails      → row AND file deleted, coded error
 *         (err.code = 'ANCHOR_FAILED') thrown — an unanchored snapshot is
 *         worse than no snapshot.
 *     The anchor is a direct prisma.activityLog.create, NOT
 *     lib/activityLog.writeLog — writeLog swallows its own errors by design,
 *     but here a silent failure breaks the tamper-evidence promise.
 *
 *   generateSnapshot(prisma, opts) — the compliance-report generation half.
 *     Assembles the per-standard report bundle(s), renders the snapshot PDF
 *     (lib/compliancePdf) and hands the bytes to persistSnapshot. Coded
 *     errors for the routes to map:
 *       SITE_NOT_FOUND / STANDARD_NOT_FOUND → 404
 *       NO_DATA                             → 422
 *       ANCHOR_FAILED                       → 500 (snapshot discarded)
 *
 * Every query is scoped by accountId — hard tenant boundary, same as
 * lib/complianceReport.
 */

const crypto = require('crypto');
const { uploadFile, deleteFile } = require('./storage');
const { buildStandardsSummary, buildStandardReport } = require('./complianceReport');
const { renderSnapshotPdf } = require('./compliancePdf');

// ── small helpers (moved verbatim from routes/compliance.ts) ──────────────────

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'all';
}

// yyyymmdd-hhmm in UTC, for snapshot filenames.
function utcStamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
         `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// ── persistSnapshot ───────────────────────────────────────────────────────────

/**
 * Persist a rendered snapshot PDF: hash → store → row → audit anchor.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {string}      opts.accountId
 * @param {string}      opts.userId        — actor (generatedById + anchor userId)
 * @param {string}      opts.snapshotId    — pre-generated id already baked into the PDF footer
 * @param {Buffer}      opts.pdfBuffer
 * @param {string}      opts.filename
 * @param {string|null} [opts.standardCode]
 * @param {string|null} [opts.siteId]
 * @param {string}      [opts.kind]         — 'compliance' | 'emp'
 * @param {string|null} [opts.auditVisitId] — links the evidence to an audit visit
 * @param {object|null} [opts.stats]
 * @returns {Promise<{ snapshot, sha256 }>}
 * @throws coded err.code='ANCHOR_FAILED' when the audit anchor cannot be written
 */
async function persistSnapshot(prisma, {
  accountId,
  userId,
  snapshotId,
  pdfBuffer,
  filename,
  standardCode = null,
  siteId = null,
  kind = 'compliance',
  auditVisitId = null,
  stats = null,
}) {
  const sha256 = sha256Hex(pdfBuffer);

  // Store via the Document.filePath storage conventions
  // (storage key '{accountId}/misc/{ts}_{filename}').
  const uploaded = await uploadFile(accountId, null, filename, pdfBuffer, 'application/pdf');
  const storageKey = uploaded.storageKey;

  // Snapshot row. On failure, remove the now-orphaned file.
  let snapshot;
  try {
    snapshot = await prisma.complianceSnapshot.create({
      data: {
        id:            snapshotId,
        accountId,
        siteId:        siteId || null,
        standardCode:  standardCode || null,
        kind,
        auditVisitId:  auditVisitId || null,
        generatedById: userId,
        filename,
        filePath:      storageKey,
        sizeBytes:     uploaded.sizeBytes,
        sha256,
        stats:         stats ?? undefined,
      },
    });
  } catch (rowErr) {
    try { await deleteFile(storageKey); } catch (_) { /* best-effort */ }
    throw rowErr;
  }

  // THE INTEGRITY ANCHOR. Direct prisma.activityLog.create, NOT
  // lib/activityLog.writeLog — see file header. If the anchor write fails,
  // the snapshot row and file are rolled back and a coded error is thrown.
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
          kind,
          standardCode: standardCode || null,
          siteId:       siteId || null,
          auditVisitId: auditVisitId || null,
          stats,
        },
      },
    });
  } catch (anchorErr) {
    console.error('[snapshotPipeline] audit anchor failed — rolling back snapshot:',
      anchorErr.message);
    try { await prisma.complianceSnapshot.delete({ where: { id: snapshotId } }); } catch (_) { /* best-effort */ }
    try { await deleteFile(storageKey); } catch (_) { /* best-effort */ }
    const err: any = new Error(
      'Snapshot could not be anchored in the audit log and was discarded. Please retry.'
    );
    err.code = 'ANCHOR_FAILED';
    throw err;
  }

  return { snapshot, sha256 };
}

// ── generateSnapshot ──────────────────────────────────────────────────────────

/**
 * Generate a per-standard compliance snapshot end to end: assemble report
 * bundles, render the PDF, persist + anchor via persistSnapshot.
 *
 * @param {object} prisma
 * @param {object} opts
 * @param {string}      opts.accountId
 * @param {string}      opts.userId
 * @param {string|null} [opts.userName]     — actor name for the PDF cover
 * @param {string|null} [opts.standardCode] — null = all standards
 * @param {string|null} [opts.siteId]       — null = all sites
 * @param {string}      [opts.kind]         — 'compliance' (default)
 * @param {string|null} [opts.auditVisitId] — set when generated for an audit visit
 * @returns {Promise<{ snapshot, site, stats }>}
 * @throws coded errors: SITE_NOT_FOUND | STANDARD_NOT_FOUND | NO_DATA | ANCHOR_FAILED
 */
async function generateSnapshot(prisma, {
  accountId,
  userId,
  userName = null,
  standardCode = null,
  siteId = null,
  kind = 'compliance',
  auditVisitId = null,
}) {
  // Validate the site up front (also needed for the filename + scope text).
  let site = null;
  if (siteId) {
    site = await prisma.site.findFirst({
      where:  { id: siteId, accountId },
      select: { id: true, name: true },
    });
    if (!site) {
      const err: any = new Error('Site not found.');
      err.code = 'SITE_NOT_FOUND';
      throw err;
    }
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
    const err: any = new Error(
      'No compliance data in the selected scope — nothing to snapshot.'
    );
    err.code = 'NO_DATA';
    throw err;
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

  // 3. Render. The snapshot id is pre-generated so it can be baked into the
  //    PDF footer + integrity note BEFORE the row exists.
  const snapshotId  = crypto.randomUUID();
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
    generatedByName:  userName || 'Unknown user',
    generatedAtIso:   generatedAt.toISOString(),
    scopeDescription,
    standardEditions: bundles.map((b) =>
      b.standard.edition ? `${b.standard.code} (${b.standard.edition})` : b.standard.code
    ),
  });

  // 4. Filename, then persist + anchor through the shared half.
  const scopeSlug = [
    standardCode ? slugify(standardCode) : 'all-standards',
    site ? slugify(site.name) : null,
  ].filter(Boolean).join('-');
  const filename = `servicecycle-compliance-snapshot-${utcStamp(generatedAt)}-${scopeSlug}.pdf`;

  const { snapshot } = await persistSnapshot(prisma, {
    accountId,
    userId,
    snapshotId,
    pdfBuffer,
    filename,
    standardCode,
    siteId: site ? site.id : null,
    kind,
    auditVisitId,
    stats,
  });

  return { snapshot, site, stats };
}

module.exports = {
  persistSnapshot,
  generateSnapshot,
  sha256Hex,
  slugify,
  utcStamp,
};

export {};
