/**
 * /api/ingest/jobs — #2 async document ingest.
 *
 *   POST /            multipart upload -> store file + enqueue IngestJob -> 202 { jobId }
 *   GET  /:id         poll one job (status/progress/result)
 *   GET  /            recent jobs for the account
 *
 * The heavy parse runs in lib/ingestWorker (out of this request). The returned
 * job's `result`, once status='done', is the same shape as POST
 * /api/test-reports/import/preview, so the client reviews + commits identically.
 *
 * Mounted behind authenticateToken (+ ingestLimiter) in index.ts. Any
 * authenticated role may enqueue/preview (parity with the sync /preview);
 * committing the reviewed result stays manager+ on the existing commit route.
 */

'use strict';

const router = require('express').Router();
const multer = require('multer');
const prisma = require('../lib/prisma').default;
const { uploadFile } = require('../lib/storage');
const { resolveTargetAccount } = require('../lib/oemTargetAccount');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req: any, file: any, cb: any) =>
    ACCEPTED_RE.test(file.originalname || '') ? cb(null, true) : cb(new Error('Upload a .pdf or a photo (JPG/PNG/HEIC)')),
});

function shapeJob(j: any) {
  return {
    id: j.id,
    status: j.status,
    kind: j.kind,
    progress: j.progress,
    phase: j.phase,
    fileName: j.fileName,
    error: j.error,
    result: j.result ?? null,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  };
}

// ── POST /api/ingest/jobs ─────────────────────────────────────────────────────
router.post('/jobs', upload.single('file'), async (req: any, res: any) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // The job is owned by the caller's account; #14 lets an oem_admin target a
    // fleet customer account (validated here) which the worker builds against.
    let targetAccountId: string | null = null;
    try {
      const resolved = await resolveTargetAccount(req);
      if (resolved && resolved !== req.user.accountId) targetAccountId = resolved;
    } catch (e: any) {
      return res.status(e.httpStatus || 400).json({ success: false, error: e.message });
    }

    const storeAccountId = targetAccountId || req.user.accountId;
    const { storageKey } = await uploadFile(
      storeAccountId, null, req.file.originalname || 'upload.pdf', req.file.buffer, req.file.mimetype || 'application/pdf',
    );

    const job = await prisma.ingestJob.create({
      data: {
        accountId:       req.user.accountId,
        createdById:     req.user.id,
        kind:            'test_report',
        status:          'queued',
        fileKey:         storageKey,
        fileName:        req.file.originalname || null,
        targetAccountId: targetAccountId,
      },
    });

    writeActivityLog({
      accountId: req.user.accountId, userId: req.user.id, action: 'ingest_job_enqueued',
      details: {
        jobId: job.id,
        kind: job.kind,
        fileName: req.file.originalname || null,
        targetAccountId,
      },
    });

    return res.status(202).json({ success: true, data: { jobId: job.id, status: job.status } });
  } catch (err: any) {
    console.error('[ingest/jobs:create]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to enqueue ingest job' });
  }
});

// ── GET /api/ingest/jobs/:id ──────────────────────────────────────────────────
router.get('/jobs/:id', async (req: any, res: any) => {
  try {
    const job = await prisma.ingestJob.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!job) return res.status(404).json({ success: false, error: 'Ingest job not found' });
    return res.json({ success: true, data: shapeJob(job) });
  } catch (err: any) {
    console.error('[ingest/jobs:get]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to fetch ingest job' });
  }
});

// ── GET /api/ingest/jobs ──────────────────────────────────────────────────────
router.get('/jobs', async (req: any, res: any) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25));
    const jobs = await prisma.ingestJob.findMany({
      where: { accountId: req.user.accountId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      // omit result in the list view (can be large) — fetch per-job for the full payload
      select: { id: true, status: true, kind: true, progress: true, phase: true, fileName: true, error: true, createdAt: true, finishedAt: true },
    });
    return res.json({ success: true, data: { jobs } });
  } catch (err: any) {
    console.error('[ingest/jobs:list]', err && err.message ? err.message : err);
    return res.status(500).json({ success: false, error: 'Failed to list ingest jobs' });
  }
});

module.exports = router;

export {};
