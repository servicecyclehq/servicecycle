/**
 * routes/ingestReview.ts — the review queue for confidence-gated ingest.
 *
 * Email-in / backfill reports that the confidence gate parked (status
 * needs_review) wait here for a human to approve (commit the asset cards) or
 * reject (discard, nothing written). Approval reuses the SAME commit path the
 * in-app flow and the auto-commit worker use, so an approved report is identical
 * program-of-record data to one that was uploaded by hand — just deferred.
 *
 * Every approve/reject writes a hash-chained activity-log entry (who + when +
 * what), so there is provable evidence a person OK'd it and it was not
 * auto-accepted. manager+ (committing assets is a manager action).
 *
 *   GET  /review                 list this account's pending-review items
 *   GET  /review/count           just the badge count (cheap)
 *   POST /review/:jobId/approve  commit the parked report (optional edited preview/siteId)
 *   POST /review/:jobId/reject   discard it (no assets written)
 *   POST /review/bulk-approve    { jobIds[] } approve many; per-job activity log
 */

'use strict';

const router = require('express').Router();
const prisma = require('../lib/prisma').default;
const { requireManager, requireAdmin } = require('../middleware/roles');
const { clampThreshold, DEFAULT_THRESHOLD } = require('../lib/ingestConfidenceGate');

const SINCE_DAYS = 30;

// Compact per-job shape for the queue UI: the gate decision + a thin preview
// summary (asset units, what each would do, reading/deficiency counts).
function shapeJob(job: any) {
  const result = job.result || {};
  const gate = job.gate || {};
  const units = Array.isArray(gate.units) ? gate.units : [];
  const meta = result.meta || {};
  return {
    id: job.id,
    kind: job.kind,
    fileName: job.fileName,
    createdAt: job.createdAt,
    band: gate.band || 'yellow',
    reasons: gate.reasons || [],
    units,
    meta: { serialNumber: meta.serialNumber || null, manufacturer: meta.manufacturer || null, model: meta.model || null, testDate: meta.testDate || null },
    measurementCount: Array.isArray(result.measurements) ? result.measurements.length : 0,
    deficienciesToCreate: result.summary?.deficienciesToCreate ?? null,
    assetSections: result.assetSections ?? 1,
  };
}

async function _firstSiteId(accountId: string): Promise<string | null> {
  const s = await prisma.site.findFirst({ where: { accountId, archivedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  return s ? s.id : null;
}

// Shared approve worker — commit one parked job. Returns the committed summary.
// Throws on a not-found / not-pending job or a commit failure.
async function approveOne(job: any, userId: string, opts: { siteId?: string | null; preview?: any } = {}) {
  const { commitPreviewSections } = require('../lib/commitTestReport');
  const commitAccountId = job.targetAccountId || job.accountId;
  const siteId = opts.siteId || job.siteId || await _firstSiteId(commitAccountId);
  if (!siteId) throw Object.assign(new Error('No site available to place these assets — create a site first.'), { httpStatus: 400 });

  const preview = (opts.preview && typeof opts.preview === 'object') ? opts.preview : job.result;
  const edited = !!(opts.preview && typeof opts.preview === 'object');

  const committed = await commitPreviewSections({ accountId: commitAccountId, siteId, preview, originalName: job.fileName || undefined });

  const newResult = { ...(job.result || {}), ...(edited ? preview : {}), autoCommitted: committed };
  await prisma.ingestJob.update({
    where: { id: job.id },
    data: { status: 'done', reviewedById: userId, reviewedAt: new Date(), result: newResult, phase: 'approved', error: null },
  });

  await prisma.activityLog.create({
    data: {
      accountId: job.accountId, userId, action: 'ingest_review_approved',
      details: { jobId: job.id, kind: job.kind, fileName: job.fileName, assetsCommitted: committed.assetsCommitted, deficienciesCreated: committed.deficienciesCreated, edited },
    },
  }).catch(() => {});

  return committed;
}

// -- GET /review --------------------------------------------------------------
router.get('/review', requireManager, async (req: any, res: any) => {
  try {
    const jobs = await prisma.ingestJob.findMany({
      where: { accountId: req.user.accountId, status: 'needs_review' },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return res.json({ success: true, data: { items: jobs.map(shapeJob), count: jobs.length } });
  } catch (err: any) {
    console.error('[ingest/review:list]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to load the review queue' });
  }
});

// -- GET /review/count (badge) ------------------------------------------------
router.get('/review/count', requireManager, async (req: any, res: any) => {
  try {
    const count = await prisma.ingestJob.count({ where: { accountId: req.user.accountId, status: 'needs_review' } });
    return res.json({ success: true, data: { count } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Failed to count review items' });
  }
});

// -- POST /review/:jobId/approve ----------------------------------------------
router.post('/review/:jobId/approve', requireManager, async (req: any, res: any) => {
  try {
    const job = await prisma.ingestJob.findFirst({ where: { id: req.params.jobId, accountId: req.user.accountId, status: 'needs_review' } });
    if (!job) return res.status(404).json({ success: false, error: 'No pending review item with that id' });
    const committed = await approveOne(job, req.user.id, { siteId: req.body?.siteId ? String(req.body.siteId) : null, preview: req.body?.preview });
    return res.json({ success: true, data: { committed } });
  } catch (err: any) {
    const status = err && err.httpStatus ? err.httpStatus : 500;
    if (status === 500) console.error('[ingest/review:approve]', err && err.message ? err.message : err);
    return res.status(status).json({ success: false, error: err?.message || 'Failed to approve' });
  }
});

// -- POST /review/:jobId/reject -----------------------------------------------
router.post('/review/:jobId/reject', requireManager, async (req: any, res: any) => {
  try {
    const job = await prisma.ingestJob.findFirst({ where: { id: req.params.jobId, accountId: req.user.accountId, status: 'needs_review' }, select: { id: true, kind: true, fileName: true } });
    if (!job) return res.status(404).json({ success: false, error: 'No pending review item with that id' });
    await prisma.ingestJob.update({ where: { id: job.id }, data: { status: 'rejected', reviewedById: req.user.id, reviewedAt: new Date(), phase: 'rejected' } });
    await prisma.activityLog.create({
      data: { accountId: req.user.accountId, userId: req.user.id, action: 'ingest_review_rejected', details: { jobId: job.id, kind: job.kind, fileName: job.fileName, note: req.body?.note ? String(req.body.note).slice(0, 300) : null } },
    }).catch(() => {});
    return res.json({ success: true, data: { id: job.id, status: 'rejected' } });
  } catch (err: any) {
    console.error('[ingest/review:reject]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to reject' });
  }
});

// -- POST /review/bulk-approve ------------------------------------------------
router.post('/review/bulk-approve', requireManager, async (req: any, res: any) => {
  try {
    const ids = Array.isArray(req.body?.jobIds) ? req.body.jobIds.filter((x: any) => typeof x === 'string').slice(0, 200) : [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Provide jobIds[] to approve' });

    const jobs = await prisma.ingestJob.findMany({ where: { id: { in: ids }, accountId: req.user.accountId, status: 'needs_review' } });
    const approved: string[] = [];
    const failed: { id: string; error: string }[] = [];
    let assetsCommitted = 0;
    // Sequential — each approve is its own transaction; one bad report doesn't
    // abort the rest, and every approval logs its own activity entry for proof.
    for (const job of jobs) {
      try {
        const committed = await approveOne(job, req.user.id);
        assetsCommitted += committed.assetsCommitted || 0;
        approved.push(job.id);
      } catch (e: any) {
        failed.push({ id: job.id, error: e?.message || 'approve failed' });
      }
    }
    return res.json({ success: true, data: { approved: approved.length, assetsCommitted, failed, requested: ids.length, found: jobs.length } });
  } catch (err: any) {
    console.error('[ingest/review:bulk-approve]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to bulk-approve' });
  }
});

// -- GET /review/settings (threshold knob + correction-rate readout) ----------
// The auto-add confidence floor + a 30-day outcome readout so the line can be
// set with data rather than guessed. Manager+ may read; only admins may change.
router.get('/review/settings', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const setting = await prisma.accountSetting.findFirst({ where: { accountId, key: 'ingest_autocommit_threshold' }, select: { value: true } });
    const threshold = clampThreshold(setting?.value);
    const since = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

    const autoAdded = await prisma.ingestJob.count({ where: { accountId, kind: { in: ['email_in', 'backfill'] }, status: 'done', reviewedById: null, createdAt: { gte: since } } });
    const awaiting = await prisma.ingestJob.count({ where: { accountId, status: 'needs_review' } });
    const approved = await prisma.ingestJob.count({ where: { accountId, status: 'done', reviewedById: { not: null }, reviewedAt: { gte: since } } });
    const rejected = await prisma.ingestJob.count({ where: { accountId, status: 'rejected', reviewedAt: { gte: since } } });
    // Correction proxy: approvals where the reviewer edited the parsed data.
    const edited = await prisma.activityLog.count({ where: { accountId, action: 'ingest_review_approved', createdAt: { gte: since }, details: { path: ['edited'], equals: true } } }).catch(() => 0);

    return res.json({
      success: true,
      data: {
        threshold, default: DEFAULT_THRESHOLD, canEdit: req.user.role === 'admin',
        stats: { sinceDays: SINCE_DAYS, autoAdded, awaiting, approved, rejected, editedOnApprove: edited, correctionRate: approved > 0 ? edited / approved : null },
      },
    });
  } catch (err: any) {
    console.error('[ingest/review:settings:get]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to load review settings' });
  }
});

// -- PUT /review/settings (admin sets the threshold) --------------------------
router.put('/review/settings', requireAdmin, async (req: any, res: any) => {
  try {
    const raw = req.body?.threshold;
    if (raw == null || isNaN(Number(raw))) return res.status(400).json({ success: false, error: 'threshold must be a number 0..1' });
    const threshold = clampThreshold(raw);
    const accountId = req.user.accountId;
    const existing = await prisma.accountSetting.findFirst({ where: { accountId, key: 'ingest_autocommit_threshold' }, select: { id: true } });
    if (existing) await prisma.accountSetting.update({ where: { id: existing.id }, data: { value: String(threshold) } });
    else await prisma.accountSetting.create({ data: { accountId, key: 'ingest_autocommit_threshold', value: String(threshold) } });
    await prisma.activityLog.create({ data: { accountId, userId: req.user.id, action: 'ingest_autocommit_threshold_changed', details: { threshold } } }).catch(() => {});
    return res.json({ success: true, data: { threshold } });
  } catch (err: any) {
    console.error('[ingest/review:settings:put]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to save the threshold' });
  }
});

module.exports = router;
module.exports.approveOne = approveOne;

export {};
