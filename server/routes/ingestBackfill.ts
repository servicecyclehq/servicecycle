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
const { assertZipInflatesWithinBudget } = require('../lib/zipInflateGuard');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const MAX_ZIP_BYTES  = 100 * 1024 * 1024; // 100 MB archive (compressed)
const MAX_FILES      = 200;               // jobs per batch
const MAX_FILE_BYTES = 15 * 1024 * 1024;  // per report (uncompressed)
// PROCESSING budget (loop, below): stop materializing report files once this
// much has been inflated in the accepted set; remaining entries are skipped (the
// batch still succeeds). This is a throughput/skip budget, NOT the memory guard.
const MAX_TOTAL_UNCOMPRESSED = 400 * 1024 * 1024;
// Hard SAFETY ceilings for the pre-inflation bomb guard (assertZipInflatesWithin
// budget), deliberately distinct from the processing budget above. A legit
// report batch is a <=100MB archive of PDFs/images (already-compressed, so it
// inflates to only a few hundred MB); a decompression bomb inflates a tiny
// archive to many GB. These ceilings sit in the wide gap between the two:
//  - per entry: bounds each entry's REAL inflation, so the loop's uncapped
//    JSZip .async() (which trusts no size) can never be handed a single entry
//    that inflates to GB. 128MB is ~8.5x the 15MB per-file cap — any honestly
//    oversized report is well under it (and is skipped in the loop regardless);
//  - per archive: aborts a distributed bomb (many medium entries) and bounds the
//    guard's own CPU. 1GB is several times any realistic legit batch, far below
//    bomb scale. Exceeding either -> the archive is rejected (fails closed).
const MAX_GUARD_ENTRY_BYTES = 128 * 1024 * 1024;  // 128 MB real inflation / entry
const MAX_GUARD_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB real inflation / archive
// #docx (2026-07-13): a backfill zip can carry Word .docx reports too — the
// worker runs them through buildTestReportPreview (mammoth text -> parse), same
// as a PDF. Legacy .doc is excluded (no lightweight extractor; skipped as a
// non-report entry rather than silently mis-parsed).
const REPORT_RE = /\.(pdf|docx|jpe?g|png|heic|heif|webp)$/i;
const MIME: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

    // Decompression-bomb guard (REAL inflation, runs before JSZip touches the
    // archive): inflate every entry's actual DEFLATE stream and count true output
    // bytes, aborting the moment any entry's real inflation exceeds the per-entry
    // ceiling or the archive's real total exceeds the per-archive ceiling. This
    // never trusts the central-directory declared sizes (which an attacker
    // controls) and fails CLOSED on anything it cannot verify, so a zip bomb can
    // never reach JSZip's uncapped .async() inflation below. See lib/zipInflateGuard.
    const zipBudget = assertZipInflatesWithinBudget(req.file.buffer, {
      maxTotalBytes: MAX_GUARD_TOTAL_BYTES,
      maxEntryBytes: MAX_GUARD_ENTRY_BYTES,
    });
    if (!zipBudget.ok) {
      return res.status(400).json({ success: false, error: 'Archive rejected: it decompresses beyond the allowed size or could not be verified.' });
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
    let totalUncompressed = 0;

    for (const entry of take) {
      // Per-file fast-skip (optimization, NOT the security boundary): skip an
      // entry whose DECLARED uncompressed size already exceeds the per-file cap,
      // to avoid materializing an obviously-too-big file. The real memory bound
      // is the assertZipInflatesWithinBudget pre-pass above, which has already
      // verified the archive's ACTUAL total inflation — a lying (small) declared
      // size here just falls through to the real buf.length check below.
      const declared = (entry as any)?._data?.uncompressedSize;
      if (typeof declared === 'number' && declared > MAX_FILE_BYTES) {
        skipped.push({ name: (entry as any).name, reason: 'too large (declared)' });
        continue;
      }
      // Decompression-bomb guard #2: stop once the batch's total inflated bytes
      // would exceed the budget, so a lying header can't run memory away either.
      if (totalUncompressed >= MAX_TOTAL_UNCOMPRESSED) {
        skipped.push({ name: (entry as any).name, reason: 'batch decompression budget exceeded' });
        continue;
      }
      const buf: Buffer = await (entry as any).async('nodebuffer');
      if (!buf.length) { skipped.push({ name: (entry as any).name, reason: 'empty' }); continue; }
      if (buf.length > MAX_FILE_BYTES) { skipped.push({ name: (entry as any).name, reason: 'too large' }); continue; }
      totalUncompressed += buf.length;
      const base = (entry as any).name.split('/').pop() || 'report.pdf';
      const { storageKey } = await uploadFile(storeAccountId, null, base, buf, mimeFor(base));
      // Job ownership split (intentional, mirrors #14 + the email-in worker):
      // accountId is the OPERATOR's account (req.user) so the uploader sees the
      // job in their own queue/status; the file + targetAccountId point at the
      // fleet CUSTOMER's account where the worker actually commits the assets.
      // The /backfill/status route scopes by accountId = the operator, so this
      // is consistent — do not "fix" it to storeAccountId.
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

    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'backfill_batch_enqueued',
      details: {
        batchSize: jobIds.length,
        truncated,
        skippedCount: skipped,
        skippedNonReportCount: nonReport.length,
        siteId,
        targetAccountId,
      },
    });

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