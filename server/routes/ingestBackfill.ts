/**
 * /api/ingest/backfill -- #34 bulk historical backfill.
 *
 *   POST /backfill          multipart .zip of report PDFs/photos -> enqueue one
 *                           auto-commit IngestJob per report file -> 202
 *                           { batchSize, jobIds, truncated, skipped, skippedNonReport }
 *   POST /backfill/status   { jobIds[] } -> aggregate batch progress + cards made
 *
 * Reuses the #2 IngestJob queue + worker auto-commit path VERBATIM; this only
 * fans a zip out into N queued jobs (kind=backfill, autoCommit=true, on the
 * chosen site). manager+ because it commits asset cards without per-file review.
 * #14: an oem_admin may target a fleet customer account.
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const JSZip = require('jszip');
const prisma = require('../lib/prisma').default;
const { uploadFile } = require('../lib/storage');
const { requireManager } = require('../middleware/roles');
const { resolveTargetAccount } = require('../lib/oemTargetAccount');

const MAX_ZIP_BYTES  = 100 * 1024 * 1024; // 100 MB archive
const MAX_FILES      = 200;               // jobs per batch
const MAX_FILE_BYTES = 15 * 1024 * 1024;  // per report
const REPORT_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
};
const mimeFor = (name: string) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_ZIP_BYTES, files: 1 },
  fileFilter: (req: any, file: any, cb: any) =>
    /\.zip$/i.test(file.originalname || '') ? cb(null, true) : cb(new Error('Upload a .zip of report PDFs/photos')),
});

// Skip macOS resource forks, dotfiles, and directory entries.
function isRealEntry(name: string): boolean {
  if (name.startsWith('__MACOSX')) return false;
  const base = name.split('/').pop() || '';
  return base.length > 0 && !base.startsWith('.');
}

// -- POST /api/ingest/backfill -------------------------------------------------
router.post('/backfill', requireManager, upload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No .zip uploaded' });

    // #14: oem_admin may operate on a fleet customer account (validated here).
    let targetAccountId: string | null = null;
    try {
      const resolved = await resolveTargetAccount(req);
      if (resolved && resolved !== req.user.accountId) targetAccountId = resolved;
    } catch (e: any) {
      return res.status(e.httpStatus || 400).json({ success: false, error: e.message });
    }
    const storeAccountId = targetAccountId || req.user.accountId;

    // Optional explicit site for every report in the batch (else the worker
    // falls back to the account first site, same as email-in).
    const siteId = (req.body.siteId ? String(req.body.siteId) : '').trim() || null;
    if (siteId) {
      const site = await prisma.site.findFirst({ where: { id: siteId, accountId: storeAccountId }, select: { id: true } });
      if (!site) return res.status(400).json({ success: false, error: 'siteId not found in this account' });
    }

    let zip: any;
    try { zip = await JSZip.loadAsync(req.file.buffer); }
    catch { return res.status(400).json({ success: false, error: 'Could not read the .zip archive' }); }

    const entries = Object.values(zip.files).filter((f: any) => !f.dir && isRealEntry(f.name));
    const reportEntries = entries.filter((f: any) => REPORT_RE.test(f.name));
    const nonReport = entries.filter((f: any) => !REPORT_RE.test(f.name)).map((f: any) => f.name);

    const take = reportEntries.slice(0, MAX_FILES);
    const truncated = reportEntries.length > MAX_FILES;
    const jobIds: string[] = [];
    const skipped: { name: string; reason: string }[] = [];

    for (const entry of take) {
      const buf: Buffer = await (entry as any).async('nodebuffer');
      if (!buf.length) { skipped.push({ name: (entry as any).name, reason: 'empty' }); continue; }
      if (buf.length > MAX_FILE_BYTES) { skipped.push({ name: (entry as any).name, reason: 'too large' }); continue; }
      const base = (entry as any).name.split('/').pop() || 'report.pdf';
      const { storageKey } = await uploadFile(storeAccountId, null, base, buf, mimeFor(base));
      const job = await prisma.ingestJob.create({
        data: {
          accountId: req.user.accountId, createdById: req.user.id,
          kind: 'backfill', status: 'queued',
          fileKey: storageKey, fileName: base,
          autoCommit: true, siteId, targetAccountId,
        },
      });
      jobIds.push(job.id);
    }

    return res.status(202).json({
      success: true,
      data: { batchSize: jobIds.length, jobIds, truncated, skipped, skippedNonReport: nonReport.slice(0, 50) },
    });
  } catch (err: any) {
    console.error('[ingest/backfill:create]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to enqueue backfill' });
  }
});

// -- POST /api/ingest/backfill/status ------------------------------------------
router.post('/backfill/status', requireManager, async (req: any, res: any) => {
  try {
    const ids = Array.isArray(req.body && req.body.jobIds)
      ? req.body.jobIds.filter((x: any) => typeof x === 'string').slice(0, 500)
      : [];
    if (!ids.length) return res.json({ success: true, data: { total: 0, found: 0, counts: {}, assetsCommitted: 0, complete: false, jobs: [] } });

    const jobs = await prisma.ingestJob.findMany({
      where: { id: { in: ids }, accountId: req.user.accountId },
      select: { id: true, status: true, fileName: true, error: true, result: true },
    });

    const counts: Record<string, number> = { queued: 0, processing: 0, done: 0, failed: 0 };
    let assetsCommitted = 0;
    const shaped = jobs.map((j: any) => {
      counts[j.status] = (counts[j.status] || 0) + 1;
      const ac = j.result && j.result.autoCommitted;
      const made = ac && typeof ac.assetsCommitted === 'number' ? ac.assetsCommitted : 0;
      assetsCommitted += made;
      const acErr = j.result && j.result.autoCommitError;
      return { id: j.id, status: j.status, fileName: j.fileName, assetsCommitted: made, error: j.error || acErr || null };
    });

    const finished = (counts.done || 0) + (counts.failed || 0);
    return res.json({
      success: true,
      data: { total: ids.length, found: jobs.length, counts, assetsCommitted, complete: jobs.length > 0 && finished >= jobs.length, jobs: shaped },
    });
  } catch (err: any) {
    console.error('[ingest/backfill:status]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to fetch backfill status' });
  }
});

module.exports = router;

export {};